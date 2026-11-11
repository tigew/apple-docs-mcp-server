/**
 * Cross-framework search via the API behind the developer.apple.com search page.
 */

import { APPLE_GLOBAL_SEARCH_HOST, APPLE_GLOBAL_SEARCH_URL, GLOBAL_SEARCH_TIMEOUT_MS } from "../../constants.js";
import { GlobalSearchResult } from "../../types.js";
import { postJsonForText, SERVER_USER_AGENT } from "../safe-fetch.js";
import { buildWebUrl, pathFromDocUrl } from "./paths.js";

/**
 * Parse the assembled global search document (see assembleSearchStream) into
 * validated results. Each hit is `{ excerpt, value: { metadata, origin } }`;
 * only documentation hits whose permalink is a developer.apple.com
 * documentation URL survive — video ("developer") and web-page hits use other
 * field shapes and are skipped.
 */
export function parseGlobalSearchResponse(data: unknown, limit: number): GlobalSearchResult[] {
  const results = (data as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(results)) return [];

  const out: GlobalSearchResult[] = [];
  const seen = new Set<string>();
  for (const entry of results) {
    const hit = entry as { excerpt?: unknown; value?: { metadata?: Record<string, unknown> } } | null;
    const meta = hit?.value?.metadata;
    if (!meta || typeof meta !== "object" || meta.metadataKind !== "documentation") continue;
    const path = pathFromDocUrl(typeof meta.permalink === "string" ? meta.permalink : undefined);
    if (!path || seen.has(path)) continue;
    seen.add(path);

    const hierarchy = typeof meta.hierarchy === "string" ? meta.hierarchy : "";
    const description = typeof meta.description === "string" ? meta.description : "";
    out.push({
      title: typeof meta.title === "string" && meta.title ? meta.title : path.split("/").pop() ?? path,
      path,
      webUrl: buildWebUrl(path),
      framework: (hierarchy.split(">")[0] || path.split("/")[0]).trim(),
      // Members often have no description; their excerpt carries the declaration.
      description: description || (typeof hit?.excerpt === "string" ? hit.excerpt : ""),
      availability: typeof meta.availability === "string" ? meta.availability : undefined,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Decode the global search API's JSON Lines stream into its result document.
 * Each `search` event carries `diff: { removeLast, append }`: drop that many
 * trailing characters from the buffer, then append — the server streams hits
 * progressively and rewrites the tail as excerpts grow. Once the stream ends,
 * the buffer is one JSON document (`{ results: [...] }`). Other event kinds
 * (quickSearch, ask, searchFinished) are ignored.
 */
export function assembleSearchStream(body: string): unknown {
  let buffer = "";
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    let event: { kind?: unknown; diff?: { removeLast?: unknown; append?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a malformed line; the final parse below decides if it mattered
    }
    if (event?.kind !== "search" || !event.diff) continue;
    const { removeLast, append } = event.diff;
    if (typeof removeLast === "number" && removeLast > 0) {
      buffer = buffer.slice(0, Math.max(0, buffer.length - removeLast));
    }
    if (typeof append === "string") buffer += append;
  }

  try {
    const data: unknown = JSON.parse(buffer);
    if (data && typeof data === "object") return data;
  } catch {
    // fall through to the error below
  }
  throw new Error("Unexpected response format from Apple's global search: the result stream was empty or incomplete.");
}

/**
 * Search Apple's documentation across ALL frameworks via the same API the
 * developer.apple.com search page uses. Works best with symbol/concept names
 * (it is not a full-text index).
 */
export async function searchGlobalSymbols(query: string, limit: number): Promise<GlobalSearchResult[]> {
  const stream = await postJsonForText(
    APPLE_GLOBAL_SEARCH_URL,
    // "search" only: the endpoint can also stream quick results and a generated
    // answer ("ask"), neither of which this tool uses.
    { text: query, targetResultLocale: "en", includedResponses: ["search"] },
    [APPLE_GLOBAL_SEARCH_HOST],
    {
      accept: "application/jsonl",
      timeoutMs: GLOBAL_SEARCH_TIMEOUT_MS,
      userAgent: SERVER_USER_AGENT,
      // The backend takes 4-8s and its results vary run to run, so repeat
      // questions are answered from memory for a few minutes.
      cacheTtlMs: 5 * 60 * 1000,
    }
  );
  return parseGlobalSearchResponse(assembleSearchStream(stream), limit);
}
