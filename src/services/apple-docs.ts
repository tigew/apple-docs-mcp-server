/**
 * Apple Developer Documentation API client and parsing utilities.
 *
 * Apple exposes a public (unofficial) JSON API at:
 *   https://developer.apple.com/tutorials/data/documentation/{path}.json
 *
 * This mirrors the URL path structure of developer.apple.com/documentation/{path}
 */

import axios, { AxiosError } from "axios";
import {
  AppleDocGroup,
  AppleDocPage,
  AppleDocSection,
  AppleDocTechnologyEntry,
  AppleDocInlineContent,
  AppleDocContentItem,
  AppleDocFragment,
  AppleDocReference,
  AppleDocParameter,
  ParsedSymbol,
  ParsedTechnologies,
  SearchResult,
} from "../types.js";
import { APPLE_DOCS_BASE_URL, APPLE_DOCS_WEB_BASE, REQUEST_TIMEOUT_MS } from "../constants.js";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const httpClient = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  maxContentLength: 10 * 1024 * 1024, // 10MB - RED-201
  maxBodyLength: 10 * 1024 * 1024,    // 10MB - RED-201
  maxRedirects: 3, // Limit redirects to prevent redirect-chain SSRF
  headers: {
    Accept: "application/json",
    "User-Agent": "apple-docs-mcp-server/1.0",
  },
});

const SEARCH_CHILD_PAGE_LIMIT = 60;
const SEARCH_DIRECT_MATCH_LIMIT = 12;
const SEARCH_CONCURRENCY_LIMIT = 8;
const MAX_RECURSION_DEPTH = 40;

// ---------------------------------------------------------------------------
// Concurrency limiter for search fetches (BUG-1 fix)
// ---------------------------------------------------------------------------

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Page cache (simple TTL to avoid redundant fetches)
// ---------------------------------------------------------------------------

const PAGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PAGE_CACHE_MAX_SIZE = 100;

interface CachedPage {
  page: AppleDocPage;
  expiresAt: number;
}

const pageCache = new Map<string, CachedPage>();

// Proactive cache cleanup: purge expired entries periodically to prevent
// stale accumulation when entries are never re-accessed
const CACHE_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pageCache) {
    if (now > entry.expiresAt) {
      pageCache.delete(key);
    }
  }
}, CACHE_CLEANUP_INTERVAL_MS).unref(); // unref so it doesn't keep the process alive

function getCachedPage(normalizedPath: string): AppleDocPage | undefined {
  const entry = pageCache.get(normalizedPath);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    pageCache.delete(normalizedPath);
    return undefined;
  }
  // LRU: move to end by re-inserting (Map preserves insertion order)
  pageCache.delete(normalizedPath);
  pageCache.set(normalizedPath, entry);
  return entry.page;
}

function setCachedPage(normalizedPath: string, page: AppleDocPage): void {
  // If already present, delete first so re-insert moves it to the end (LRU)
  if (pageCache.has(normalizedPath)) {
    pageCache.delete(normalizedPath);
  }
  // Evict least-recently-used (first entry) if at capacity
  if (pageCache.size >= PAGE_CACHE_MAX_SIZE) {
    const firstKey = pageCache.keys().next().value;
    if (firstKey !== undefined) pageCache.delete(firstKey);
  }
  pageCache.set(normalizedPath, { page, expiresAt: Date.now() + PAGE_CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Path utilities (unified — fixes BUG-9 divergent stripping)
// ---------------------------------------------------------------------------

function stripDocPrefix(url: string): string {
  return url
    .replace(/^doc:\/\/[^/]*\/documentation\//i, "")
    .replace(/^https?:\/\/developer\.apple\.com/i, "")
    .replace(/^\/+documentation\//i, "")
    .replace(/^documentation\//i, "");
}

function extractPathFromDocUrl(url: string): string {
  // Use pathFromDocUrl which handles doc://, https://, and /documentation/ prefixes
  const resolved = pathFromDocUrl(url);
  if (resolved) return resolved;
  // Fallback: strip /documentation/ prefix and normalize
  const raw = url.replace(/^\/documentation\//i, "").toLowerCase();
  try {
    return normalizePath(raw);
  } catch {
    return raw;
  }
}

function buildWebUrl(path: string): string {
  return `${APPLE_DOCS_WEB_BASE}/${path}`;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

// In-flight request deduplication: avoid fetching the same URL concurrently
// (e.g., during parallel search where multiple workers request the same child page)
const inflightRequests = new Map<string, Promise<AppleDocPage>>();

function rawFetchDocPage(normalizedPath: string): Promise<AppleDocPage> {
  const existing = inflightRequests.get(normalizedPath);
  if (existing) return existing;

  const url = `${APPLE_DOCS_BASE_URL}/documentation/${normalizedPath}.json`;
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

function pathFromDocUrl(url: string | undefined): string | null {
  if (!url) return null;

  // Handle doc:// URIs (e.g. doc://com.apple.SwiftUI/documentation/SwiftUI/View)
  if (/^doc:\/\//i.test(url)) {
    const withoutPrefix = stripDocPrefix(url);
    if (!withoutPrefix) return null;
    try {
      return normalizePath(withoutPrefix);
    } catch {
      return null;
    }
  }

  if (/^https?:\/\//i.test(url) && !/^https?:\/\/developer\.apple\.com/i.test(url)) return null;

  const withoutPrefix = stripDocPrefix(url);
  if (!withoutPrefix) return null;

  try {
    return normalizePath(withoutPrefix);
  } catch {
    return null;
  }
}

function normalizeDocUrl(url: string): string {
  const internalPath = pathFromDocUrl(url);
  if (!internalPath) return url;
  return `/documentation/${internalPath}`;
}

function searchTextForPage(page: AppleDocPage): string {
  return [
    page.metadata?.title,
    page.identifier?.url,
    extractText(page.abstract, page.references),
    extractOverview(page.primaryContentSections, page.references),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function matchesQuery(query: string, ...values: Array<string | undefined>): boolean {
  const lowerQuery = query.trim().toLowerCase();
  if (!lowerQuery) return false;
  return values.some((value) => value?.toLowerCase().includes(lowerQuery));
}

function queryToLikelySlug(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9()_:]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function createSearchResultFromPage(page: AppleDocPage, frameworkPath: string): SearchResult | null {
  const path = pathFromDocUrl(page.identifier?.url);
  if (!path) return null;

  const normalizedFramework = normalizePath(frameworkPath);
  if (!(path === normalizedFramework || path.startsWith(`${normalizedFramework}/`))) {
    return null;
  }

  return {
    title: page.metadata?.title || path.split("/").pop() || path,
    path,
    webUrl: buildWebUrl(path),
    abstract: extractText(page.abstract, page.references),
    kind: page.kind ?? "unknown",
    role: page.metadata?.role ?? "unknown",
  };
}

export function collectDirectMatchPaths(
  page: AppleDocPage,
  frameworkPath: string,
  query: string,
  limit = SEARCH_DIRECT_MATCH_LIMIT
): string[] {
  const normalizedFramework = normalizePath(frameworkPath);
  const matches = new Set<string>();

  for (const ref of Object.values(page.references ?? {})) {
    const path = pathFromDocUrl(ref.url);
    if (!path) continue;
    if (!(path === normalizedFramework || path.startsWith(`${normalizedFramework}/`))) continue;
    if (!matchesQuery(query, ref.title, ref.url, extractText(ref.abstract, page.references))) continue;
    matches.add(path);
    if (matches.size >= limit) break;
  }

  const likelySlug = queryToLikelySlug(query);
  if (likelySlug) {
    matches.add(`${normalizedFramework}/${likelySlug}`);
  }

  return Array.from(matches);
}

export function resolveChildPathFromParentPage(page: AppleDocPage, parentPath: string, unresolvedLeaf: string): string | null {
  const normalizedParent = normalizePath(parentPath);
  const targetLeaf = unresolvedLeaf.trim().toLowerCase();
  if (!targetLeaf) return null;
  const targetKeys = collectLeafLookupKeys(targetLeaf);

  const candidates = Object.values(page.references ?? {})
    .map((ref) => {
      const path = pathFromDocUrl(ref.url);
      if (!path) return null;
      if (!path.startsWith(`${normalizedParent}/`)) return null;
      const leaf = path.split("/").pop() ?? "";
      return {
        path,
        ref,
        leaf,
        leafKeys: collectLeafLookupKeys(leaf),
        titleKeys: collectTitleLookupKeys(ref.title),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  // When multiple candidates match by title, prefer the one without a hash suffix
  // (canonical path) to avoid resolving to deprecated overloads (BUG: flatMap resolved to deprecated)
  const titleMatches = candidates.filter(({ ref }) => (ref.title ?? "").trim().toLowerCase() === targetLeaf);
  if (titleMatches.length === 1) return titleMatches[0].path;
  if (titleMatches.length > 1) {
    // Prefer the candidate whose leaf exactly matches the target (no hash suffix)
    const exactLeafTitle = titleMatches.find(({ leaf }) => leaf === targetLeaf);
    if (exactLeafTitle) return exactLeafTitle.path;
    // Prefer the candidate with the shortest path (fewer disambiguation suffixes)
    const sorted = titleMatches.sort((a, b) => a.path.length - b.path.length);
    return sorted[0].path;
  }

  const exactLeaf = candidates.find(({ leaf }) => leaf === targetLeaf);
  if (exactLeaf) return exactLeaf.path;

  const normalizedMatch = candidates.find(
    ({ leafKeys, titleKeys }) =>
      [...targetKeys].some((key) => leafKeys.has(key) || titleKeys.has(key))
  );
  if (normalizedMatch) return normalizedMatch.path;

  const prefixedLeaf = candidates.find(({ leaf }) => leaf.startsWith(targetLeaf));
  if (prefixedLeaf) return prefixedLeaf.path;

  return null;
}

async function resolvePathOn404(normalizedPath: string): Promise<string | null> {
  const lastSlash = normalizedPath.lastIndexOf("/");
  if (lastSlash <= 0) return null;

  const parentPath = normalizedPath.slice(0, lastSlash);
  const unresolvedLeaf = normalizedPath.slice(lastSlash + 1);

  try {
    const parentPage = await rawFetchDocPage(parentPath);
    const resolved = resolveChildPathFromParentPage(parentPage, parentPath, unresolvedLeaf);
    if (resolved) return resolved;
  } catch {
    // Parent page fetch failed — fall through to heuristic attempts below
  }

  // For inherited symbols (e.g. Array.map(_:) inherited from Sequence),
  // the parent page may not list the symbol at all. Try heuristic slug-based
  // lookups with common hash suffixes by probing the API directly.
  const likelySlug = queryToLikelySlug(unresolvedLeaf);
  if (likelySlug && likelySlug !== unresolvedLeaf) {
    const heuristicPath = `${parentPath}/${likelySlug}`;
    try {
      await rawFetchDocPage(heuristicPath);
      return heuristicPath;
    } catch {
      // Heuristic path didn't work either
    }
  }

  return null;
}

/**
 * Fetch a documentation page from Apple's CDN.
 * @param path - The path portion after /documentation/ (e.g. "swiftui/view")
 */
export async function fetchDocPage(path: string): Promise<AppleDocPage> {
  const normalizedPath = normalizePath(path);

  // Check cache first
  const cached = getCachedPage(normalizedPath);
  if (cached) return cached;

  try {
    const page = await rawFetchDocPage(normalizedPath);
    setCachedPage(normalizedPath, page);
    return page;
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 404) {
      const resolvedPath = await resolvePathOn404(normalizedPath);
      if (resolvedPath && resolvedPath !== normalizedPath) {
        try {
          const page = await rawFetchDocPage(resolvedPath);
          setCachedPage(resolvedPath, page);
          setCachedPage(normalizedPath, page); // cache alias → resolved page too
          return page;
        } catch (retryError) {
          throw wrapFetchError(retryError, path);
        }
      }
    }
    throw wrapFetchError(error, path);
  }
}

function stripLeafDisambiguation(leaf: string): string {
  let normalized = leaf.trim().toLowerCase();
  if (!normalized) return normalized;

  normalized = normalized.replace(/-(swift|objc|c|cpp)\.[a-z0-9._-]+$/i, "");

  // Only strip opaque suffixes that look like Apple's hex hashes (4-5 lowercase alnum)
  // and only when the prefix contains Swift symbol chars like () or :
  const opaqueSuffixMatch = normalized.match(/^(.*)-([a-z0-9]{4,5})$/);
  if (opaqueSuffixMatch) {
    const prefix = opaqueSuffixMatch[1];
    if (prefix && /[().:+!=<>]/.test(prefix)) {
      normalized = prefix;
    }
  }

  return normalized;
}

function collectLeafLookupKeys(value: string): Set<string> {
  const raw = value.trim().toLowerCase();
  const keys = new Set<string>();
  if (!raw) return keys;

  keys.add(raw);
  keys.add(stripLeafDisambiguation(raw));
  return keys;
}

function collectTitleLookupKeys(title: string | undefined): Set<string> {
  const normalized = title?.trim().toLowerCase();
  const keys = new Set<string>();
  if (!normalized) return keys;

  keys.add(normalized);
  keys.add(queryToLikelySlug(normalized));
  return keys;
}

function canonicalSearchStem(path: string): string {
  const segments = path.split("/");
  const leaf = segments.pop() ?? path;
  segments.push(stripLeafDisambiguation(leaf));
  return segments.join("/");
}

function searchResultPenalty(path: string): number {
  const leaf = path.split("/").pop() ?? path;
  return leaf === stripLeafDisambiguation(leaf) ? 0 : 1;
}

function preferSearchResult(candidate: SearchResult, existing: SearchResult): SearchResult {
  const candidatePenalty = searchResultPenalty(candidate.path);
  const existingPenalty = searchResultPenalty(existing.path);
  if (candidatePenalty !== existingPenalty) {
    return candidatePenalty < existingPenalty ? candidate : existing;
  }

  if (candidate.path.length !== existing.path.length) {
    return candidate.path.length < existing.path.length ? candidate : existing;
  }

  return candidate.path.localeCompare(existing.path) <= 0 ? candidate : existing;
}

export function dedupeSearchResults(results: SearchResult[]): SearchResult[] {
  const deduped = new Map<string, SearchResult>();

  for (const result of results) {
    const key = [
      canonicalSearchStem(result.path),
      result.title.trim().toLowerCase(),
      result.kind.trim().toLowerCase(),
      result.role.trim().toLowerCase(),
    ].join("\u0000");
    const existing = deduped.get(key);
    deduped.set(key, existing ? preferSearchResult(result, existing) : result);
  }

  return Array.from(deduped.values());
}

export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error("Invalid path: must not be empty.");
  }

  // Reject non-Apple HTTP URLs (SEC-011: anchor to hostname boundary to prevent subdomain bypass)
  if (/^https?:\/\//i.test(trimmed) && !/^https?:\/\/developer\.apple\.com(\/|$)/i.test(trimmed)) {
    throw new Error(
      `Invalid path "${path}": only developer.apple.com documentation URLs are supported.`
    );
  }

  // Reject dangerous URI schemes (data:, javascript:, ftp:, etc.)
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed) && !/^doc:\/\//i.test(trimmed)) {
    throw new Error(
      `Invalid path "${path}": unsupported URI scheme.`
    );
  }

  // RED-218: Reject paths containing control characters (codepoint < 0x20 or 0x7F-0x9F)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F-\x9F]/.test(trimmed)) {
    throw new Error(`Invalid path: contains control characters.`);
  }

  // Strip zero-width characters that could be used to bypass validation or confuse matching
  // U+200B (zero-width space), U+200C/D (zero-width non-joiner/joiner), U+FEFF (BOM), U+200E/F (LTR/RTL marks)
  if (/[\u200B\u200C\u200D\uFEFF\u200E\u200F\u2060\u2061\u2062\u2063\u2064]/.test(trimmed)) {
    throw new Error(`Invalid path: contains invisible Unicode characters.`);
  }

  // RED-202: Decode URL-encoded sequences before checking for traversal
  // Decode iteratively to catch double-encoding (BUG-15 fix)
  let decoded = trimmed;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      if (i === 0) {
        throw new Error(`Invalid path "${path}": contains malformed percent-encoding.`);
      }
      break;
    }
  }

  // Re-check for control characters after decoding (encoded control chars)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F-\x9F]/.test(decoded)) {
    throw new Error(`Invalid path: contains control characters (after decoding).`);
  }

  // Accept full Apple docs URLs, doc:// URIs, and /documentation/... inputs.
  const withoutPrefix = stripDocPrefix(decoded).replace(/[?#].*$/, "");

  // Strip leading slash, trailing slash, duplicate slashes, and .json suffix.
  const normalized = withoutPrefix
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\.json$/i, "")
    .toLowerCase();

  // RED-007: Reject path traversal attempts (checked after decoding)
  if (normalized.includes("..")) {
    throw new Error(`Invalid path "${path}": path traversal ("..") is not allowed.`);
  }

  // Reject paths with URL-unsafe characters that could alter request semantics
  if (/[@;,]/.test(normalized)) {
    throw new Error(`Invalid path "${path}": contains characters that are not allowed in documentation paths.`);
  }

  if (!normalized) {
    throw new Error(`Invalid path "${path}": no documentation path remained after normalization.`);
  }
  return normalized;
}

function wrapFetchError(error: unknown, path: string): Error {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    if (status === 404) {
      return new Error(
        `Documentation page not found for path "${path}". ` +
          `Check the path matches a valid Apple documentation URL (e.g. "swiftui/view", "swift/array", "foundation"). ` +
          `You can use apple_docs_list_technologies to discover framework names.`
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

function resolveReferenceItems(
  identifiers: string[] | undefined,
  references: Record<string, AppleDocReference> | undefined
): ParsedSymbol["topicSections"][number]["items"] {
  if (!identifiers?.length || !references) return [];

  return identifiers
    .map((id) => {
      const ref = Object.prototype.hasOwnProperty.call(references, id) ? references[id] : undefined;
      if (!ref) return null;
      const refPath = pathFromDocUrl(ref.url);
      return {
        title: ref.title ?? id,
        path: refPath ?? (ref.url ?? ""),
        abstract: extractText(ref.abstract, references),
        kind: ref.kind ?? "unknown",
        role: ref.role ?? "unknown",
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

function markdownTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n+/g, "<br>").trim();
}

function extractTechnologyItem(
  technology: AppleDocTechnologyEntry,
  references: Record<string, AppleDocReference> | undefined
): ParsedTechnologies["sections"][number]["technologies"][number] | null {
  const destinationId = technology.destination?.identifier;
  const ref = destinationId && references
    ? (Object.prototype.hasOwnProperty.call(references, destinationId) ? references[destinationId] : undefined)
    : undefined;
  const abstract =
    extractText(ref?.abstract, references) ||
    extractText(technology.content, references);

  const url =
    ref?.url ??
    (destinationId && /^https?:\/\//i.test(destinationId) ? destinationId : "");

  const title = ref?.title ?? technology.title ?? destinationId;
  if (!title || !url) return null;

  return {
    title,
    url: normalizeDocUrl(url),
    abstract,
    role: ref?.role ?? "collection",
  };
}

function extractTechnologySectionFromGroup(
  group: AppleDocGroup,
  references: Record<string, AppleDocReference> | undefined
): ParsedTechnologies["sections"][number] | null {
  const deduped = new Map<string, ParsedTechnologies["sections"][number]["technologies"][number]>();

  for (const technology of group.technologies ?? []) {
    const item = extractTechnologyItem(technology, references);
    if (!item) continue;
    deduped.set(item.url.toLowerCase(), item);
  }

  for (const identifier of group.identifiers ?? []) {
    const ref = references && Object.prototype.hasOwnProperty.call(references, identifier)
      ? references[identifier]
      : undefined;
    if (!ref?.url) continue;
      deduped.set(ref.url.toLowerCase(), {
        title: ref.title ?? identifier,
        url: normalizeDocUrl(ref.url),
        abstract: extractText(ref.abstract, references),
        role: ref.role ?? "collection",
      });
  }

  const technologies = Array.from(deduped.values());
  if (technologies.length === 0) return null;

  return {
    title: group.name ?? "Technologies",
    technologies,
  };
}

export function collectSearchPagePaths(page: AppleDocPage, frameworkPath: string, limit = SEARCH_CHILD_PAGE_LIMIT): string[] {
  const normalizedFramework = normalizePath(frameworkPath);
  const childPages = new Set<string>();

  for (const ref of Object.values(page.references ?? {})) {
    if (!ref.url) continue;
    const path = pathFromDocUrl(ref.url);
    if (!path) continue;
    if (!(path === normalizedFramework || path.startsWith(`${normalizedFramework}/`))) continue;
    if (!["collectionGroup", "collection", "article"].includes(ref.role ?? "")) continue;

    if (path !== normalizedFramework) {
      childPages.add(path);
    }

    if (childPages.size >= limit) break;
  }

  return Array.from(childPages);
}

export function searchReferencesInPage(
  page: AppleDocPage,
  query: string,
  frameworkPath: string
): SearchResult[] {
  const lowerQuery = query.toLowerCase();
  const normalizedFramework = normalizePath(frameworkPath);
  const results: SearchResult[] = [];

  for (const [, ref] of Object.entries(page.references ?? {})) {
    if (!ref.url || !ref.title) continue;
    if (ref.type !== "topic") continue;
    const path = pathFromDocUrl(ref.url);
    if (!path) continue;
    if (!(path === normalizedFramework || path.startsWith(`${normalizedFramework}/`))) continue;

    const titleMatch = ref.title.toLowerCase().includes(lowerQuery);
    const abstractText = extractText(ref.abstract, page.references);
    const abstractMatch = abstractText.toLowerCase().includes(lowerQuery);

    if (titleMatch || abstractMatch) {
      results.push({
        title: ref.title,
        path,
        webUrl: buildWebUrl(path),
        abstract: abstractText,
        kind: ref.kind ?? "unknown",
        role: ref.role ?? "unknown",
      });
    }
  }

  return results;
}

function searchResultScore(result: SearchResult, lowerQuery: string): number {
  const lowerTitle = result.title.toLowerCase();
  // Exact title match gets highest priority
  if (lowerTitle === lowerQuery) return 0;
  // Title starts with query
  if (lowerTitle.startsWith(lowerQuery)) return 1;
  // Title contains query at a word/symbol boundary (\\b doesn't work well with Swift
  // symbols like "map(_:)" since parens aren't word characters — use lookahead for
  // start-of-string or non-alphanumeric preceding character instead)
  const escaped = lowerQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:^|[^a-zA-Z0-9_])${escaped}`, "i").test(result.title)) return 2;
  // Title contains query anywhere
  if (lowerTitle.includes(lowerQuery)) return 3;
  // Abstract match only
  return 4;
}

function sortSearchResults(results: SearchResult[], query: string): SearchResult[] {
  const lowerQuery = query.toLowerCase();
  return results.sort((a, b) => {
    const aScore = searchResultScore(a, lowerQuery);
    const bScore = searchResultScore(b, lowerQuery);
    if (aScore !== bScore) return aScore - bScore;
    // Prefer shorter paths (closer to framework root = more important)
    const aDepth = a.path.split("/").length;
    const bDepth = b.path.split("/").length;
    if (aDepth !== bDepth) return aDepth - bDepth;
    return a.title.localeCompare(b.title);
  });
}

// ---------------------------------------------------------------------------
// Inline content / text extraction
// ---------------------------------------------------------------------------

export function extractText(
  content: AppleDocInlineContent[] | undefined,
  references?: Record<string, AppleDocReference>,
  depth = 0
): string {
  if (!content || depth > MAX_RECURSION_DEPTH) return "";
  return content
    .map((item) => {
      if (item.type === "text") return item.text ?? "";
      if (item.type === "codeVoice") return `\`${item.code ?? ""}\``;
      if (item.type === "emphasis") {
        const inner = extractText(item.inlineContent as AppleDocInlineContent[] | undefined, references, depth + 1);
        return inner ? `*${inner}*` : "";
      }
      if (item.type === "strong") {
        const inner = extractText(item.inlineContent as AppleDocInlineContent[] | undefined, references, depth + 1);
        return inner ? `**${inner}**` : "";
      }
      if (item.type === "strikethrough") {
        const inner = extractText(item.inlineContent as AppleDocInlineContent[] | undefined, references, depth + 1);
        return inner ? `~~${inner}~~` : "";
      }
      if (item.type === "subscript") {
        const inner = extractText(item.inlineContent as AppleDocInlineContent[] | undefined, references, depth + 1);
        return inner ? `<sub>${inner}</sub>` : "";
      }
      if (item.type === "superscript") {
        const inner = extractText(item.inlineContent as AppleDocInlineContent[] | undefined, references, depth + 1);
        return inner ? `<sup>${inner}</sup>` : "";
      }
      if (item.type === "newTerm") return `*${item.text ?? ""}*`;
      if (item.type === "link") {
        if (item.title && item.destination) return `[${item.title}](${item.destination})`;
        return item.destination ?? item.title ?? "";
      }
      if (item.type === "image") {
        const imgId = item.identifier ?? "";
        if (references && imgId && Object.prototype.hasOwnProperty.call(references, imgId)) {
          const imgRef = references[imgId];
          const alt = imgRef.alt ?? "Image";
          const variants = imgRef.variants;
          const url = variants?.[0]?.url ?? "";
          return url ? `![${alt}](${url})` : `[${alt}]`;
        }
        return "[Image]";
      }
      if (item.type === "reference") {
        const id = item.identifier ?? "";
        if (references && Object.prototype.hasOwnProperty.call(references, id) && references[id]?.title) {
          return references[id].title!;
        }
        const lastSegment = id.split("/").pop();
        return lastSegment ?? id;
      }
      // Fallback: try to extract text from inlineContent for unknown types
      if (item.inlineContent) {
        return extractText(item.inlineContent as AppleDocInlineContent[] | undefined, references, depth + 1);
      }
      return item.text ?? "";
    })
    .join("")
    .trim();
}

export function extractDeclaration(
  sections: AppleDocPage["primaryContentSections"]
): string {
  if (!sections) return "";

  const declarationSection = sections.find((s) => s.kind === "declarations");
  if (!declarationSection?.declarations?.length) return "";

  // Prefer Swift declaration
  const swiftDecl =
    declarationSection.declarations.find((d) => d.languages?.includes("swift")) ??
    declarationSection.declarations[0];

  if (!swiftDecl?.tokens) return "";

  return swiftDecl.tokens
    .map((token: AppleDocFragment) => token.text ?? "")
    .join("")
    .trim();
}

export function extractOverview(
  sections: AppleDocPage["primaryContentSections"],
  references?: Record<string, AppleDocReference>
): string {
  if (!sections) return "";

  const contentSection = sections.find((s) => s.kind === "content");
  if (!contentSection?.content) return "";

  const lines: string[] = [];

  function processItems(items: AppleDocContentItem[], targetLines: string[], depth = 0): void {
    if (depth > MAX_RECURSION_DEPTH) return;
    if (!items || !Array.isArray(items)) return;

    for (const item of items) {
      if (item.type === "heading") {
        const level = Math.max(1, Math.min(6, item.level ?? 2));
        const headingText = item.text ?? extractText(item.inlineContent, references) ?? "";
        if (headingText) {
          targetLines.push(`${"#".repeat(level)} ${headingText}\n`);
        }
      } else if (item.type === "paragraph") {
        const text = extractText(item.inlineContent, references);
        if (text) targetLines.push(`${text}\n`);
      } else if (item.type === "codeListing") {
        const syntax = item.syntax ?? "";
        const codeLines = (item.code ?? []).join("\n");
        targetLines.push(`\`\`\`${syntax}\n${codeLines}\n\`\`\`\n`);
      } else if (item.type === "aside") {
        const style = item.style ? `**[${item.style.toUpperCase()}]** ` : "";
        if (item.content) {
          const innerLines: string[] = [];
          processItems(item.content, innerLines, depth + 1);
          if (innerLines.length) {
            const combined = innerLines.map((l, i) => {
              const prefix = i === 0 ? style : "";
              return `> ${prefix}${l}`;
            }).join("");
            targetLines.push(`${combined}\n`);
          }
        }
      } else if (item.type === "table") {
        if (item.rows && Array.isArray(item.rows) && item.rows.length > 0) {
          const renderedRows: string[][] = [];
          for (const row of item.rows) {
            if (!row?.cells || !Array.isArray(row.cells)) continue;
            const cells: string[] = [];
            for (const cell of row.cells) {
              if (cell.content) {
                const cellLines: string[] = [];
                processItems(cell.content, cellLines, depth + 1);
                cells.push(cellLines.map((l) => l.replace(/\n$/, "")).join(" "));
              } else {
                cells.push("");
              }
            }
            renderedRows.push(cells);
          }
          const colCount = renderedRows.reduce((max, r) => Math.max(max, r.length), 1);
          if (item.header === "row" && renderedRows.length > 0) {
            const headerRow = renderedRows[0].map((cell) => markdownTableCell(cell || " "));
            while (headerRow.length < colCount) headerRow.push(" ");
            targetLines.push(`| ${headerRow.join(" | ")} |\n`);
            targetLines.push(`| ${Array(colCount).fill("---").join(" | ")} |\n`);
            for (const row of renderedRows.slice(1)) {
              while (row.length < colCount) row.push("");
              targetLines.push(`| ${row.map((cell) => markdownTableCell(cell)).join(" | ")} |\n`);
            }
          } else {
            targetLines.push(`| ${Array(colCount).fill(" ").join(" | ")} |\n`);
            targetLines.push(`| ${Array(colCount).fill("---").join(" | ")} |\n`);
            for (const row of renderedRows) {
              while (row.length < colCount) row.push("");
              targetLines.push(`| ${row.map((cell) => markdownTableCell(cell)).join(" | ")} |\n`);
            }
          }
          targetLines.push("\n");
        }
      } else if (item.type === "termList") {
        const terms = (item.items ?? []) as Array<{
          term?: { inlineContent?: AppleDocInlineContent[] };
          definition?: { content?: AppleDocContentItem[] };
        }>;
        for (const entry of terms) {
          const termText = entry.term ? extractText(entry.term.inlineContent, references) : "";
          if (termText) {
            targetLines.push(`**${termText}**\n`);
          }
          if (entry.definition?.content) {
            const defLines: string[] = [];
            processItems(entry.definition.content as AppleDocContentItem[], defLines, depth + 1);
            for (const dl of defLines) {
              targetLines.push(dl);
            }
          }
          targetLines.push("\n");
        }
      } else if (item.type === "unorderedList" || item.type === "orderedList") {
        const listItems = (item.items ?? []) as AppleDocContentItem[];
        listItems.forEach((listItem, index) => {
          const bullet = item.type === "orderedList" ? `${index + 1}. ` : "- ";
          if (listItem.content) {
            const innerLines: string[] = [];
            processItems(listItem.content as AppleDocContentItem[], innerLines, depth + 1);
            const text = innerLines.map((l) => l.replace(/\n$/, "")).join(" ");
            if (text) targetLines.push(`${bullet}${text}\n`);
          }
        });
      } else if (item.type === "links") {
        // Handle links blocks (curated link lists)
        const linkItems = item.items;
        if (linkItems && Array.isArray(linkItems) && references) {
          for (const rawLinkId of linkItems) {
            if (typeof rawLinkId !== "string") continue;
            const linkId = rawLinkId;
            if (Object.prototype.hasOwnProperty.call(references, linkId)) {
              const linkRef = references[linkId];
              const title = linkRef.title ?? linkId.split("/").pop() ?? linkId;
              const abstract = extractText(linkRef.abstract, references);
              const suffix = abstract ? ` — ${abstract}` : "";
              targetLines.push(`- **${title}**${suffix}\n`);
            }
          }
        }
      } else if (item.type === "row" || item.type === "tabNavigator") {
        // Layout containers: recurse into any nested content
        if (item.content) {
          processItems(item.content as AppleDocContentItem[], targetLines, depth + 1);
        }
        if (item.items && Array.isArray(item.items)) {
          for (const child of item.items) {
            if (child && typeof child === "object" && "content" in child) {
              processItems((child as { content: AppleDocContentItem[] }).content, targetLines, depth + 1);
            }
          }
        }
      }
    }
  }

  processItems(contentSection.content as AppleDocContentItem[], lines);

  // RED-009: Remove trailing empty headings (headings with no content following)
  while (lines.length > 0 && /^#{1,6} .+\n$/.test(lines[lines.length - 1])) {
    lines.pop();
  }

  return lines.join("\n").trim();
}

export function extractParameters(
  sections: AppleDocPage["primaryContentSections"],
  references?: Record<string, AppleDocReference>
): Array<{ name: string; description: string }> | undefined {
  if (!sections) return undefined;

  const paramSection = sections.find((s) => s.kind === "parameters");
  if (!paramSection?.parameters?.length) return undefined;

  const params = paramSection.parameters
    .map((p: AppleDocParameter) => ({
      name: p.name,
      description: (p.content ?? [])
        .filter((item) => item.type === "paragraph" && item.inlineContent)
        .map((item) => extractText(item.inlineContent, references))
        .filter(Boolean)
        .join(" "),
    }))
    .filter((p) => p.name);

  return params.length > 0 ? params : undefined;
}

function extractBreadcrumb(
  hierarchy: AppleDocPage["hierarchy"],
  references?: Record<string, AppleDocReference>
): string[] | undefined {
  if (!hierarchy?.paths?.length) return undefined;
  const path = hierarchy.paths[0];
  if (!path?.length) return undefined;

  const crumbs = path
    .map((id) => {
      if (!references || !Object.prototype.hasOwnProperty.call(references, id)) {
        return id.split("/").pop() ?? id;
      }
      return references[id].title ?? id.split("/").pop() ?? id;
    })
    .filter((c) => c && c !== "Technologies");

  return crumbs.length > 0 ? crumbs : undefined;
}

function extractDeprecationInfo(metadata: AppleDocPage["metadata"]): {
  deprecated: boolean;
  deprecatedAt?: string;
  deprecationMessage?: string;
} {
  const plats = metadata?.platforms ?? [];
  const deprecatedPlatforms = plats.filter((p) => p.deprecated || p.deprecatedAt);
  if (deprecatedPlatforms.length === 0) return { deprecated: false };

  // If all platforms are deprecated, mark the whole symbol as deprecated
  const allDeprecated = plats.length > 0 && deprecatedPlatforms.length === plats.length;

  // Find the earliest deprecation version for display
  const deprecatedAt = deprecatedPlatforms
    .filter((p) => p.deprecatedAt)
    .map((p) => `${p.name} ${p.deprecatedAt}`)
    .join(", ");

  // Extract deprecation message or renamed info if available
  const messageEntries = deprecatedPlatforms
    .filter((p) => p.message || p.renamed)
    .map((p) => p.renamed ? `Use ${p.renamed} instead.` : p.message!);
  // Dedupe messages (often the same across platforms)
  const uniqueMessages = [...new Set(messageEntries)];
  const deprecationMessage = uniqueMessages.length > 0 ? uniqueMessages.join(" ") : undefined;

  return {
    deprecated: allDeprecated,
    deprecatedAt: deprecatedAt || undefined,
    deprecationMessage,
  };
}

// ---------------------------------------------------------------------------
// Parsers for specific response shapes
// ---------------------------------------------------------------------------

export function parseDocPage(page: AppleDocPage, path: string): ParsedSymbol {
  const meta = page.metadata ?? {};
  const title = meta.title || page.identifier?.url || path;
  const kind = page.kind ?? "unknown";
  const role = meta.role ?? "unknown";
  const canonicalPath = pathFromDocUrl(page.identifier?.url) ?? normalizePath(path);

  const refs = page.references;
  const abstract = extractText(page.abstract, refs);
  const declaration = extractDeclaration(page.primaryContentSections);
  const overview = extractOverview(page.primaryContentSections, refs);
  const parameters = extractParameters(page.primaryContentSections, refs);
  const breadcrumb = extractBreadcrumb(page.hierarchy, refs);
  const deprecation = extractDeprecationInfo(meta);

  const platforms = meta.platforms ?? [];

  // Build topic sections with resolved reference titles/abstracts
  const topicSections = (page.topicSections ?? []).map((section) => ({
    title: section.title,
    items: resolveReferenceItems(section.identifiers, refs),
  }));

  // Build relationships
  const relationships = (page.relationshipsSections ?? []).map((section) => ({
    title: section.title,
    type: section.type,
    items: (section.identifiers ?? []).map((id) => {
      const ref = page.references && Object.prototype.hasOwnProperty.call(page.references, id) ? page.references[id] : undefined;
      const refPath = pathFromDocUrl(ref?.url);
      return {
        title: ref?.title ?? id,
        path: refPath ?? (ref?.url ?? ""),
      };
    }),
  }));

  // Parse seeAlsoSections
  const seeAlsoSections = (page.seeAlsoSections ?? []).map((section) => ({
    title: section.title,
    items: resolveReferenceItems(section.identifiers, refs),
  }));

  const webUrl = buildWebUrl(canonicalPath);

  const moduleName = meta.modules?.[0]?.name;

  return {
    title,
    kind,
    role,
    roleHeading: meta.roleHeading || undefined,
    symbolKind: meta.symbolKind || undefined,
    module: moduleName || undefined,
    abstract,
    declaration: declaration || undefined,
    parameters,
    platforms,
    deprecated: deprecation.deprecated || undefined,
    deprecatedAt: deprecation.deprecatedAt || undefined,
    deprecationMessage: deprecation.deprecationMessage || undefined,
    breadcrumb,
    path: canonicalPath,
    webUrl,
    topicSections,
    relationships,
    seeAlsoSections,
    overview,
  };
}

export function parseTechnologies(page: AppleDocPage): ParsedTechnologies {
  const sections: ParsedTechnologies["sections"] = [];

  const pageSections: AppleDocSection[] | undefined = page.sections;

  if (pageSections && pageSections.length > 0) {
    for (const section of pageSections) {
      if (section.groups && section.groups.length > 0) {
        for (const group of section.groups) {
          const parsedGroup = extractTechnologySectionFromGroup(group, page.references);
          if (parsedGroup) {
            sections.push(parsedGroup);
          }
        }
        continue;
      }

      const fallbackGroup = extractTechnologySectionFromGroup(
        {
          name: section.title,
          identifiers: section.identifiers,
        },
        page.references
      );
      if (fallbackGroup) {
        sections.push(fallbackGroup);
      }
    }
  } else {
    // Fallback to topicSections for non-technologies pages
    for (const section of page.topicSections ?? []) {
      const techs = section.identifiers
        .map((id) => {
          const ref = page.references && Object.prototype.hasOwnProperty.call(page.references, id) ? page.references[id] : undefined;
          if (!ref) return null;
          return {
            title: ref.title ?? id,
            url: ref.url ? normalizeDocUrl(ref.url) : "",
            abstract: extractText(ref.abstract, page.references),
            role: ref.role ?? "collection",
          };
        })
        .filter((t): t is NonNullable<typeof t> => t !== null);

      if (techs.length > 0) {
        sections.push({ title: section.title, technologies: techs });
      }
    }
  }

  return { sections };
}

// ---------------------------------------------------------------------------
// Search: fetch a framework page and text-match through references
// ---------------------------------------------------------------------------

export async function searchFramework(
  frameworkPath: string,
  query: string,
  limit: number
): Promise<SearchResult[]> {
  const page = await fetchDocPage(frameworkPath);

  const merged = new Map<string, SearchResult>();
  const rootPageMatch = createSearchResultFromPage(page, frameworkPath);
  if (rootPageMatch && matchesQuery(query, rootPageMatch.title, rootPageMatch.path, rootPageMatch.abstract, searchTextForPage(page))) {
    merged.set(rootPageMatch.path.toLowerCase(), rootPageMatch);
  }

  for (const result of searchReferencesInPage(page, query, frameworkPath)) {
    merged.set(result.path.toLowerCase(), result);
  }

  // Fast path: if root page references already yield enough results, skip child-page fetches
  const directResults = dedupeSearchResults(Array.from(merged.values()));
  if (directResults.length >= limit) {
    return sortSearchResults(directResults, query).slice(0, limit);
  }

  // Collect seed paths from direct matches, child collection pages, and topic section identifiers
  const normalizedFramework = normalizePath(frameworkPath);
  const seedPaths = new Set<string>([
    ...collectDirectMatchPaths(page, frameworkPath, query),
    ...collectSearchPagePaths(page, frameworkPath),
  ]);
  // Also add paths from topicSections identifiers resolved via references
  for (const section of page.topicSections ?? []) {
    for (const id of section.identifiers) {
      const ref = page.references && Object.prototype.hasOwnProperty.call(page.references, id) ? page.references[id] : undefined;
      if (!ref?.url) continue;
      const refPath = pathFromDocUrl(ref.url);
      if (!refPath) continue;
      if (!(refPath === normalizedFramework || refPath.startsWith(`${normalizedFramework}/`))) continue;
      if (refPath !== normalizedFramework) seedPaths.add(refPath);
    }
  }

  // Use rawFetchDocPage in search to avoid 404 resolution doubling requests
  const childPages = await mapWithConcurrency(
    Array.from(seedPaths),
    SEARCH_CONCURRENCY_LIMIT,
    (p) => rawFetchDocPage(p.toLowerCase())
  );

  // Track fetch failures to surface partial errors
  let failedFetches = 0;
  for (const childPage of childPages) {
    if (childPage.status !== "fulfilled") {
      failedFetches++;
      continue;
    }
    const pageResult = createSearchResultFromPage(childPage.value, frameworkPath);
    if (pageResult && matchesQuery(query, pageResult.title, pageResult.path, pageResult.abstract, searchTextForPage(childPage.value))) {
      merged.set(pageResult.path.toLowerCase(), pageResult);
    }
    for (const result of searchReferencesInPage(childPage.value, query, frameworkPath)) {
      merged.set(result.path.toLowerCase(), result);
    }
  }

  // If a significant portion of fetches failed, inject a warning as metadata
  // Reserve one slot for the warning so we don't exceed the caller's limit
  const hasWarning = failedFetches > 0 && failedFetches >= seedPaths.size * 0.5;
  const resultLimit = hasWarning ? Math.max(limit - 1, 0) : limit;
  const results = sortSearchResults(dedupeSearchResults(Array.from(merged.values())), query).slice(0, resultLimit);

  if (hasWarning) {
    results.unshift({
      title: "⚠ Partial results",
      path: "",
      webUrl: "",
      abstract: `${failedFetches} of ${seedPaths.size} sub-page fetches failed. Results may be incomplete — try again if needed.`,
      kind: "warning",
      role: "warning",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatDocPageMarkdown(parsed: ParsedSymbol): string {
  const lines: string[] = [];

  // Deprecation banner at top
  if (parsed.deprecated) {
    let banner = `> **DEPRECATED**${parsed.deprecatedAt ? ` (${parsed.deprecatedAt})` : ""}`;
    if (parsed.deprecationMessage) banner += `\n> ${parsed.deprecationMessage}`;
    lines.push(banner);
    lines.push("");
  }

  lines.push(`# ${parsed.title}`);

  // Metadata line with role heading, module, kind
  const metaParts: string[] = [];
  if (parsed.roleHeading) metaParts.push(parsed.roleHeading);
  else metaParts.push(`${parsed.kind} (${parsed.role})`);
  if (parsed.module) metaParts.push(`Module: ${parsed.module}`);
  lines.push(`**${metaParts.join(" | ")}**`);

  // Breadcrumb
  if (parsed.breadcrumb?.length) {
    lines.push(`**Path**: ${parsed.breadcrumb.join(" > ")} > ${parsed.title}`);
  }

  lines.push(`**URL**: ${parsed.webUrl}`);

  if (parsed.platforms.length > 0) {
    const platformStr = parsed.platforms
      .map((p) => {
        let s = p.name;
        if (p.introducedAt) s += ` ${p.introducedAt}+`;
        if (p.deprecatedAt) s += ` (deprecated ${p.deprecatedAt})`;
        else if (p.deprecated) s += ` (deprecated)`;
        if (p.renamed) s += ` → ${p.renamed}`;
        if (p.beta) s += ` (beta)`;
        return s;
      })
      .join(", ");
    lines.push(`**Platforms**: ${platformStr}`);
  }

  lines.push("");

  if (parsed.abstract) {
    lines.push(`## Overview`);
    lines.push(parsed.abstract);
    lines.push("");
  }

  if (parsed.declaration) {
    lines.push(`## Declaration`);
    lines.push(`\`\`\`swift`);
    lines.push(parsed.declaration);
    lines.push(`\`\`\``);
    lines.push("");
  }

  // Parameters section
  if (parsed.parameters?.length) {
    lines.push(`## Parameters`);
    for (const param of parsed.parameters) {
      const desc = param.description ? ` — ${param.description}` : "";
      lines.push(`- **\`${param.name}\`**${desc}`);
    }
    lines.push("");
  }

  if (parsed.overview) {
    lines.push(`## Documentation`);
    lines.push(parsed.overview);
    lines.push("");
  }

  if (parsed.topicSections.length > 0) {
    lines.push(`## Topics`);
    for (const section of parsed.topicSections) {
      if (section.items.length === 0) continue;
      lines.push(`\n### ${section.title}`);
      for (const item of section.items.slice(0, 20)) {
        const abstract = item.abstract ? ` — ${item.abstract}` : "";
        lines.push(`- **${item.title}** (path: \`${item.path}\`)${abstract}`);
      }
      if (section.items.length > 20) {
        lines.push(`- *(${section.items.length - 20} more items...)*`);
      }
    }
    lines.push("");
  }

  if (parsed.relationships.length > 0) {
    lines.push(`## Relationships`);
    for (const rel of parsed.relationships) {
      lines.push(`\n### ${rel.title}`);
      for (const item of rel.items.slice(0, 15)) {
        lines.push(`- ${item.title} (path: \`${item.path}\`)`);
      }
      if (rel.items.length > 15) {
        lines.push(`- *(${rel.items.length - 15} more...)*`);
      }
    }
    lines.push("");
  }

  if (parsed.seeAlsoSections.length > 0) {
    lines.push(`## See Also`);
    for (const section of parsed.seeAlsoSections) {
      if (section.items.length === 0) continue;
      lines.push(`\n### ${section.title}`);
      for (const item of section.items.slice(0, 20)) {
        const abstract = item.abstract ? ` — ${item.abstract}` : "";
        lines.push(`- **${item.title}** (path: \`${item.path}\`)${abstract}`);
      }
      if (section.items.length > 20) {
        lines.push(`- *(${section.items.length - 20} more items...)*`);
      }
    }
  }

  return lines.join("\n");
}

export function formatTechnologiesMarkdown(parsed: ParsedTechnologies): string {
  const lines: string[] = ["# Apple Developer Technologies", ""];
  for (const section of parsed.sections) {
    lines.push(`## ${section.title}`);
    lines.push("");
    for (const tech of section.technologies) {
      const abstract = tech.abstract ? ` — ${tech.abstract}` : "";
      const path = tech.url.replace(/^\/documentation\//, "");
      lines.push(`- **${tech.title}** (\`${path}\`)${abstract}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function formatSearchResultsMarkdown(
  results: SearchResult[],
  query: string,
  frameworkPath: string
): string {
  if (results.length === 0) {
    return `No results found for "${query}" in framework "${frameworkPath}".`;
  }

  const lines = [
    `# Search Results: "${query}" in ${frameworkPath}`,
    `Found ${results.length} result(s)`,
    "",
  ];

  for (const result of results) {
    lines.push(`## ${result.title}`);
    lines.push(`**Path**: \`${result.path}\` | **Kind**: ${result.kind} | **Role**: ${result.role}`);
    lines.push(`**URL**: ${result.webUrl}`);
    if (result.abstract) lines.push(result.abstract);
    lines.push("");
  }

  return lines.join("\n");
}
