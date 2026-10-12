/**
 * WWDC session scraper — transcript + metadata for
 * developer.apple.com/videos/play/wwdc{YYYY}/{NNN}/.
 *
 * These are legacy server-rendered HTML pages (no JSON API), so we fetch the
 * HTML over plain HTTPS and parse it with cheerio. A non-existent session
 * 302-redirects to the year listing, which we treat as "not found" (the fetch
 * client does not auto-follow redirects).
 */

import { load, type CheerioAPI } from "cheerio";
import { WWDC_HOST, WWDC_SESSION_BASE } from "../constants.js";
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
      lines.push("```swift");
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
