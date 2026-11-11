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

/**
 * Serialize a list-style JSON response, keeping as many array entries as fit in
 * CHARACTER_LIMIT instead of the generic summarizer's fixed 5-item cap (which
 * would drop hundreds of small records — e.g. the 261-article help index — down
 * to 5). Mirrors the markdown path, which already shows as many entries as fit.
 */
export function clampJsonList(base: Record<string, unknown>, key: string, items: unknown[], note: string): string {
  const full = JSON.stringify({ ...base, [key]: items }, null, 2);
  if (full.length <= CHARACTER_LIMIT) return full;

  // Largest prefix of `items` that still fits, with a truncation note.
  let lo = 0;
  let hi = items.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = JSON.stringify(
      { ...base, truncated: true, note: `${note} Showing ${mid} of ${items.length}.`, [key]: items.slice(0, mid) },
      null,
      2
    );
    if (candidate.length <= CHARACTER_LIMIT) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return JSON.stringify(
    { ...base, truncated: true, note: `${note} Showing ${best} of ${items.length}.`, [key]: items.slice(0, best) },
    null,
    2
  );
}
