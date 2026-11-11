/**
 * Cached documentation page fetch with 404 recovery.
 */

import { AppleDocPage, PathResolution } from "../../types.js";
import { AxiosError } from "axios";
import { createCache } from "../cache.js";
import { pageNotFoundError, rawFetchDocPage, wrapFetchError } from "./http.js";
import { normalizePath } from "./paths.js";
import { formatNotFoundWithSuggestions, resolvePathOn404, resolvePathSuggestions } from "./resolve.js";

// Documentation changes at most a few times a day, so a fetched page is
// reused for half an hour. The budget is in characters of page JSON.
const PAGE_TTL_MS = 30 * 60 * 1000;
const PAGE_CACHE_MAX_ENTRIES = 300;
const PAGE_CACHE_MAX_SIZE = 32 * 1024 * 1024;

// A path that does not exist costs several requests to establish (the page,
// its parent, the framework index, a cross-framework search), so the answer is
// remembered too — briefly, since the page may yet be published.
const NOT_FOUND_TTL_MS = 10 * 60 * 1000;
const NOT_FOUND_CACHE_MAX_ENTRIES = 500;

/** A page, and the path it really lives at (which differs from its cache key for a recovered alias). */
interface CachedPage {
  page: AppleDocPage;
  resolvedPath: string;
}

/** What recovery found for a path with no page: suggestions, or nothing at all. */
interface NotFound {
  resolution?: PathResolution;
}

export interface ResolvedDocPage {
  page: AppleDocPage;
  /**
   * Set when the requested path does not exist and 404 recovery returned a
   * different page in its place: the (normalized) path that was asked for.
   */
  redirectedFrom?: string;
}

/** Where pages and recovery answers come from; the network in production. */
export interface DocPageSources {
  /** Download the page at a normalized path. Rejects with an AxiosError carrying the HTTP status. */
  fetchPage(normalizedPath: string): Promise<AppleDocPage>;
  /** A path the missing one most likely meant, found on its parent page; null if none. */
  resolveOn404(normalizedPath: string): Promise<string | null>;
  /** Wider recovery: the framework index, then other frameworks. Never rejects. */
  resolveSuggestions(normalizedPath: string): Promise<PathResolution>;
}

/**
 * Build a page fetcher over the given sources, with its own memory of pages
 * and of paths found not to exist.
 */
export function createDocPageFetcher(
  sources: DocPageSources,
  options: { now?: () => number } = {}
): (path: string) => Promise<ResolvedDocPage> {
  const pages = createCache<CachedPage>({
    maxEntries: PAGE_CACHE_MAX_ENTRIES,
    maxSize: PAGE_CACHE_MAX_SIZE,
    now: options.now,
  });
  const missing = createCache<NotFound>({ maxEntries: NOT_FOUND_CACHE_MAX_ENTRIES, now: options.now });

  return async function fetchResolved(path: string): Promise<ResolvedDocPage> {
    const normalizedPath = normalizePath(path);

    const describe = ({ page, resolvedPath }: CachedPage): ResolvedDocPage =>
      resolvedPath === normalizedPath ? { page } : { page, redirectedFrom: normalizedPath };

    // Cache the page under the path it lives at and, when that is not the path
    // that was asked for, under the requested path too.
    const remember = (resolvedPath: string, page: AppleDocPage): ResolvedDocPage => {
      const entry = { page, resolvedPath };
      pages.set(resolvedPath, entry, PAGE_TTL_MS, JSON.stringify(page).length);
      // The alias shares the page object, so it adds nothing to the size held.
      if (resolvedPath !== normalizedPath) pages.set(normalizedPath, entry, PAGE_TTL_MS);
      return describe(entry);
    };

    // The message names the path as this caller spelled it, so it is built
    // per call rather than stored.
    const notFoundError = (found: NotFound): Error =>
      found.resolution?.suggestions.length
        ? new Error(formatNotFoundWithSuggestions(path, found.resolution))
        : pageNotFoundError(path);

    const cached = pages.get(normalizedPath);
    if (cached) return describe(cached);

    const knownMissing = missing.get(normalizedPath);
    if (knownMissing) throw notFoundError(knownMissing);

    try {
      return remember(normalizedPath, await sources.fetchPage(normalizedPath));
    } catch (error) {
      if (!(error instanceof AxiosError) || error.response?.status !== 404) {
        throw wrapFetchError(error, path);
      }

      const resolvedPath = await sources.resolveOn404(normalizedPath);
      if (resolvedPath && resolvedPath !== normalizedPath) {
        try {
          return remember(resolvedPath, await sources.fetchPage(resolvedPath));
        } catch (retryError) {
          throw wrapFetchError(retryError, path);
        }
      }

      // Parent-page resolution failed — consult the framework symbol index
      // (typos, renames, overloads) and global search (other frameworks).
      const resolution = await sources.resolveSuggestions(normalizedPath);
      if (resolution.autoResolvePath && resolution.autoResolvePath !== normalizedPath) {
        try {
          return remember(resolution.autoResolvePath, await sources.fetchPage(resolution.autoResolvePath));
        } catch {
          // Auto-resolve target failed — fall back to suggestions below
        }
      }

      const found: NotFound = { resolution };
      // Only a recovery that ran to completion is worth remembering: one cut
      // short by a failed request might have found the page.
      if (!resolution.incomplete) missing.set(normalizedPath, found, NOT_FOUND_TTL_MS);
      throw notFoundError(found);
    }
  };
}

/**
 * Fetch a documentation page from Apple's CDN, recovering from a path that
 * 404s when there is one unambiguous page it could have meant.
 * @param path - The path portion after /documentation/ (e.g. "swiftui/view")
 */
export const fetchDocPageResolved = createDocPageFetcher({
  fetchPage: rawFetchDocPage,
  resolveOn404: resolvePathOn404,
  resolveSuggestions: resolvePathSuggestions,
});

/** Fetch a documentation page; see fetchDocPageResolved for what happens on a 404. */
export async function fetchDocPage(path: string): Promise<AppleDocPage> {
  return (await fetchDocPageResolved(path)).page;
}
