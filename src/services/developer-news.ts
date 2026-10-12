/**
 * developer.apple.com Developer News adapter (+ a best-effort reader for the
 * marketing/topic microsites like /apple-intelligence/ and /private-cloud-compute/).
 *
 * News is clean, recurring, and article-shaped: the /news/ index embeds each
 * post's title, date, and full body inline, so listing is a single GET. Single
 * posts are at /news/?id={id}. The topic microsites have no per-page schema, so
 * they only get a clearly-labeled lossy readability pass.
 */

import { load } from "cheerio";
import {
  DEV_MARKETING_ORIGIN,
  DEV_NEWS_HOST,
  DEV_NEWS_INDEX_URL,
  DEV_NEWS_POST_BASE,
} from "../constants.js";
import { fetchHtml } from "./safe-fetch.js";
import { normalizeInline, renderBlockText } from "./html-render.js";

export interface NewsItem {
  id: string;
  title: string;
  date: string;
  url: string;
  body: string;
}

export interface MarketingPage {
  path: string;
  url: string;
  title: string;
  summary: string;
  body: string;
}

const NEWS_ID_RE = /^[a-z0-9]{4,16}$/;
// A microsite slug: one or more lowercase-hyphenated path segments. Trees the
// other tools already own are rejected so this stays a *marketing* reader.
const MARKETING_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const RESERVED_TREES = new Set(["documentation", "design", "tutorials", "help", "videos", "forums", "news"]);

export function validateNewsId(input: string): string {
  const id = String(input).trim().toLowerCase();
  if (!NEWS_ID_RE.test(id)) {
    throw new Error(`Invalid news id "${input}": expected an 8-character alphanumeric id like "tlur8uvi".`);
  }
  return id;
}

export function validateMarketingSlug(input: string): string {
  const slug = String(input)
    .trim()
    .replace(/^https?:\/\/developer\.apple\.com/i, "")
    .replace(/[?#].*$/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (!slug || !MARKETING_SLUG_RE.test(slug)) {
    throw new Error(`Invalid marketing page "${input}": expected a slug like "apple-intelligence".`);
  }
  if (RESERVED_TREES.has(slug.split("/")[0])) {
    throw new Error(
      `"${slug}" is served by a dedicated tool, not the marketing reader — use the matching apple_docs_/apple_wwdc_/... tool instead.`
    );
  }
  return slug;
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

/** Parse the /news/ index into recent items (bodies are inline on the index). Pure. */
export function parseNewsIndex(html: string, limit: number): NewsItem[] {
  const $ = load(html);
  const items: NewsItem[] = [];
  $('article[id^="article-"]').each((_, el) => {
    if (items.length >= limit) return false;
    const article = $(el);
    const id = (article.attr("id") ?? "").replace(/^article-/, "");
    if (!id) return undefined;
    const title = normalizeInline(article.find("a.article-title h2").first().text());
    const date = normalizeInline(article.find("p.article-date").first().text());
    const bodyEl = article.find("span.article-text").first();
    const body = bodyEl.length ? renderBlockText($, bodyEl) : "";
    if (!title) return undefined;
    items.push({ id, title, date, url: `${DEV_NEWS_POST_BASE}?id=${id}`, body });
    return undefined;
  });
  return items;
}

/** Parse a single /news/?id= post page. Pure. */
export function parseNewsPost(html: string, id: string): NewsItem | null {
  const $ = load(html);
  const article = $(`article[id="article-${id}"]`).first();
  const scope = article.length ? article : $("main, #main").first();

  const title =
    normalizeInline(scope.find("a.article-title h2, h1").first().text()) ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    "";
  const date = normalizeInline(scope.find("p.article-date").first().text());
  const bodyEl = scope.find("span.article-text").first();
  const body = bodyEl.length
    ? renderBlockText($, bodyEl)
    : normalizeInline($('meta[property="og:description"]').attr("content") ?? "");

  if (!title && !body) return null;
  return { id, title, date, url: `${DEV_NEWS_POST_BASE}?id=${id}`, body };
}

export async function fetchNewsList(limit: number): Promise<NewsItem[]> {
  const { html } = await fetchHtml(DEV_NEWS_INDEX_URL, [DEV_NEWS_HOST]);
  return parseNewsIndex(html, limit);
}

export async function fetchNewsPost(idInput: string): Promise<NewsItem> {
  const id = validateNewsId(idInput);
  const { html } = await fetchHtml(`${DEV_NEWS_POST_BASE}?id=${id}`, [DEV_NEWS_HOST]);
  const post = parseNewsPost(html, id);
  if (!post) throw new Error(`Developer news post "${id}" was not found.`);
  return post;
}

// ---------------------------------------------------------------------------
// Marketing microsite reader (best-effort, lossy)
// ---------------------------------------------------------------------------

export async function fetchMarketingPage(slugInput: string): Promise<MarketingPage> {
  const slug = validateMarketingSlug(slugInput);
  const url = `${DEV_MARKETING_ORIGIN}/${slug}/`;
  const { status, html } = await fetchHtml(url, [DEV_NEWS_HOST]);
  if (status === 404) throw new Error(`Marketing page "${slug}" was not found at ${url}.`);

  const $ = load(html);
  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    normalizeInline($("h1").first().text()) ||
    normalizeInline($("title").first().text());
  const summary = $('meta[property="og:description"]').attr("content")?.trim() ||
    $('meta[name="description"]').attr("content")?.trim() ||
    "";
  // No per-page schema exists on these marketing pages, so sweep the main
  // content region's headings and substantial paragraphs — explicitly lossy.
  const main = $("main, #main, [role='main']").first();
  const scope = main.length ? main : $("body");
  const body = renderBlockText($, scope);

  if (!title && !body) throw new Error(`Could not extract readable content from ${url}.`);
  return { path: slug, url, title, summary, body };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatNewsListMarkdown(items: NewsItem[]): string {
  const lines = ["# Apple Developer News", `Source: ${DEV_NEWS_INDEX_URL}`, "", "Pass an `id` to read a single post.", ""];
  for (const item of items) {
    lines.push(`### ${item.title}`);
    lines.push(`${item.date ? `${item.date} · ` : ""}\`id=${item.id}\` · ${item.url}`);
    if (item.body) lines.push(item.body.length > 500 ? `${item.body.slice(0, 500)}…` : item.body);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function formatNewsPostMarkdown(item: NewsItem): string {
  return [
    `# ${item.title}`,
    item.date ? `**${item.date}**` : "",
    `**URL**: ${item.url}`,
    "",
    item.body,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function formatMarketingPageMarkdown(page: MarketingPage): string {
  return [
    `# ${page.title || page.path}`,
    `**URL**: ${page.url}`,
    "*(Best-effort readable extraction of a marketing page — layout-heavy pages may render imperfectly.)*",
    "",
    page.summary,
    "",
    page.body,
  ]
    .filter((l) => l !== "")
    .join("\n")
    .trim();
}
