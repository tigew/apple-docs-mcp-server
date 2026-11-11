/**
 * Recovery for paths that 404: parent-page lookup, framework-index "did you mean"
 * suggestions, and a cross-framework search fallback.
 */

import { AppleDocPage, PathResolution, PathSuggestion } from "../../types.js";
import { FlattenedIndexSymbol, fetchFrameworkSymbols } from "./framework-index.js";
import { searchGlobalSymbols } from "./global-search.js";
import { rawFetchDocPage } from "./http.js";
import { alnumKey, baseSymbolName, collectLeafLookupKeys, collectTitleLookupKeys, normalizePath, pathFromDocUrl, queryToLikelySlug, stripLeafDisambiguation } from "./paths.js";

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

  // Prefix match (e.g. "result" → "result(value:)") only resolves when it is
  // unambiguous — with multiple overloads, picking the first reference would
  // silently return an arbitrary one. Returning null instead lets the
  // symbol-index suggestion tier list every overload with its declaration.
  const prefixedLeaves = candidates.filter(({ leaf }) => leaf.startsWith(targetLeaf));
  if (prefixedLeaves.length === 1) return prefixedLeaves[0].path;

  return null;
}

export async function resolvePathOn404(normalizedPath: string): Promise<string | null> {
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

// ---------------------------------------------------------------------------
// 404 suggestion engine — "did you mean" resolution against the framework
// symbol index (typos, renamed types, overload disambiguation) with a global
// cross-framework search fallback.
// ---------------------------------------------------------------------------

export const MAX_SUGGESTIONS = 8;

// Overload families can be huge (IntentResult has 52 result(…) overloads) and
// "list every overload with its declaration" is precisely what a caller asking
// for a bare member name needs — so same-parent overloads get a larger cap.
export const MAX_OVERLOAD_SUGGESTIONS = 40;

/**
 * Levenshtein distance, bounded: returns max+1 as soon as the distance is
 * known to exceed `max` (banded DP keeps this O(max·n)).
 */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array<number>(b.length + 1);
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length] > max ? max + 1 : prev[b.length];
}

/**
 * Match a 404'd path against a framework's flattened symbol index.
 * Pure so it can be unit-tested; resolvePathSuggestions handles the fetches.
 *
 * Buckets, in ranking order:
 * 1. Same parent, same base symbol name — overloads / bare-name lookups
 *    ("…/result" finds every "result(…)" overload with its declaration).
 * 2. Renamed types — alphanumeric title match ("cksharemetadata" finds
 *    "CKShare.Metadata" at ckshare/metadata).
 * 3. Same parent, edit distance ≤ 2 — typos ("relevances()" → "relevance()").
 * 4. Same base name elsewhere in the framework — wrong-parent lookups.
 */
export function resolveFromIndexSymbols(
  normalizedPath: string,
  symbols: FlattenedIndexSymbol[]
): PathResolution {
  const segments = normalizedPath.split("/");
  const leaf = segments[segments.length - 1];
  const parentPath = segments.slice(0, -1).join("/");
  const strippedLeaf = stripLeafDisambiguation(leaf);
  const targetBase = baseSymbolName(leaf);
  const targetAlnum = alnumKey(strippedLeaf);

  const overloads: PathSuggestion[] = [];
  const renames: PathSuggestion[] = [];
  const typos: PathSuggestion[] = [];
  const elsewhere: PathSuggestion[] = [];
  const seen = new Set<string>();

  for (const symbol of symbols) {
    if (symbol.path === normalizedPath || seen.has(symbol.path)) continue;
    const symbolLeaf = symbol.path.split("/").pop() ?? "";
    const symbolParent = symbol.path.slice(0, Math.max(0, symbol.path.length - symbolLeaf.length - 1));
    const symbolStripped = stripLeafDisambiguation(symbolLeaf);
    const symbolBase = symbolStripped.split("(")[0];
    const suggestion: PathSuggestion = { path: symbol.path, title: symbol.title };

    if (symbolParent === parentPath && symbolBase === targetBase && targetBase) {
      overloads.push(suggestion);
    } else if (
      targetAlnum.length >= 4 &&
      !symbol.title.includes(" ") &&
      alnumKey(symbol.title) === targetAlnum
    ) {
      renames.push(suggestion);
    } else if (
      // An Objective-C selector used as the path ("drawrect:"): the method is
      // documented on the page it shares with its Swift name ("draw(_:)").
      symbolParent === parentPath &&
      symbol.objcTitle !== undefined &&
      targetAlnum.length >= 3 &&
      alnumKey(symbol.objcTitle) === targetAlnum
    ) {
      renames.push(suggestion);
    } else if (
      symbolParent === parentPath &&
      strippedLeaf.length >= 3 &&
      boundedEditDistance(strippedLeaf, symbolStripped, 2) <= 2
    ) {
      typos.push(suggestion);
    } else if (symbolBase === targetBase && targetBase.length >= 3) {
      elsewhere.push(suggestion);
    } else {
      continue;
    }
    seen.add(symbol.path);
  }

  // When same-parent overloads exist they are the answer — list the family
  // (with declarations) instead of diluting it with weaker matches.
  const ranked = overloads.length > 0 ? overloads : [...renames, ...typos, ...elsewhere];
  const cap = overloads.length > 0 ? MAX_OVERLOAD_SUGGESTIONS : MAX_SUGGESTIONS;
  const suggestions = ranked.slice(0, cap);
  const omittedCount = ranked.length - suggestions.length;

  // Auto-resolve only distance-0 matches (never typo guesses): a lone overload
  // (bare name or disambiguation-suffix miss), a lone rename, or the same
  // symbol name at exactly one other spot in the framework.
  let autoResolvePath: string | undefined;
  if (overloads.length === 1) autoResolvePath = overloads[0].path;
  else if (overloads.length === 0 && renames.length === 1) autoResolvePath = renames[0].path;
  else if (overloads.length === 0 && renames.length === 0 && typos.length === 0 && elsewhere.length === 1) {
    autoResolvePath = elsewhere[0].path;
  }

  return {
    autoResolvePath,
    suggestions,
    crossFramework: false,
    ...(omittedCount > 0 ? { omittedCount } : {}),
  };
}

/**
 * Best-effort suggestion lookup for a 404'd path: framework index first,
 * then global cross-framework search. Never throws.
 */
export async function resolvePathSuggestions(normalizedPath: string): Promise<PathResolution> {
  const topLevelFramework = normalizedPath.split("/")[0];

  try {
    const resolution = resolveFromIndexSymbols(normalizedPath, await fetchFrameworkSymbols(topLevelFramework));
    if (resolution.autoResolvePath || resolution.suggestions.length > 0) {
      return resolution;
    }
  } catch {
    // Unknown framework or index fetch failure — fall through to global search
  }

  // Nothing in this framework — the symbol may live elsewhere (e.g.
  // widgetkit/relevantcontext is really relevancekit/relevantcontext).
  try {
    const leaf = normalizedPath.split("/").pop() ?? normalizedPath;
    const queryName = baseSymbolName(leaf);
    if (queryName.length < 3) return { suggestions: [], crossFramework: false };

    const hits = await searchGlobalSymbols(queryName, MAX_SUGGESTIONS);
    const targetAlnum = alnumKey(stripLeafDisambiguation(leaf));
    const exact = hits.filter((hit) => alnumKey(hit.title) === targetAlnum);
    const chosen = exact.length > 0 ? exact : hits;

    return {
      autoResolvePath: exact.length === 1 ? exact[0].path : undefined,
      suggestions: chosen.slice(0, MAX_SUGGESTIONS).map((hit) => ({
        path: hit.path,
        title: hit.title,
        framework: hit.framework,
      })),
      crossFramework: true,
    };
  } catch {
    return { suggestions: [], crossFramework: false };
  }
}

export function formatNotFoundWithSuggestions(path: string, resolution: PathResolution): string {
  const lines = [
    `Documentation page not found for path "${path}".`,
    resolution.crossFramework
      ? `The symbol was not found in that framework, but similar symbols exist elsewhere. Did you mean:`
      : `Did you mean:`,
  ];
  for (const suggestion of resolution.suggestions) {
    const framework = suggestion.framework ? ` [${suggestion.framework}]` : "";
    const title = suggestion.title && suggestion.title !== suggestion.path.split("/").pop()
      ? ` — ${suggestion.title}`
      : "";
    lines.push(`  - \`${suggestion.path}\`${framework}${title}`);
  }
  if (resolution.omittedCount) {
    lines.push(`  - *(${resolution.omittedCount} more similar symbols not shown)*`);
  }
  lines.push(`Pass one of these paths to apple_docs_get_page, or use apple_docs_find_symbol to search all frameworks.`);
  return lines.join("\n");
}
