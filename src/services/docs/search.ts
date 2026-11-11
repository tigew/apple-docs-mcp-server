/**
 * Search within one framework: curated root-page references plus the full symbol index.
 */

import { AppleDocPage, SearchResult } from "../../types.js";
import { extractOverview, extractText } from "./content.js";
import { FlattenedIndexSymbol, fetchFrameworkSymbols } from "./framework-index.js";
import { fetchDocPage } from "./page.js";
import { buildWebUrl, isDesignPath, isInFrameworkScope, normalizePath, pathFromDocUrl, stripLeafDisambiguation } from "./paths.js";

export function searchTextForPage(page: AppleDocPage): string {
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

export function splitQueryTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// Multi-word queries are OR-matched term-by-term against the combined haystack
// (never AND — requiring every term to hit the same field is what made
// multi-word queries perform *worse* than single-word ones) and ranked by how
// many terms matched via sortSearchResults below.
export function matchesQuery(query: string, ...values: Array<string | undefined>): boolean {
  const terms = splitQueryTerms(query);
  if (terms.length === 0) return false;
  const haystack = values.filter(Boolean).join(" ").toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

export function createSearchResultFromPage(page: AppleDocPage, frameworkPath: string): SearchResult | null {
  const path = pathFromDocUrl(page.identifier?.url);
  if (!path) return null;

  const normalizedFramework = normalizePath(frameworkPath);
  if (!isInFrameworkScope(path, normalizedFramework)) {
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

export function canonicalSearchStem(path: string): string {
  const segments = path.split("/");
  const leaf = segments.pop() ?? path;
  segments.push(stripLeafDisambiguation(leaf));
  return segments.join("/");
}

export function searchResultPenalty(path: string): number {
  const leaf = path.split("/").pop() ?? path;
  return leaf === stripLeafDisambiguation(leaf) ? 0 : 1;
}

export function preferSearchResult(candidate: SearchResult, existing: SearchResult): SearchResult {
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

export function searchReferencesInPage(
  page: AppleDocPage,
  query: string,
  frameworkPath: string
): SearchResult[] {
  const normalizedFramework = normalizePath(frameworkPath);
  const results: SearchResult[] = [];

  for (const [, ref] of Object.entries(page.references ?? {})) {
    if (!ref.url || !ref.title) continue;
    if (ref.type !== "topic") continue;
    const path = pathFromDocUrl(ref.url);
    if (!path) continue;
    if (!isInFrameworkScope(path, normalizedFramework)) continue;

    const abstractText = extractText(ref.abstract, page.references);
    if (!matchesQuery(query, ref.title, path, abstractText)) continue;

    results.push({
      title: ref.title,
      path,
      webUrl: buildWebUrl(path),
      abstract: abstractText,
      kind: ref.kind ?? "unknown",
      role: ref.role ?? "unknown",
    });
  }

  return results;
}

export function searchResultScore(result: SearchResult, lowerQuery: string): number {
  const lowerTitle = result.title.toLowerCase();
  // Exact title match gets highest priority
  if (lowerTitle === lowerQuery) return 0;
  // Title starts with query
  if (lowerTitle.startsWith(lowerQuery)) return 1;
  // Title contains query at a word/symbol boundary (\\b doesn't work well with Swift
  // symbols like "map(_:)" since parens aren't word characters — use lookahead for
  // start-of-string or non-alphanumeric preceding character instead)
  const escaped = lowerQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (escaped && new RegExp(`(?:^|[^a-zA-Z0-9_])${escaped}`, "i").test(result.title)) return 2;
  // Title contains query anywhere
  if (lowerTitle.includes(lowerQuery)) return 3;
  // Abstract match only
  return 4;
}

// For multi-word queries, count how many individual terms hit the title/path/
// abstract — a result matching all terms should outrank one matching only one,
// even though neither contains the query as a literal phrase.
export function matchedTermCount(result: SearchResult, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystack = `${result.title} ${result.path} ${result.abstract}`.toLowerCase();
  return terms.filter((term) => haystack.includes(term)).length;
}

export function sortSearchResults(results: SearchResult[], query: string): SearchResult[] {
  const lowerQuery = query.trim().toLowerCase();
  const terms = splitQueryTerms(query);
  // Precompute once per result rather than recomputing inside the O(n log n)
  // comparator calls.
  const matchCounts = terms.length > 1 ? new Map(results.map((r) => [r, matchedTermCount(r, terms)])) : null;
  return results.sort((a, b) => {
    if (matchCounts) {
      const diff = matchCounts.get(b)! - matchCounts.get(a)!;
      if (diff !== 0) return diff;
    }
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
// Search: fetch a framework page and text-match through references
// ---------------------------------------------------------------------------

/**
 * Match a framework's symbols against a query, by Swift name, path, or
 * Objective-C name, within `normalizedFramework` (a framework or a path
 * inside one). A result carries `objcTitle` only when the Objective-C name is
 * the reason it matched.
 */
export function searchIndexSymbols(
  symbols: FlattenedIndexSymbol[],
  query: string,
  normalizedFramework: string
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const symbol of symbols) {
    if (!isInFrameworkScope(symbol.path, normalizedFramework)) continue;
    const matchedSwiftName = matchesQuery(query, symbol.title, symbol.path);
    if (!matchedSwiftName && !(symbol.objcTitle && matchesQuery(query, symbol.objcTitle))) continue;
    results.push({
      title: symbol.title,
      path: symbol.path,
      webUrl: buildWebUrl(symbol.path),
      abstract: "",
      kind: symbol.type,
      role: symbol.type,
      ...(!matchedSwiftName && symbol.objcTitle ? { objcTitle: symbol.objcTitle } : {}),
    });
  }
  return results;
}

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

  // Fast path: if the root page's own references already yield enough
  // results, skip the (larger) index fetch entirely.
  const directResults = dedupeSearchResults(Array.from(merged.values()));
  if (directResults.length >= limit) {
    return sortSearchResults(directResults, query).slice(0, limit);
  }

  // Second tier: fetch Apple's per-framework navigator index — the complete
  // recursive symbol tree (enum cases, extension members, deeply nested type
  // members) that a framework's own root page never lists. One fetch gives
  // full recall; best-effort — fall back to tier-1 results if it fails.
  const normalizedFramework = normalizePath(frameworkPath);
  const topLevelFramework = normalizedFramework.split("/")[0];
  let indexFetchFailed = false;
  // Apple Design (HIG / SF Symbols) has no per-framework navigator index — the
  // `index/design.json` endpoint 404s and `index/human-interface-guidelines.json`
  // is empty — so there's no second tier to fetch. Searching its root page's own
  // topic references is the complete picture, and emitting the "couldn't load the
  // symbol index" warning below would be misleading, so skip the tier entirely.
  if (!isDesignPath(normalizedFramework)) {
   try {
    const symbols = await fetchFrameworkSymbols(topLevelFramework);
    for (const result of searchIndexSymbols(symbols, query, normalizedFramework)) {
      const key = result.path.toLowerCase();
      if (merged.has(key)) continue; // tier-1 already has a result here with a real abstract
      merged.set(key, result);
    }
   } catch {
    indexFetchFailed = true;
   }
  }

  // Reserve one slot for the warning so we don't exceed the caller's limit
  const resultLimit = indexFetchFailed ? Math.max(limit - 1, 0) : limit;
  const results = sortSearchResults(dedupeSearchResults(Array.from(merged.values())), query).slice(0, resultLimit);

  if (indexFetchFailed) {
    results.unshift({
      title: "⚠ Partial results",
      path: "",
      webUrl: "",
      abstract: `Could not load the full symbol index for "${topLevelFramework}" — results may be incomplete beyond what's listed on the framework's own page. Try again, or use apple_docs_get_page with an exact path.`,
      kind: "warning",
      role: "warning",
    });
  }

  return results;
}
