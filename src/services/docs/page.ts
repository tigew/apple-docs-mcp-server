/**
 * Cached documentation page fetch with 404 recovery.
 */

import { AppleDocPage } from "../../types.js";
import { AxiosError } from "axios";
import { createTtlCache } from "./cache.js";
import { rawFetchDocPage, wrapFetchError } from "./http.js";
import { normalizePath } from "./paths.js";
import { formatNotFoundWithSuggestions, resolvePathOn404, resolvePathSuggestions } from "./resolve.js";

export const pageCache = createTtlCache<AppleDocPage>(5 * 60 * 1000, 100);

export const getCachedPage = (normalizedPath: string) => pageCache.get(normalizedPath);

export const setCachedPage = (normalizedPath: string, page: AppleDocPage) => pageCache.set(normalizedPath, page);

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

      // Parent-page resolution failed — consult the framework symbol index
      // (typos, renames, overloads) and global search (other frameworks).
      const resolution = await resolvePathSuggestions(normalizedPath);
      if (resolution.autoResolvePath && resolution.autoResolvePath !== normalizedPath) {
        try {
          const page = await rawFetchDocPage(resolution.autoResolvePath);
          setCachedPage(resolution.autoResolvePath, page);
          setCachedPage(normalizedPath, page); // cache alias → resolved page too
          return page;
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
