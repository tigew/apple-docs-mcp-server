/**
 * Cached documentation page fetch with 404 recovery.
 */

import { AppleDocPage } from "../../types.js";
import { AxiosError } from "axios";
import { createTtlCache } from "./cache.js";
import { rawFetchDocPage, wrapFetchError } from "./http.js";
import { normalizePath } from "./paths.js";
import { formatNotFoundWithSuggestions, resolvePathOn404, resolvePathSuggestions } from "./resolve.js";

/** A page, and the path it really lives at (which differs from its cache key for a recovered alias). */
interface CachedPage {
  page: AppleDocPage;
  resolvedPath: string;
}

const pageCache = createTtlCache<CachedPage>(5 * 60 * 1000, 100);

export interface ResolvedDocPage {
  page: AppleDocPage;
  /**
   * Set when the requested path does not exist and 404 recovery returned a
   * different page in its place: the (normalized) path that was asked for.
   */
  redirectedFrom?: string;
}

/**
 * Fetch a documentation page from Apple's CDN, recovering from a path that
 * 404s when there is one unambiguous page it could have meant.
 * @param path - The path portion after /documentation/ (e.g. "swiftui/view")
 */
export async function fetchDocPageResolved(path: string): Promise<ResolvedDocPage> {
  const normalizedPath = normalizePath(path);

  const describe = ({ page, resolvedPath }: CachedPage): ResolvedDocPage =>
    resolvedPath === normalizedPath ? { page } : { page, redirectedFrom: normalizedPath };

  // Cache the page under the path it lives at and, when that is not the path
  // that was asked for, under the requested path too.
  const remember = (resolvedPath: string, page: AppleDocPage): ResolvedDocPage => {
    const entry = { page, resolvedPath };
    pageCache.set(resolvedPath, entry);
    if (resolvedPath !== normalizedPath) pageCache.set(normalizedPath, entry);
    return describe(entry);
  };

  const cached = pageCache.get(normalizedPath);
  if (cached) return describe(cached);

  try {
    return remember(normalizedPath, await rawFetchDocPage(normalizedPath));
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 404) {
      const resolvedPath = await resolvePathOn404(normalizedPath);
      if (resolvedPath && resolvedPath !== normalizedPath) {
        try {
          return remember(resolvedPath, await rawFetchDocPage(resolvedPath));
        } catch (retryError) {
          throw wrapFetchError(retryError, path);
        }
      }

      // Parent-page resolution failed — consult the framework symbol index
      // (typos, renames, overloads) and global search (other frameworks).
      const resolution = await resolvePathSuggestions(normalizedPath);
      if (resolution.autoResolvePath && resolution.autoResolvePath !== normalizedPath) {
        try {
          return remember(resolution.autoResolvePath, await rawFetchDocPage(resolution.autoResolvePath));
        } catch {
          // Auto-resolve target failed — fall back to suggestions below
        }
      }
      if (resolution.suggestions.length > 0) {
        throw new Error(formatNotFoundWithSuggestions(path, resolution));
      }
    }
    throw wrapFetchError(error, path);
  }
}

/** Fetch a documentation page; see fetchDocPageResolved for what happens on a 404. */
export async function fetchDocPage(path: string): Promise<AppleDocPage> {
  return (await fetchDocPageResolved(path)).page;
}
