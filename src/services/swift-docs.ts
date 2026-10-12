/**
 * Swift.org adapter — "The Swift Programming Language" (TSPL / swift-book) and
 * Swift release notes.
 *
 * The swift-book is published with the SAME swift-docc-render JSON schema as
 * developer.apple.com docs, just under a different origin and base path
 * (`https://docs.swift.org/swift-book/data/documentation/{path}.json`, with no
 * `tutorials/` segment). So page fetching reuses the existing DocC parser
 * verbatim — only the fetch URL and the human web URL differ.
 *
 * Release notes have no JSON API; they come from Atom feeds (swift.org "What's
 * new in Swift" blog posts + the swiftlang/swift GitHub releases feed).
 */

import { load } from "cheerio";
import {
  SWIFT_BOOK_HOST,
  SWIFT_BOOK_JSON_BASE,
  SWIFT_BOOK_ROOT_SLUG,
  SWIFT_BOOK_WEB_BASE,
  SWIFT_ORG_ATOM_URL,
  SWIFT_ORG_HOST,
  SWIFT_RELEASES_ATOM_URL,
  SWIFT_RELEASES_HOST,
} from "../constants.js";
import { AppleDocPage, ParsedSymbol } from "../types.js";
import { fetchHtml, fetchJson } from "./safe-fetch.js";
import { parseDocPage } from "./apple-docs.js";

// ---------------------------------------------------------------------------
// The Swift Programming Language (swift-book)
// ---------------------------------------------------------------------------

/**
 * Normalize a swift-book path to its canonical form
 * (`the-swift-programming-language` or `the-swift-programming-language/<chapter>`).
 * Accepts a full docs.swift.org URL, a bare chapter slug (`thebasics`), or an
 * already-qualified path. Rejects traversal and out-of-tree input.
 */
export function normalizeSwiftBookPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Invalid Swift book path: must not be empty.");

  // Reject any non-docs.swift.org absolute URL up front.
  if (/^https?:\/\//i.test(trimmed) && !/^https?:\/\/docs\.swift\.org\//i.test(trimmed)) {
    throw new Error(`Invalid Swift book path "${input}": only docs.swift.org URLs are supported.`);
  }

  let path = trimmed
    .replace(/^https?:\/\/docs\.swift\.org/i, "")
    .replace(/^\/?swift-book\/(?:data\/)?documentation\//i, "")
    .replace(/[?#].*$/, "")
    .replace(/\.json$/i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();

  if (path.includes("..")) {
    throw new Error(`Invalid Swift book path "${input}": path traversal is not allowed.`);
  }
  // Segments are lowercase alphanumerics and hyphens only.
  if (!path || !/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(path)) {
    throw new Error(`Invalid Swift book path "${input}": unexpected characters.`);
  }

  if (path === SWIFT_BOOK_ROOT_SLUG) return path;
  if (path.startsWith(`${SWIFT_BOOK_ROOT_SLUG}/`)) return path;
  // A bare chapter slug (e.g. "thebasics") is a child of the book root.
  return `${SWIFT_BOOK_ROOT_SLUG}/${path}`;
}

/**
 * Fetch a swift-book page and parse it with the shared DocC parser. The web URL
 * is rewritten to docs.swift.org (the DocC parser would otherwise point it at
 * developer.apple.com).
 */
export async function fetchSwiftBookPage(path: string): Promise<ParsedSymbol> {
  const normalized = normalizeSwiftBookPath(path);
  const url = `${SWIFT_BOOK_JSON_BASE}/${normalized}.json`;
  const page = await fetchJson<AppleDocPage>(url, [SWIFT_BOOK_HOST]);
  const parsed = parseDocPage(page, normalized);
  // parseDocPage derives webUrl from the identifier against the docs origin;
  // rewrite it to the actual swift-book location.
  parsed.webUrl = `${SWIFT_BOOK_WEB_BASE}/${parsed.path}`;
  return parsed;
}

// ---------------------------------------------------------------------------
// Swift release notes (Atom feeds)
// ---------------------------------------------------------------------------

export interface SwiftReleaseEntry {
  title: string;
  updated: string;
  link: string;
  summary: string;
  source: string;
}

/** Parse an Atom feed body into normalized entries. Pure — unit-testable. */
export function parseAtomFeed(xml: string, source: string, limit: number): SwiftReleaseEntry[] {
  const $ = load(xml, { xmlMode: true });
  const entries: SwiftReleaseEntry[] = [];

  $("entry").each((_, el) => {
    if (entries.length >= limit) return false;
    const entry = $(el);
    const title = entry.find("title").first().text().trim();
    const updated =
      entry.find("updated").first().text().trim() ||
      entry.find("published").first().text().trim();
    // Prefer the alternate link's href; fall back to any link href or <id>.
    const link =
      entry.find('link[rel="alternate"]').attr("href") ||
      entry.find("link").first().attr("href") ||
      entry.find("id").first().text().trim();
    const rawSummary =
      entry.find("summary").first().text().trim() ||
      entry.find("content").first().text().trim();
    // Feed content can be HTML; flatten to a short plain-text preview.
    const summary = load(rawSummary).text().replace(/\s+/g, " ").trim().slice(0, 400);

    if (title) {
      entries.push({ title, updated, link: link ?? "", summary, source });
    }
    return undefined;
  });

  return entries;
}

/**
 * Fetch recent Swift release notes: "What's new in Swift" blog posts from
 * swift.org and version/snapshot releases from the swiftlang/swift GitHub feed.
 * Best-effort per feed — a failed feed is skipped, not fatal.
 */
export async function fetchSwiftReleaseNotes(limit: number): Promise<SwiftReleaseEntry[]> {
  const feeds: Array<{ url: string; host: string; source: string }> = [
    { url: SWIFT_ORG_ATOM_URL, host: SWIFT_ORG_HOST, source: "swift.org blog" },
    { url: SWIFT_RELEASES_ATOM_URL, host: SWIFT_RELEASES_HOST, source: "swiftlang/swift releases" },
  ];

  const perFeed = Math.max(1, Math.ceil(limit / feeds.length) + 2);
  const settled = await Promise.allSettled(
    feeds.map(async (feed) => {
      const { html } = await fetchHtml(feed.url, [feed.host]);
      return parseAtomFeed(html, feed.source, perFeed);
    })
  );

  const merged: SwiftReleaseEntry[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") merged.push(...result.value);
  }
  // Newest first by parsed instant — the two feeds use different timezone
  // offsets (swift.org uses -04:00, GitHub uses Z), so a lexical string compare
  // would misorder entries across feeds. Unparseable dates sink to the bottom.
  merged.sort((a, b) => (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0));
  return merged.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatSwiftReleaseNotesMarkdown(entries: SwiftReleaseEntry[]): string {
  if (entries.length === 0) {
    return "No Swift release notes could be retrieved right now. Try again shortly.";
  }
  const lines = ["# Swift Release Notes & Updates", ""];
  for (const entry of entries) {
    lines.push(`## ${entry.title}`);
    const meta = [entry.updated ? `**Updated**: ${entry.updated}` : "", `**Source**: ${entry.source}`]
      .filter(Boolean)
      .join(" | ");
    lines.push(meta);
    if (entry.link) lines.push(`**URL**: ${entry.link}`);
    if (entry.summary) lines.push(entry.summary);
    lines.push("");
  }
  return lines.join("\n");
}
