/**
 * Per-framework navigator index: the complete symbol tree behind the docs-site sidebar.
 */

import { APPLE_DOCS_BASE_URL, MAX_RECURSION_DEPTH } from "../../constants.js";
import { AppleDocIndexNode, AppleDocIndexResponse } from "../../types.js";
import { AxiosError } from "axios";
import { createTtlCache } from "./cache.js";
import { fetchDocsJson, FRAMEWORK_INDEX_MAX_BYTES } from "./http.js";
import { pathFromDocUrl } from "./paths.js";

// Framework navigator-index payloads are much larger (up to several MB) than
// a single doc page, hence the longer TTL (they change less often) and much
// smaller capacity.
export const indexCache = createTtlCache<AppleDocIndexNode[]>(15 * 60 * 1000, 15);

export const getCachedIndex = (topLevelFramework: string) => indexCache.get(topLevelFramework);

export const setCachedIndex = (topLevelFramework: string, nodes: AppleDocIndexNode[]) => indexCache.set(topLevelFramework, nodes);

// ---------------------------------------------------------------------------
// Framework navigator index — the full recursive symbol tree that powers the
// docs-site sidebar, fetched from a separate (undocumented) endpoint. One
// fetch per top-level framework gives complete recall, including enum cases,
// extension members, and deeply nested type members that never appear on a
// framework's own root documentation page.
// ---------------------------------------------------------------------------

/**
 * Fetch and cache the full symbol-tree index for a top-level framework
 * (e.g. "avfoundation"). Throws on network/format errors — callers should
 * treat this as a best-effort search tier and fall back gracefully.
 */
export async function fetchFrameworkIndex(topLevelFramework: string): Promise<AppleDocIndexNode[]> {
  const cached = getCachedIndex(topLevelFramework);
  if (cached) return cached;

  const nodes = await loadFrameworkIndexNodes(topLevelFramework, (url) =>
    fetchDocsJson<unknown>(url, FRAMEWORK_INDEX_MAX_BYTES)
  );

  setCachedIndex(topLevelFramework, nodes);
  return nodes;
}

/**
 * Load a framework's navigator-index nodes through `get`, an HTTP GET that
 * resolves to the parsed response body and rejects with an AxiosError on a
 * non-2xx status. Split from the caching wrapper above so the URL handling can
 * be tested without the network.
 */
export async function loadFrameworkIndexNodes(
  topLevelFramework: string,
  get: (url: string) => Promise<unknown>
): Promise<AppleDocIndexNode[]> {
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
  const swiftNodes = Array.isArray(languages.swift) ? languages.swift : [];
  const occNodes = Array.isArray(languages.occ) ? languages.occ : [];
  return swiftNodes.length ? swiftNodes : occNodes;
}

export interface FlattenedIndexSymbol {
  title: string;
  path: string;
  type: string;
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
