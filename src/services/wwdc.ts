/**
 * WWDC session scraper — transcript + metadata for
 * developer.apple.com/videos/play/wwdc{YYYY}/{NNN}/, and the per-year session
 * listing at developer.apple.com/videos/wwdc{YYYY}/ used to find session ids.
 *
 * These are legacy server-rendered HTML pages (no JSON API), so we fetch the
 * HTML over plain HTTPS and parse it with cheerio. A non-existent session
 * 302-redirects to the year listing, which we treat as "not found" (the fetch
 * client does not auto-follow redirects).
 */

import { load, type CheerioAPI } from "cheerio";
import { WWDC_HOST, WWDC_SESSION_BASE, WWDC_VIDEOS_BASE } from "../constants.js";
import { fetchHtml } from "./safe-fetch.js";

export interface WwdcChapter {
  time: string;
  title: string;
}

export interface WwdcSampleCode {
  title: string;
  time?: string;
  code: string;
}

export interface WwdcResource {
  title: string;
  href: string;
}

export interface WwdcRelatedVideo {
  title: string;
  path: string;
}

export interface WwdcSession {
  year: string;
  id: string;
  url: string;
  webUrl: string;
  title: string;
  description: string;
  chapters: WwdcChapter[];
  transcript: string;
  sampleCode: WwdcSampleCode[];
  resources: WwdcResource[];
  relatedVideos: WwdcRelatedVideo[];
}

/** Validate the conference year (4 digits) and session id (digits). */
export function validateWwdcRef(year: string, id: string): { year: string; id: string } {
  const y = String(year).trim();
  const i = String(id).trim();
  if (!/^\d{4}$/.test(y)) {
    throw new Error(`Invalid WWDC year "${year}": expected a 4-digit year like 2024.`);
  }
  if (!/^\d+$/.test(i)) {
    throw new Error(`Invalid WWDC session id "${id}": expected digits like 10176.`);
  }
  return { year: y, id: i };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Parse a WWDC session HTML page into structured content. Pure so it can be
 * unit-tested against a fixture; the fetch lives in fetchWwdcSession.
 */
export function parseWwdcSessionHtml(html: string, year: string, id: string): WwdcSession {
  const $: CheerioAPI = load(html);
  const webUrl = `${WWDC_SESSION_BASE}/wwdc${year}/${id}/`;

  const details = $("li.supplement.details").first();

  // Title: prefer the in-body <h1>; fall back to og:title / <title> (minus the
  // " - WWDCxx - Videos - Apple Developer" suffix).
  let title = collapse(details.find("h1").first().text());
  if (!title) {
    title =
      $('meta[property="og:title"]').attr("content")?.trim() ||
      $("title").first().text().replace(/\s*-\s*WWDC.*$/i, "").trim() ||
      "";
  }

  // Description: the first in-body <p> (meta descriptions are ellipsis-truncated).
  let description = collapse(details.find("p").first().text());
  if (!description) {
    description = $('meta[name="description"]').attr("content")?.trim() || "";
  }

  const chapters: WwdcChapter[] = [];
  $("ul.chapter-list li.chapter-item a.jump-to-time").each((_, el) => {
    const a = $(el);
    const seconds = a.attr("data-start-time");
    chapters.push({ time: secondsToTimestamp(seconds), title: collapse(a.text()) });
  });

  // Transcript: every sentence span, in order.
  const sentences: string[] = [];
  $("#transcript-content span.sentence").each((_, el) => {
    const text = collapse($(el).text());
    if (text) sentences.push(text);
  });
  const transcript = sentences.join(" ");

  const sampleCode: WwdcSampleCode[] = [];
  $("li.supplement.sample-code li.sample-code-main-container").each((_, el) => {
    const container = $(el);
    const anchor = container.find("a.jump-to-time-sample").first();
    const title = collapse(anchor.text()) || collapse(container.find("p").first().text());
    const time = secondsToTimestamp(anchor.attr("data-start-time"));
    // .text() on the <code> strips the syntax-highlight <span> wrappers.
    const code = container.find("pre.code-source code").first().text().replace(/\n{3,}/g, "\n\n").trimEnd();
    if (code) sampleCode.push({ title: title || "Sample", time: time || undefined, code });
  });

  const resources: WwdcResource[] = [];
  $("ul.links.small li.download a").each((_, el) => {
    const a = $(el);
    const href = a.attr("href");
    if (href) resources.push({ title: collapse(a.text()) || href, href });
  });

  const relatedVideos: WwdcRelatedVideo[] = [];
  $('li.video a[href^="/videos/play/"]').each((_, el) => {
    const a = $(el);
    const href = a.attr("href") ?? "";
    const path = href.replace(/^\/videos\/play\//, "").replace(/\/(?:\?.*)?$/, "");
    const t = collapse(a.text());
    if (path && t) relatedVideos.push({ title: t, path });
  });

  return {
    year,
    id,
    url: webUrl,
    webUrl,
    title,
    description,
    chapters,
    transcript,
    sampleCode,
    resources,
    relatedVideos,
  };
}

function secondsToTimestamp(seconds: string | undefined): string {
  if (!seconds) return "";
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return "";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Fetch and parse a WWDC session. Throws a helpful "not found" error when the
 * session id doesn't exist (Apple 302-redirects those to the year listing).
 */
export async function fetchWwdcSession(yearInput: string, idInput: string): Promise<WwdcSession> {
  const { year, id } = validateWwdcRef(yearInput, idInput);
  const url = `${WWDC_SESSION_BASE}/wwdc${year}/${id}/`;

  const { status, html } = await fetchHtml(url, [WWDC_HOST]);
  if (status >= 300 && status < 400) {
    throw new Error(
      `WWDC session wwdc${year}/${id} was not found (the page redirected to the year listing). ` +
        `Check the year and session id at ${WWDC_SESSION_BASE}/wwdc${year}/.`
    );
  }

  const session = parseWwdcSessionHtml(html, year, id);
  if (!session.title && !session.transcript) {
    throw new Error(
      `Could not extract content for WWDC session wwdc${year}/${id}. The page may have changed layout, ` +
        `or the session may not exist.`
    );
  }
  return session;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatWwdcSessionMarkdown(session: WwdcSession): string {
  const lines: string[] = [];
  lines.push(`# ${session.title || `WWDC${session.year} Session ${session.id}`}`);
  lines.push(`**WWDC${session.year} · Session ${session.id}** | **URL**: ${session.webUrl}`);
  lines.push("");

  if (session.description) {
    lines.push("## Overview");
    lines.push(session.description);
    lines.push("");
  }

  if (session.chapters.length > 0) {
    lines.push("## Chapters");
    for (const chapter of session.chapters) {
      lines.push(`- ${chapter.time ? `\`${chapter.time}\` ` : ""}${chapter.title}`);
    }
    lines.push("");
  }

  if (session.sampleCode.length > 0) {
    lines.push("## Code Samples");
    for (const sample of session.sampleCode) {
      const heading = [sample.time ? `\`${sample.time}\`` : "", sample.title].filter(Boolean).join(" ");
      lines.push(`### ${heading}`);
      // The page does not say what language a sample is in, and many are shell
      // commands or C++, so the fence carries no language rather than a wrong one.
      lines.push("```");
      lines.push(sample.code);
      lines.push("```");
      lines.push("");
    }
  }

  if (session.transcript) {
    lines.push("## Transcript");
    lines.push(session.transcript);
    lines.push("");
  }

  if (session.resources.length > 0) {
    lines.push("## Resources");
    for (const resource of session.resources) {
      lines.push(`- [${resource.title}](${resource.href})`);
    }
    lines.push("");
  }

  if (session.relatedVideos.length > 0) {
    lines.push("## Related Sessions");
    for (const related of session.relatedVideos) {
      lines.push(`- **${related.title}** (\`${related.path}\`)`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Session lookup: the per-year listing
// ---------------------------------------------------------------------------

export interface WwdcSessionSummary {
  id: string;
  title: string;
  /** "wwdc2024/10136" — the form used for related sessions. */
  path: string;
  url: string;
  duration: string;
  topics: string[];
  platforms: string[];
  keywords: string[];
  /** As published in the listing, where Apple lowercases it. */
  description: string;
}

export interface WwdcSessionListing {
  year: string;
  query?: string;
  /** Sessions in the year, before any query was applied. */
  total: number;
  sessions: WwdcSessionSummary[];
}

function splitList(value: string | undefined, separator: string): string[] {
  return (value ?? "")
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Parse a year's listing page into its sessions. Each session is a card
 * linking to /videos/play/wwdc{year}/{id}/; other cards (tech talks, other
 * years) and non-card links to the same sessions are ignored.
 */
export function parseWwdcYearListing(html: string, year: string): WwdcSessionSummary[] {
  const $: CheerioAPI = load(html);
  const sessions: WwdcSessionSummary[] = [];
  const seen = new Set<string>();

  $("a.vc-card").each((_, el) => {
    const card = $(el);
    const match = (card.attr("href") ?? "").match(/^\/videos\/play\/wwdc(\d{4})\/(\d+)\/?$/);
    if (!match || match[1] !== year || seen.has(match[2])) return;
    const id = match[2];
    seen.add(id);

    const filters = card.find(".vc-card__keywords").first();
    sessions.push({
      id,
      title: collapse(card.find(".vc-card__title").first().text()),
      path: `wwdc${year}/${id}`,
      url: `${WWDC_SESSION_BASE}/wwdc${year}/${id}/`,
      duration: collapse(card.find(".vc-card__duration").first().text()),
      topics: splitList(filters.attr("data-filter-topics"), "|"),
      platforms: splitList(filters.attr("data-filter-platform"), "|"),
      keywords: splitList(filters.attr("data-filter-keywords"), ","),
      description: collapse(filters.attr("data-filter-description") ?? ""),
    });
  });

  return sessions;
}

/** Lowercase, and fold typographic apostrophes so "what's" matches "What’s". */
function searchable(text: string): string {
  return text.toLowerCase().replace(/[\u2018\u2019]/g, "'");
}

// With no complete match, a session is kept if it scores at least this share
// of the best partial match's score.
const PARTIAL_MATCH_SHARE = 0.5;

/**
 * Find sessions matching a free-text query against title, topics, keywords,
 * and description.
 *
 * If any session contains every query word, only those are returned, title
 * matches first. Otherwise words are weighted by how rare they are across the
 * year's sessions — so in "what's new in swiftdata" it is "swiftdata" that
 * counts, not the words nearly every session has — and the sessions scoring
 * within reach of the best one are returned, best first.
 */
export function searchWwdcSessions(sessions: WwdcSessionSummary[], query: string): WwdcSessionSummary[] {
  const words = [...new Set(searchable(query).split(/\s+/).filter(Boolean))];
  if (words.length === 0) return sessions;

  const indexed = sessions.map((session, order) => {
    const title = searchable(session.title);
    const everything = searchable(
      [session.title, session.topics.join(" "), session.keywords.join(" "), session.description].join(" ")
    );
    return {
      session,
      order,
      matched: words.filter((word) => everything.includes(word)),
      inTitle: words.filter((word) => title.includes(word)).length,
    };
  });

  const complete = indexed.filter((entry) => entry.matched.length === words.length);
  if (complete.length > 0) {
    return complete.sort((a, b) => b.inTitle - a.inTitle || a.order - b.order).map((entry) => entry.session);
  }

  // Inverse document frequency: a word found in every session weighs nothing.
  const weight = new Map(
    words.map((word) => {
      const containing = indexed.filter((entry) => entry.matched.includes(word)).length;
      return [word, containing > 0 ? Math.log(sessions.length / containing) : 0] as const;
    })
  );
  const scored = indexed
    .map((entry) => ({ ...entry, score: entry.matched.reduce((sum, word) => sum + (weight.get(word) ?? 0), 0) }))
    .filter((entry) => entry.score > 0);
  const best = Math.max(0, ...scored.map((entry) => entry.score));

  return scored
    .filter((entry) => entry.score >= best * PARTIAL_MATCH_SHARE)
    .sort((a, b) => b.score - a.score || b.inTitle - a.inTitle || a.order - b.order)
    .map((entry) => entry.session);
}

/**
 * List a year's sessions, optionally narrowed by a query. Throws a helpful
 * error for a year Apple has no listing for (it redirects to the videos home).
 */
export async function fetchWwdcSessions(yearInput: string, query?: string): Promise<WwdcSessionListing> {
  const { year } = validateWwdcRef(yearInput, "0");
  const url = `${WWDC_VIDEOS_BASE}/wwdc${year}/`;

  const { status, html } = await fetchHtml(url, [WWDC_HOST]);
  const all = status >= 200 && status < 300 ? parseWwdcYearListing(html, year) : [];
  if (all.length === 0) {
    throw new Error(
      `No WWDC session listing was found for ${year}. Apple publishes session videos from 2014 onward; ` +
        `check the year at ${WWDC_VIDEOS_BASE}/.`
    );
  }

  const trimmed = query?.trim();
  return {
    year,
    ...(trimmed ? { query: trimmed } : {}),
    total: all.length,
    sessions: trimmed ? searchWwdcSessions(all, trimmed) : all,
  };
}

export function formatWwdcSessionListMarkdown(listing: WwdcSessionListing): string {
  const { year, query, total, sessions } = listing;
  if (query && sessions.length === 0) {
    return (
      `No WWDC ${year} sessions match "${query}" (${total} sessions searched by title, topic, keyword, and description). ` +
      `Try fewer or different words, or omit query to list every session.`
    );
  }

  const lines = [`# WWDC ${year} Sessions`];
  lines.push(query ? `${sessions.length} of ${total} sessions match "${query}".` : `${total} sessions.`);
  lines.push("Pass a session id as `session` to read its transcript.", "");

  for (const session of sessions) {
    const facts = [`session \`${session.id}\``, session.duration, session.topics.join(", ")].filter(Boolean);
    lines.push(`- **${session.title}** — ${facts.join(" · ")}`);
    // Descriptions help choose between search hits, but would triple the size of a full listing.
    if (query && session.description) lines.push(`  ${session.description}`);
  }

  return lines.join("\n") + "\n";
}
