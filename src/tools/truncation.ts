/**
 * Keeping tool responses within CHARACTER_LIMIT without corrupting them: text is cut
 * on a safe boundary, JSON is summarized or trimmed so it stays valid.
 */

import { CHARACTER_LIMIT } from "../constants.js";

const MAX_SUMMARIZE_DEPTH = 10;

/**
 * Safe truncation that avoids cutting mid-surrogate-pair.
 */
export function safeTruncate(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  let truncated = text.slice(0, limit);
  // If last char is a high surrogate (0xD800-0xDBFF), remove it to avoid orphan
  const lastCode = truncated.charCodeAt(truncated.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  // If last char is a low surrogate (0xDC00-0xDFFF) without a preceding high, remove it
  if (truncated.length > 0) {
    const finalCode = truncated.charCodeAt(truncated.length - 1);
    if (finalCode >= 0xdc00 && finalCode <= 0xdfff) {
      // Check if preceded by a high surrogate
      if (truncated.length < 2 || truncated.charCodeAt(truncated.length - 2) < 0xd800 || truncated.charCodeAt(truncated.length - 2) > 0xdbff) {
        truncated = truncated.slice(0, -1);
      }
    }
  }
  // Avoid cutting mid-JSON-escape-sequence (e.g., \uXXXX, \n, \t, \\)
  // If truncation ends with a trailing backslash that starts an incomplete escape, trim it
  if (truncated.length > 0) {
    // Count trailing backslashes — an odd number means the last one is an escape prefix
    let trailingBackslashes = 0;
    for (let i = truncated.length - 1; i >= 0 && truncated[i] === "\\"; i--) {
      trailingBackslashes++;
    }
    if (trailingBackslashes % 2 === 1) {
      truncated = truncated.slice(0, -1);
    }
    // Check for incomplete \uXXXX sequence (backslash + u + fewer than 4 hex chars at end)
    const uEscapeMatch = truncated.match(/\\u[0-9a-fA-F]{0,3}$/);
    if (uEscapeMatch) {
      truncated = truncated.slice(0, -uEscapeMatch[0].length);
    }
  }
  return truncated;
}

export function clampTextResponse(text: string, suffix: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  const budget = Math.max(0, CHARACTER_LIMIT - suffix.length);
  return `${safeTruncate(text, budget)}${suffix}`;
}

function summarizeJsonValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_SUMMARIZE_DEPTH) return "[nested]";
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    const limit = depth === 0 ? 8 : 5;
    const items = value.slice(0, limit).map((item) => summarizeJsonValue(item, depth + 1));
    if (value.length > limit) {
      items.push({ _truncatedItems: value.length - limit });
    }
    return items;
  }

  const entries = Object.entries(value);
  const limit = depth === 0 ? 16 : 10;
  const summarizedEntries = entries.slice(0, limit).map(([key, entryValue]) => [
    key,
    summarizeJsonValue(entryValue, depth + 1),
  ]);

  if (entries.length > limit) {
    summarizedEntries.push(["_truncatedKeys", entries.length - limit]);
  }

  return Object.fromEntries(summarizedEntries);
}

export function clampJsonResponse(value: unknown, note: string): string {
  const full = JSON.stringify(value, null, 2);
  if (full.length <= CHARACTER_LIMIT) return full;

  const summarized = {
    truncated: true,
    note,
    data: summarizeJsonValue(value),
  };
  const summarizedText = JSON.stringify(summarized, null, 2);
  if (summarizedText.length <= CHARACTER_LIMIT) return summarizedText;

  const minimal = JSON.stringify({ truncated: true, note }, null, 2);
  if (minimal.length >= CHARACTER_LIMIT) {
    return safeTruncate(minimal, CHARACTER_LIMIT);
  }

  // Use a conservative budget and verify the final output fits
  const previewBudget = Math.max(0, CHARACTER_LIMIT - minimal.length - 100);
  const result = JSON.stringify(
    {
      truncated: true,
      note,
      preview: safeTruncate(full, previewBudget),
    },
    null,
    2
  );

  // Final safety check: if JSON escaping caused the result to exceed the limit, re-truncate
  if (result.length > CHARACTER_LIMIT) {
    return safeTruncate(result, CHARACTER_LIMIT);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pagination: reading a response that is larger than CHARACTER_LIMIT in pieces.
// The caller passes back the offset a truncated response reported.
// ---------------------------------------------------------------------------

// Room for the "continuing from" / "truncated" notes and a re-opened or closed
// code fence, so a page plus its notes still fits in CHARACTER_LIMIT.
const PAGE_NOTE_RESERVE = 300;
// How far back from the size limit to look for a clean place to break a page.
const PAGE_BREAK_SEARCH = 4000;

/**
 * If `position` in `text` falls inside a fenced code block, the line that
 * opened it (e.g. "```swift"); otherwise null.
 */
function openCodeFence(text: string, position: number): string | null {
  let opener: string | null = null;
  let lineStart = 0;
  while (lineStart < position) {
    const next = text.indexOf("\n", lineStart);
    if (text.startsWith("```", lineStart)) {
      opener = opener === null ? text.slice(lineStart, next < 0 ? text.length : next) : null;
    }
    if (next < 0) break;
    lineStart = next + 1;
  }
  return opener;
}

/**
 * Return the part of a text response that starts at character `offset`,
 * sized to fit CHARACTER_LIMIT. A response that fits whole is returned as is.
 * Otherwise each page ends at a line break (or, failing that, between words)
 * and carries a note giving the offset that continues it; a code listing cut
 * by a page break is closed on one page and reopened on the next.
 */
export function paginateText(full: string, offset: number): string {
  const total = full.length;
  if (offset === 0 && total <= CHARACTER_LIMIT) return full;
  if (offset >= total) {
    return `*(Nothing to show: offset ${offset} is past the end of this ${total}-character response.)*`;
  }

  let end = Math.min(total, offset + CHARACTER_LIMIT - PAGE_NOTE_RESERVE);
  if (end < total) {
    const searchFrom = Math.max(offset + 1, end - PAGE_BREAK_SEARCH);
    const lineBreak = full.lastIndexOf("\n", end - 1);
    const space = full.lastIndexOf(" ", end - 1);
    if (lineBreak >= searchFrom) end = lineBreak + 1;
    else if (space >= searchFrom) end = space + 1;
    else end = offset + safeTruncate(full.slice(offset, end), end - offset).length;
  }

  let body = full.slice(offset, end);
  const reopened = openCodeFence(full, offset);
  if (reopened !== null) body = `${reopened}\n${body}`;
  if (end < total && openCodeFence(full, end) !== null) body = `${body.replace(/\n$/, "")}\n\`\`\``;

  const before = offset > 0 ? `*(Continuing from character ${offset} of ${total}.)*\n\n` : "";
  const after =
    end < total
      ? `\n\n*(Truncated: showing characters ${offset}–${end} of ${total}. Call again with offset=${end} to continue.)*`
      : "";
  return `${before}${body}${after}`;
}

/** The largest `count` in [0, max] for which `fits(count)` holds, assuming it holds for smaller counts. */
function largestFitting(max: number, fits: (count: number) => boolean): number {
  let lo = 0;
  let hi = max;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Serialize a value as JSON. One that fits CHARACTER_LIMIT is returned as
 * plain JSON. A larger one is returned in pieces: each response is a small
 * JSON envelope whose `chunk` is a slice of the full pretty-printed document,
 * with `next_offset` for the following call (null on the last). Concatenating
 * the chunks rebuilds the document exactly, so nothing is summarized away.
 */
export function paginateJson(value: unknown, offset: number): string {
  const full = JSON.stringify(value, null, 2);
  const total = full.length;
  if (offset === 0 && total <= CHARACTER_LIMIT) return full;

  const start = Math.min(offset, total);
  const envelope = (length: number): string => {
    const end = start + length;
    return JSON.stringify(
      {
        truncated: true,
        note: "This JSON document is too large for one response. Concatenate the `chunk` strings from successive calls (pass next_offset as offset) to rebuild it.",
        offset,
        next_offset: end < total ? end : null,
        total_length: total,
        chunk: full.slice(start, end),
      },
      null,
      2
    );
  };
  // Escaping makes the chunk longer inside the envelope than it is in the
  // document, so the size that fits has to be searched for, not computed.
  const length = largestFitting(total - start, (candidate) => envelope(candidate).length <= CHARACTER_LIMIT);
  return envelope(length);
}

/**
 * Serialize a list response, `{ ...base, [key]: items }`, as JSON. A list
 * that fits is returned whole. A larger one is returned a page of whole items
 * at a time, starting at item `offset`, with `next_offset` for the following
 * call (null on the last page) — every page is complete, valid JSON.
 */
export function paginateJsonList(base: Record<string, unknown>, key: string, items: unknown[], offset: number): string {
  if (offset === 0) {
    const full = JSON.stringify({ ...base, [key]: items }, null, 2);
    if (full.length <= CHARACTER_LIMIT) return full;
  }

  const start = Math.min(offset, items.length);
  const page = (count: number): string => {
    const end = start + count;
    const shown = count > 0 ? `items ${start + 1}–${end}` : "no items";
    const more = end < items.length ? ` Call again with offset=${end} to continue.` : "";
    return JSON.stringify(
      {
        ...base,
        truncated: true,
        note: `Showing ${shown} of ${items.length}.${more}`,
        offset,
        next_offset: end < items.length ? end : null,
        [key]: items.slice(start, end),
      },
      null,
      2
    );
  };
  const remaining = items.length - start;
  // Always return at least one item when any remain, so paging makes progress
  // even past an item that is larger than the limit on its own.
  const count = Math.max(remaining > 0 ? 1 : 0, largestFitting(remaining, (candidate) => page(candidate).length <= CHARACTER_LIMIT));
  return page(count);
}
