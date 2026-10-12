/**
 * support.apple.com consumer Knowledge Base adapter.
 *
 * KB articles (often the authoritative source for device/feature eligibility
 * lists) are server-rendered HTML with no JSON API. Articles live at
 * `/{locale}/{id}`; legacy `HT`-numbers 301-redirect to a modern numeric id.
 *
 * A key hazard: a malformed id returns HTTP 200 with a "Page Not Found" page
 * (soft-404), so the status code alone is NOT trustworthy — we validate the
 * parsed content instead.
 */

import { load } from "cheerio";
import { SUPPORT_KB_BASE, SUPPORT_KB_DEFAULT_LOCALE, SUPPORT_KB_HOST } from "../constants.js";
import { fetchHtmlFollow } from "./safe-fetch.js";
import { normalizeInline, renderBlockText } from "./html-render.js";

export interface SupportArticle {
  id: string;
  locale: string;
  url: string;
  title: string;
  summary: string;
  body: string;
}

const ID_RE = /^(HT\d{4,7}|\d{6,9})$/i;
const LOCALE_RE = /^[a-z]{2}-[a-z]{2}$/;

export function validateSupportId(input: string): string {
  const id = String(input).trim();
  if (!ID_RE.test(id)) {
    throw new Error(
      `Invalid support article id "${input}": expected a numeric id (e.g. "108351") or a legacy HT id (e.g. "HT201260").`
    );
  }
  // Legacy HT ids keep their case-insensitive "HT" prefix; numeric ids pass through.
  return /^ht/i.test(id) ? `HT${id.slice(2)}` : id;
}

export function validateLocale(input: string | undefined): string {
  if (!input) return SUPPORT_KB_DEFAULT_LOCALE;
  const locale = input.trim().toLowerCase();
  if (!LOCALE_RE.test(locale)) {
    throw new Error(`Invalid locale "${input}": expected a form like "en-us" or "de-de".`);
  }
  return locale;
}

/**
 * Parse a support article. Returns null for a soft-404 ("Page Not Found" page
 * served with HTTP 200) so the caller can report a clean not-found.
 */
export function parseSupportArticle(html: string, id: string, locale: string, url: string): SupportArticle | null {
  const $ = load(html);

  // Soft-404 discriminators: canonical points at /404, or the title says so, or
  // the article container is absent.
  const canonical = $('link[rel="canonical"]').attr("href") ?? "";
  const docTitle = $("title").first().text().trim();
  const sections = $("#sections");
  const header = sections.find("h1.gb-header").first();
  if (
    canonical.replace(/\/$/, "") === `${SUPPORT_KB_BASE}/404` ||
    /^page not found/i.test(docTitle) ||
    header.length === 0
  ) {
    return null;
  }

  const title = normalizeInline(header.text()) || $('meta[property="og:title"]').attr("content")?.trim() || "";
  const summary =
    normalizeInline($("p.subheader.gb-subheader").first().text()) ||
    $('meta[name="description"]').attr("content")?.trim() ||
    "";
  const body = renderBlockText($, sections);

  return { id, locale, url, title, summary, body };
}

export async function fetchSupportArticle(idInput: string, localeInput?: string): Promise<SupportArticle> {
  const id = validateSupportId(idInput);
  const locale = validateLocale(localeInput);
  const url = `${SUPPORT_KB_BASE}/${locale}/${id}`;

  const { status, html } = await fetchHtmlFollow(url, [SUPPORT_KB_HOST]);
  // A well-formed-but-nonexistent id returns a real 404; a malformed one returns
  // a 200 soft-404 (caught by parseSupportArticle returning null).
  if (status === 404) {
    throw new Error(`Support article "${id}" was not found at ${url}.`);
  }
  const article = parseSupportArticle(html, id, locale, url);
  if (!article) {
    throw new Error(`Support article "${id}" was not found (the page resolved to a "Page Not Found" placeholder).`);
  }
  return article;
}

export function formatSupportArticleMarkdown(article: SupportArticle): string {
  const lines = [`# ${article.title || `Apple Support ${article.id}`}`];
  lines.push(`**URL**: ${article.url}`);
  if (article.summary) {
    lines.push("");
    lines.push(article.summary);
  }
  if (article.body) {
    lines.push("");
    lines.push(article.body);
  }
  return lines.join("\n").trim();
}
