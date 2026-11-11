/**
 * HTTP access to Apple's documentation JSON API: allowlisted clients, raw page fetch with
 * in-flight de-duplication, and translation of transport errors into user-facing messages.
 */

import { APPLE_DEV_HOST, APPLE_GLOBAL_SEARCH_HOST, REQUEST_TIMEOUT_MS } from "../../constants.js";
import { AppleDocPage } from "../../types.js";
import { assertAllowedUrl } from "../safe-fetch.js";
import axios, { AxiosError } from "axios";
import { docJsonUrl } from "./paths.js";

// Re-validate every redirect target (scheme + host allowlist) — matching the
// safe-fetch clients used by the newer surfaces. maxRedirects caps the chain
// length; this guard ensures a 3xx can't hop the fetch to a non-allowlisted
// host (or downgrade to http) partway through the chain.
export function makeRedirectGuard(allowedHosts: readonly string[]) {
  return (options: { href?: string; protocol?: string; host?: string; hostname?: string; path?: string }) => {
    const href =
      options.href ??
      `${options.protocol ?? "https:"}//${options.host ?? options.hostname ?? ""}${options.path ?? ""}`;
    assertAllowedUrl(href, allowedHosts); // throws → aborts the redirect
  };
}

export function createDocsHttpClient(maxBytes: number, allowedHosts: readonly string[]) {
  return axios.create({
    timeout: REQUEST_TIMEOUT_MS,
    maxContentLength: maxBytes, // RED-201
    maxBodyLength: maxBytes,    // RED-201
    maxRedirects: 3, // Limit redirects to prevent redirect-chain SSRF
    beforeRedirect: makeRedirectGuard(allowedHosts),
    headers: {
      Accept: "application/json",
      "User-Agent": "apple-docs-mcp-server/1.0",
    },
  });
}

// The page/global-search client reaches both the docs origin and the global
// search host; the index client only ever reaches the docs origin.
export const httpClient = createDocsHttpClient(10 * 1024 * 1024, [APPLE_DEV_HOST, APPLE_GLOBAL_SEARCH_HOST]);

 // 10MB — a single doc page

// Framework navigator-index payloads are much larger than a single doc page
// (Foundation's is ~6.6MB) — a dedicated client keeps that headroom off the
// normal per-page fetch path.
export const indexHttpClient = createDocsHttpClient(20 * 1024 * 1024, [APPLE_DEV_HOST]);

// In-flight request deduplication: avoid fetching the same URL concurrently
// (e.g., during parallel search where multiple workers request the same child page)
export const inflightRequests = new Map<string, Promise<AppleDocPage>>();

export function rawFetchDocPage(normalizedPath: string): Promise<AppleDocPage> {
  const existing = inflightRequests.get(normalizedPath);
  if (existing) return existing;

  const url = docJsonUrl(normalizedPath);
  const promise = httpClient.get<AppleDocPage>(url).then((response) => {
    const data = response.data;
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

export function wrapFetchError(error: unknown, path: string): Error {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    if (status === 404) {
      return new Error(
        `Documentation page not found for path "${path}". ` +
          `Check the path matches a valid Apple documentation URL (e.g. "swiftui/view", "swift/array", "foundation"). ` +
          `You can use apple_docs_list_technologies to discover framework names, or ` +
          `apple_docs_find_symbol to locate a symbol across all frameworks.`
      );
    }
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
