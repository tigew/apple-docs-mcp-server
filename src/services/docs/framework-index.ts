/**
 * Per-framework navigator index: the complete symbol tree behind the docs-site sidebar.
 */

import { APPLE_DOCS_BASE_URL, MAX_RECURSION_DEPTH } from "../../constants.js";
import { AppleDocIndexNode, AppleDocIndexResponse } from "../../types.js";
import { AxiosError } from "axios";
import { createCache, getOrLoad } from "../cache.js";
import { fetchDocsJson, FRAMEWORK_INDEX_MAX_BYTES } from "./http.js";
import { pathFromDocUrl } from "./paths.js";

// A framework's index is a multi-megabyte download (Foundation's is ~6.8MB)
// that changes rarely, so its symbols are kept for an hour. The flattened list
// is what gets cached, so the tree is walked once per download rather than
// once per search. The budget is in characters of symbol JSON.
const SYMBOLS_TTL_MS = 60 * 60 * 1000;
const symbolCache = createCache<FlattenedIndexSymbol[]>({ maxEntries: 20, maxSize: 24 * 1024 * 1024 });

// ---------------------------------------------------------------------------
// Framework navigator index — the full recursive symbol tree that powers the
// docs-site sidebar, fetched from a separate (undocumented) endpoint. One
// fetch per top-level framework gives complete recall, including enum cases,
// extension members, and deeply nested type members that never appear on a
// framework's own root documentation page.
// ---------------------------------------------------------------------------

/**
 * Fetch and cache every symbol in a top-level framework (e.g. "avfoundation"),
 * across its Swift and Objective-C trees. Throws on network/format errors —
 * callers should treat this as a best-effort search tier and fall back
 * gracefully.
 */
export function fetchFrameworkSymbols(topLevelFramework: string): Promise<FlattenedIndexSymbol[]> {
  // getOrLoad also makes simultaneous searches of one framework share a
  // single download instead of each starting their own.
  return getOrLoad(
    symbolCache,
    topLevelFramework,
    SYMBOLS_TTL_MS,
    async () =>
      mergeFrameworkIndexSymbols(
        await loadFrameworkIndexNodes(topLevelFramework, (url) => fetchDocsJson<unknown>(url, FRAMEWORK_INDEX_MAX_BYTES))
      ),
    { sizeOf: (symbols) => JSON.stringify(symbols).length }
  );
}

/** A framework's navigator index: one symbol tree per language. */
export interface FrameworkIndexTrees {
  swift: AppleDocIndexNode[];
  objc: AppleDocIndexNode[];
}

/**
 * Load a framework's navigator-index trees through `get`, an HTTP GET that
 * resolves to the parsed response body and rejects with an AxiosError on a
 * non-2xx status. Split from the caching wrapper above so the URL handling can
 * be tested without the network.
 */
export async function loadFrameworkIndexNodes(
  topLevelFramework: string,
  get: (url: string) => Promise<unknown>
): Promise<FrameworkIndexTrees> {
  // Apple has served this file both with and without a `.json` suffix (the
  // suffixed form began returning 404 in 2026). Try the current form first and
  // fall back only on a 404 — any other failure (timeout, 5xx) is surfaced
  // rather than doubling the wait during an outage.
  const base = `${APPLE_DOCS_BASE_URL}/index/${topLevelFramework}`;
  let data: AppleDocIndexResponse | null;
  try {
    data = (await get(base)) as AppleDocIndexResponse | null;
  } catch (error) {
    if (!(error instanceof AxiosError) || error.response?.status !== 404) throw error;
    data = (await get(`${base}.json`)) as AppleDocIndexResponse | null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Unexpected response format for framework index "${topLevelFramework}".`);
  }

  const languages = data.interfaceLanguages ?? {};
  return {
    swift: Array.isArray(languages.swift) ? languages.swift : [],
    objc: Array.isArray(languages.occ) ? languages.occ : [],
  };
}

export interface FlattenedIndexSymbol {
  title: string;
  path: string;
  type: string;
  /** The symbol's name in the Objective-C tree, when it has one that differs from `title`. */
  objcTitle?: string;
}

/**
 * Combine the two language trees into one list of symbols, one entry per
 * path. Most Objective-C symbols share a page with their Swift counterpart and
 * differ only in name ("func draw(CGRect)" is "- drawRect:"), so the
 * Objective-C name is recorded on the shared entry; symbols that exist only in
 * the Objective-C tree are added as entries of their own.
 */
export function mergeFrameworkIndexSymbols(trees: FrameworkIndexTrees): FlattenedIndexSymbol[] {
  const byPath = new Map<string, FlattenedIndexSymbol>();
  for (const symbol of flattenFrameworkIndexNodes(trees.swift)) {
    if (!byPath.has(symbol.path)) byPath.set(symbol.path, symbol);
  }
  for (const objc of flattenFrameworkIndexNodes(trees.objc)) {
    const shared = byPath.get(objc.path);
    if (!shared) byPath.set(objc.path, objc);
    else if (shared.objcTitle === undefined && objc.title !== shared.title) shared.objcTitle = objc.title;
  }
  return [...byPath.values()];
}

/**
 * Flatten the recursive index tree into a list of navigable symbols. Skips
 * group markers (no path — they're just section headers) and external links.
 */
export function flattenFrameworkIndexNodes(nodes: AppleDocIndexNode[]): FlattenedIndexSymbol[] {
  const out: FlattenedIndexSymbol[] = [];

  function walk(node: AppleDocIndexNode, depth: number): void {
    if (depth > MAX_RECURSION_DEPTH) return;
    if (!node.external && node.path) {
      const normalizedPath = pathFromDocUrl(node.path);
      if (normalizedPath) {
        out.push({ title: node.title ?? normalizedPath, path: normalizedPath, type: node.type ?? "unknown" });
      }
    }
    for (const child of node.children ?? []) {
      walk(child, depth + 1);
    }
  }

  for (const node of nodes) {
    walk(node, 0);
  }

  return out;
}
