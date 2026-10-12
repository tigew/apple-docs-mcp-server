/**
 * Apple Developer Forums — listings-only adapter.
 *
 * IMPORTANT SCOPE LIMIT: individual thread pages (/forums/thread/{id}) are gated
 * behind an Apple "Shield BT" JavaScript bot-challenge that a plain-HTTPS client
 * cannot pass (every request 302-redirects to a verify-human page), and the
 * content JSON API is auth/write-only (401). So thread *bodies and replies are
 * out of reach* without a headless browser.
 *
 * What IS reachable over plain HTTPS is the listing metadata on the forums home
 * and per-tag pages: thread titles, thread IDs, and (best-effort) recency
 * timestamps. This adapter surfaces exactly that, and is explicit about the
 * limitation so callers don't mistake it for full-text forum search.
 */

import { load } from "cheerio";
import {
  APPLE_FORUMS_HOME_URL,
  APPLE_FORUMS_HOST,
  APPLE_FORUMS_TAGS_BASE,
  APPLE_FORUMS_THREAD_BASE,
} from "../constants.js";
import { fetchHtml } from "./safe-fetch.js";

export interface ForumThread {
  id: string;
  title: string;
  url: string;
  timestamp?: string;
}

/** Validate a forum tag slug before it's placed into a URL. */
export function validateForumTag(input: string): string {
  const tag = String(input).trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag)) {
    throw new Error(`Invalid forum tag "${input}": expected a slug like "swiftui" or "app-store-connect".`);
  }
  return tag;
}

/** Parse a forums listing page (home or tag) into thread metadata. Pure. */
export function parseForumListing(html: string): ForumThread[] {
  const $ = load(html);
  const threads: ForumThread[] = [];
  const seen = new Set<string>();

  $('a.post-title[href^="/forums/thread/"]').each((_, el) => {
    const a = $(el);
    const href = a.attr("href") ?? "";
    const match = href.match(/\/forums\/thread\/(\d+)/);
    if (!match) return;
    const id = match[1];
    if (seen.has(id)) return;
    const title = a.text().replace(/\s+/g, " ").trim();
    if (!title) return;
    seen.add(id);

    // Best-effort recency: the nearest following timestamp within the same
    // list-item container, if present.
    const container = a.closest("li, article, div.topic-overview-posts, div");
    const timestamp = container.find("div.topic-overview-posts-timestamp").first().text().replace(/\s+/g, " ").trim();

    threads.push({
      id,
      title,
      url: `${APPLE_FORUMS_THREAD_BASE}/${id}`,
      timestamp: timestamp || undefined,
    });
  });

  return threads;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export async function fetchForumThreads(tagInput?: string): Promise<{ tag?: string; threads: ForumThread[] }> {
  const tag = tagInput ? validateForumTag(tagInput) : undefined;
  const url = tag ? `${APPLE_FORUMS_TAGS_BASE}/${tag}` : APPLE_FORUMS_HOME_URL;

  const { status, html } = await fetchHtml(url, [APPLE_FORUMS_HOST]);
  if (status >= 300 && status < 400) {
    throw new Error(
      `The Apple Developer Forums listing at ${url} redirected to a bot-verification page and could not be read ` +
        `automatically. This can happen intermittently; try again shortly.`
    );
  }

  const threads = parseForumListing(html);
  return { tag, threads };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const BODY_LIMITATION_NOTE =
  "*Note: this lists thread titles and IDs only. Apple gates individual thread pages behind a JavaScript " +
  "bot-challenge, so post bodies and replies can't be fetched automatically — open the URL in a browser to read a thread.*";

export function formatForumThreadsMarkdown(tag: string | undefined, threads: ForumThread[]): string {
  const heading = tag ? `# Apple Developer Forums — tag "${tag}"` : "# Apple Developer Forums — Recent Threads";
  if (threads.length === 0) {
    return `${heading}\n\nNo threads found${tag ? ` for tag "${tag}"` : ""}.\n\n${BODY_LIMITATION_NOTE}`;
  }
  const lines = [heading, `Found ${threads.length} thread(s)`, "", BODY_LIMITATION_NOTE, ""];
  for (const thread of threads) {
    const when = thread.timestamp ? ` _(${thread.timestamp})_` : "";
    lines.push(`- **${thread.title}**${when}\n  ${thread.url}`);
  }
  return lines.join("\n");
}
