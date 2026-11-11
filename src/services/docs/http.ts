/**
 * Access to Apple's documentation JSON API on top of the shared HTTP layer: raw page fetch
 * with in-flight de-duplication, and translation of transport errors into user-facing messages.
 */

import { APPLE_DEV_HOST } from "../../constants.js";
import { AppleDocPage } from "../../types.js";
import { fetchJson, SERVER_USER_AGENT } from "../safe-fetch.js";
import { AxiosError } from "axios";
import { docJsonUrl } from "./paths.js";

// Size caps for the two kinds of payload. Framework navigator-index payloads
// are much larger than a single doc page (Foundation's is ~6.8MB), so they get
// their own, higher cap rather than raising the cap on every page fetch.
const DOC_PAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FRAMEWORK_INDEX_MAX_BYTES = 20 * 1024 * 1024;

/**
 * GET a JSON document from the documentation origin. Rejects with an
 * AxiosError on a 4xx/5xx status, so callers can branch on a 404.
 */
export function fetchDocsJson<T>(url: string, maxBytes: number = DOC_PAGE_MAX_BYTES): Promise<T> {
  // No response cache here: pages and indexes are cached by their own modules
  // (page.ts, framework-index.ts), which would otherwise hold them twice.
  return fetchJson<T>(url, [APPLE_DEV_HOST], { maxBytes, userAgent: SERVER_USER_AGENT, cacheTtlMs: 0 });
}

// In-flight request deduplication: avoid fetching the same URL concurrently
// (e.g., during parallel search where multiple workers request the same child page)
export const inflightRequests = new Map<string, Promise<AppleDocPage>>();

export function rawFetchDocPage(normalizedPath: string): Promise<AppleDocPage> {
  const existing = inflightRequests.get(normalizedPath);
  if (existing) return existing;

  const url = docJsonUrl(normalizedPath);
  const promise = fetchDocsJson<AppleDocPage>(url).then((data) => {
    // Guard against non-JSON responses (e.g., HTML redirect pages)
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`Unexpected response format for "${normalizedPath}": expected JSON object.`);
    }
    return data;
  }).finally(() => {
    inflightRequests.delete(normalizedPath);
  });

  inflightRequests.set(normalizedPath, promise);
  return promise;
}

/** The error for a path with no page and nothing to suggest in its place. */
export function pageNotFoundError(path: string): Error {
  return new Error(
    `Documentation page not found for path "${path}". ` +
      `Check the path matches a valid Apple documentation URL (e.g. "swiftui/view", "swift/array", "foundation"). ` +
      `You can use apple_docs_list_technologies to discover framework names, or ` +
      `apple_docs_find_symbol to locate a symbol across all frameworks.`
  );
}

export function wrapFetchError(error: unknown, path: string): Error {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    if (status === 404) return pageNotFoundError(path);
    if (status === 400) {
      return new Error(
        `Invalid documentation path "${path}". The path may contain unsupported characters. ` +
          `Try a simpler path (e.g. "swiftui", "swift/array").`
      );
    }
    if (status === 403) {
      return new Error(`Access denied fetching Apple documentation for "${path}".`);
    }
    if (status === 429) {
      return new Error(`Rate limited by Apple's documentation server. Please wait a moment and try again.`);
    }
    if (status && status >= 500) {
      return new Error(
        `Apple's documentation server returned an error for "${path}". ` +
          `This is usually temporary — please try again shortly.`
      );
    }
    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      return new Error(`Request timed out fetching documentation for "${path}". Please try again.`);
    }
    if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
      return new Error(`Unable to reach Apple's documentation server. Check your network connection.`);
    }
    return new Error(`Network error fetching "${path}": ${error.message}`);
  }
  return new Error(`Unexpected error fetching "${path}": ${String(error)}`);
}
