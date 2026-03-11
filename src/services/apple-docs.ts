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
  headers: {
    Accept: "application/json",
    "User-Agent": "apple-docs-mcp-server/1.0",
  },
});

const SEARCH_CHILD_PAGE_LIMIT = 60;
const SEARCH_DIRECT_MATCH_LIMIT = 12;

function rawFetchDocPage(normalizedPath: string): Promise<AppleDocPage> {
  const url = `${APPLE_DOCS_BASE_URL}/documentation/${normalizedPath}.json`;
  return httpClient.get<AppleDocPage>(url).then((response) => response.data);
}

function pathFromDocUrl(url: string | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url) && !/^https?:\/\/developer\.apple\.com/i.test(url)) return null;

  const withoutPrefix = stripAppleDocsPrefixes(url);
  if (!withoutPrefix) return null;

  return normalizePath(withoutPrefix);
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
    .replace(/[’']/g, "")
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
    title: page.metadata?.title ?? path.split("/").pop() ?? path,
    path,
    webUrl: `${APPLE_DOCS_WEB_BASE}/${path}`,
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

  const exactTitle = candidates.find(({ ref }) => (ref.title ?? "").trim().toLowerCase() === targetLeaf);
  if (exactTitle) return exactTitle.path;

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
    return resolveChildPathFromParentPage(parentPage, parentPath, unresolvedLeaf);
  } catch {
    return null;
  }
}

/**
 * Fetch a documentation page from Apple's CDN.
 * @param path - The path portion after /documentation/ (e.g. "swiftui/view")
 */
export async function fetchDocPage(path: string): Promise<AppleDocPage> {
  const normalizedPath = normalizePath(path);

  try {
    return await rawFetchDocPage(normalizedPath);
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 404) {
      const resolvedPath = await resolvePathOn404(normalizedPath);
      if (resolvedPath && resolvedPath !== normalizedPath) {
        try {
          return await rawFetchDocPage(resolvedPath);
        } catch (retryError) {
          throw wrapFetchError(retryError, path);
        }
      }
    }
    throw wrapFetchError(error, path);
  }
}

function stripAppleDocsPrefixes(path: string): string {
  return path
    .replace(/^https?:\/\/developer\.apple\.com/i, "")
    .replace(/^\/+documentation\//i, "")
    .replace(/^documentation\//i, "");
}

function stripLeafDisambiguation(leaf: string): string {
  let normalized = leaf.trim().toLowerCase();
  if (!normalized) return normalized;

  normalized = normalized.replace(/-(swift|objc|c|cpp)\.[a-z0-9._-]+$/i, "");

  const opaqueSuffixMatch = normalized.match(/^(.*)-([a-z0-9]{4,6})$/i);
  if (opaqueSuffixMatch) {
    const prefix = opaqueSuffixMatch[1];
    if (prefix && (!prefix.includes("-") || /[().:]/.test(prefix))) {
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
      result.abstract.trim().toLowerCase(),
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

  // RED-218: Reject paths containing control characters (codepoint < 0x20 or 0x7F-0x9F)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F-\x9F]/.test(trimmed)) {
    throw new Error(`Invalid path: contains control characters.`);
  }

  // RED-202: Decode URL-encoded sequences before checking for traversal
  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    throw new Error(`Invalid path "${path}": contains malformed percent-encoding.`);
  }

  // Accept full Apple docs URLs and /documentation/... inputs.
  const withoutPrefix = stripAppleDocsPrefixes(decoded).replace(/[?#].*$/, "");

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

  if (!normalized) {
    throw new Error(`Invalid path "${path}": no documentation path remained after normalization.`);
  }

  return normalized;
}

function wrapFetchError(error: unknown, path: string): Error {
  if (error instanceof AxiosError) {
    if (error.response?.status === 404) {
      return new Error(
        `Documentation page not found for path "${path}". ` +
          `Check the path matches a valid Apple documentation URL (e.g. "swiftui/view", "swift/array", "foundation"). ` +
          `You can use apple_docs_list_technologies to discover framework names.`
      );
    }
    if (error.response?.status === 403) {
      return new Error(`Access denied fetching Apple documentation for "${path}".`);
    }
    if (error.code === "ECONNABORTED") {
      return new Error(`Request timed out fetching documentation for "${path}". Please try again.`);
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
      const ref = references[id];
      if (!ref) return null;
      return {
        title: ref.title ?? id,
        url: ref.url ?? "",
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
  const ref = destinationId && references ? references[destinationId] : undefined;
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
    const ref = references?.[identifier];
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
  const frameworkUrlPrefix = `/documentation/${normalizedFramework}`;
  const childPages = new Set<string>();

  for (const ref of Object.values(page.references ?? {})) {
    if (!ref.url) continue;
    const normalizedUrl = ref.url.toLowerCase();
    if (!normalizedUrl.startsWith(frameworkUrlPrefix)) continue;
    if (!["collectionGroup", "collection", "article"].includes(ref.role ?? "")) continue;

    const path = ref.url.replace(/^\/documentation\//i, "");
    if (path && path !== normalizedFramework) {
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
  const frameworkUrlPrefix = `/documentation/${normalizedFramework}`;
  const results: SearchResult[] = [];

  for (const [, ref] of Object.entries(page.references ?? {})) {
    if (!ref.url || !ref.title) continue;
    if (ref.type !== "topic") continue;
    if (!ref.url.toLowerCase().startsWith(frameworkUrlPrefix)) continue;

    const titleMatch = ref.title.toLowerCase().includes(lowerQuery);
    const abstractText = extractText(ref.abstract, page.references);
    const abstractMatch = abstractText.toLowerCase().includes(lowerQuery);

    if (titleMatch || abstractMatch) {
      const webBase = APPLE_DOCS_WEB_BASE.replace(/\/documentation$/, "");
      results.push({
        title: ref.title,
        path: ref.url.replace(/^\/documentation\//, ""),
        webUrl: `${webBase}${ref.url}`,
        abstract: abstractText,
        kind: ref.kind ?? "unknown",
        role: ref.role ?? "unknown",
      });
    }
  }

  return results;
}

function sortSearchResults(results: SearchResult[], query: string): SearchResult[] {
  const lowerQuery = query.toLowerCase();
  return results.sort((a, b) => {
    const aTitle = a.title.toLowerCase().includes(lowerQuery);
    const bTitle = b.title.toLowerCase().includes(lowerQuery);
    if (aTitle && !bTitle) return -1;
    if (!aTitle && bTitle) return 1;
    return a.title.localeCompare(b.title);
  });
}

// ---------------------------------------------------------------------------
// Inline content / text extraction
// ---------------------------------------------------------------------------

export function extractText(
  content: AppleDocInlineContent[] | undefined,
  references?: Record<string, AppleDocReference>
): string {
  if (!content) return "";
  return content
    .map((item) => {
      if (item.type === "text") return item.text ?? "";
      if (item.type === "codeVoice") return `\`${item.code ?? ""}\``;
      if (item.type === "emphasis") {
        // RED-209: Avoid empty emphasis artifacts
        const inner = extractText(item.inlineContent as AppleDocInlineContent[] | undefined, references);
        return inner ? `*${inner}*` : "";
      }
      if (item.type === "strong") {
        // RED-209: Avoid empty strong artifacts
        const inner = extractText(item.inlineContent as AppleDocInlineContent[] | undefined, references);
        return inner ? `**${inner}**` : "";
      }
      if (item.type === "newTerm") return `*${item.text ?? ""}*`;
      if (item.type === "link") {
        // RED-210: Render links with URL when both title and destination exist
        if (item.title && item.destination) return `[${item.title}](${item.destination})`;
        return item.destination ?? item.title ?? "";
      }
      if (item.type === "image") {
        // RED-204: Handle image inline content
        const imgId = item.identifier ?? "";
        if (references && imgId && references[imgId]) {
          const imgRef = references[imgId];
          const alt = imgRef.alt ?? "Image";
          const variants = imgRef.variants;
          const url = variants?.[0]?.url ?? "";
          return url ? `![${alt}](${url})` : `[${alt}]`;
        }
        return "[Image]";
      }
      if (item.type === "reference") {
        // RED-004: Resolve doc:// URIs to human-readable titles
        const id = item.identifier ?? "";
        if (references && references[id]?.title) {
          return references[id].title!;
        }
        // Fallback: extract last path component from doc:// URI
        const lastSegment = id.split("/").pop();
        return lastSegment ?? id;
      }
      return "";
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

  function processItems(items: AppleDocContentItem[], targetLines: string[]): void {
    for (const item of items) {
      if (item.type === "heading") {
        const level = item.level ?? 2;
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
        // RED-002 + RED-207: Fix aside handling - combine style with content in blockquote
        const style = item.style ? `**[${item.style.toUpperCase()}]** ` : "";
        if (item.content) {
          const innerLines: string[] = [];
          processItems(item.content, innerLines);
          if (innerLines.length) {
            // Prepend the style tag to the first inner line
            const combined = innerLines.map((l, i) => {
              const prefix = i === 0 ? style : "";
              return `> ${prefix}${l}`;
            }).join("");
            targetLines.push(`${combined}\n`);
          }
        }
      } else if (item.type === "table") {
        // RED-206: Handle table content type
        const tableData = item as unknown as {
          header?: string;
          rows?: Array<{ cells: Array<{ content: AppleDocContentItem[] }> }>;
        };
        if (tableData.rows && tableData.rows.length > 0) {
          const renderedRows: string[][] = [];
          for (const row of tableData.rows) {
            const cells: string[] = [];
            for (const cell of row.cells) {
              const cellLines: string[] = [];
              processItems(cell.content, cellLines);
              cells.push(cellLines.map((l) => l.replace(/\n$/, "")).join(" "));
            }
            renderedRows.push(cells);
          }
          // Determine column count
          const colCount = Math.max(...renderedRows.map((r) => r.length));
          if (tableData.header === "row" && renderedRows.length > 0) {
            const headerRow = renderedRows[0].map((cell) => markdownTableCell(cell || " "));
            targetLines.push(`| ${headerRow.join(" | ")} |\n`);
            targetLines.push(`| ${Array(colCount).fill("---").join(" | ")} |\n`);
            for (const row of renderedRows.slice(1)) {
              while (row.length < colCount) row.push("");
              targetLines.push(`| ${row.map((cell) => markdownTableCell(cell)).join(" | ")} |\n`);
            }
          } else {
            // No header row: generate a blank header for valid markdown
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
        // RED-205: Handle termList content type
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
            processItems(entry.definition.content as AppleDocContentItem[], defLines);
            for (const dl of defLines) {
              targetLines.push(dl);
            }
          }
          targetLines.push("\n");
        }
      } else if (item.type === "unorderedList" || item.type === "orderedList") {
        // RED-010: Handle list items
        const listItems = (item.items ?? []) as AppleDocContentItem[];
        listItems.forEach((listItem, index) => {
          const bullet = item.type === "orderedList" ? `${index + 1}. ` : "- ";
          if (listItem.content) {
            const innerLines: string[] = [];
            processItems(listItem.content as AppleDocContentItem[], innerLines);
            const text = innerLines.map((l) => l.replace(/\n$/, "")).join(" ");
            if (text) targetLines.push(`${bullet}${text}\n`);
          }
        });
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

// ---------------------------------------------------------------------------
// Parsers for specific response shapes
// ---------------------------------------------------------------------------

export function parseDocPage(page: AppleDocPage, path: string): ParsedSymbol {
  const meta = page.metadata ?? {};
  const title = meta.title ?? page.identifier?.url ?? path;
  const kind = page.kind ?? "unknown";
  const role = meta.role ?? "unknown";

  const refs = page.references;
  const abstract = extractText(page.abstract, refs);
  const declaration = extractDeclaration(page.primaryContentSections);
  const overview = extractOverview(page.primaryContentSections, refs);

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
    items: section.identifiers.map((id) => {
      const ref = page.references?.[id];
      return {
        title: ref?.title ?? id,
        url: ref?.url ?? "",
      };
    }),
  }));

  // RED-219: Parse seeAlsoSections
  const seeAlsoSections = (page.seeAlsoSections ?? []).map((section) => ({
    title: section.title,
    items: resolveReferenceItems(section.identifiers, refs),
  }));

  // RED-005 + REFACTOR SHOULD-FIX-1: Use normalizePath as single source of truth
  const normalizedPath = normalizePath(path);
  const webUrl = `${APPLE_DOCS_WEB_BASE}/${normalizedPath}`;

  return {
    title,
    kind,
    role,
    abstract,
    declaration: declaration || undefined,
    platforms,
    path: normalizedPath,
    webUrl,
    topicSections,
    relationships,
    seeAlsoSections,
    overview,
  };
}

export function parseTechnologies(page: AppleDocPage): ParsedTechnologies {
  const sections: ParsedTechnologies["sections"] = [];

  // RED-001 + REFACTOR SHOULD-FIX-4: Use properly typed AppleDocSection
  // The /technologies endpoint uses `page.sections` (not `topicSections`).
  // Fall back to topicSections for regular pages.
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
          const ref = page.references?.[id];
          if (!ref) return null;
          return {
            title: ref.title ?? id,
            url: ref.url ?? "",
            abstract: extractText(ref.abstract),
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
  const seedPaths = new Set<string>([
    ...collectDirectMatchPaths(page, frameworkPath, query),
    ...collectSearchPagePaths(page, frameworkPath),
  ]);
  const childPages = await Promise.allSettled(Array.from(seedPaths).map((path) => fetchDocPage(path)));

  const merged = new Map<string, SearchResult>();
  const rootPageMatch = createSearchResultFromPage(page, frameworkPath);
  if (rootPageMatch && matchesQuery(query, rootPageMatch.title, rootPageMatch.path, rootPageMatch.abstract)) {
    merged.set(rootPageMatch.path.toLowerCase(), rootPageMatch);
  }

  for (const result of searchReferencesInPage(page, query, frameworkPath)) {
    merged.set(result.path.toLowerCase(), result);
  }

  for (const childPage of childPages) {
    if (childPage.status !== "fulfilled") continue;
    const pageResult = createSearchResultFromPage(childPage.value, frameworkPath);
    if (pageResult && matchesQuery(query, pageResult.title, pageResult.path, pageResult.abstract, searchTextForPage(childPage.value))) {
      merged.set(pageResult.path.toLowerCase(), pageResult);
    }
    for (const result of searchReferencesInPage(childPage.value, query, frameworkPath)) {
      merged.set(result.path.toLowerCase(), result);
    }
  }

  return sortSearchResults(dedupeSearchResults(Array.from(merged.values())), query).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatDocPageMarkdown(parsed: ParsedSymbol): string {
  const lines: string[] = [];

  lines.push(`# ${parsed.title}`);
  lines.push(`**Kind**: ${parsed.kind} | **Role**: ${parsed.role}`);
  lines.push(`**URL**: ${parsed.webUrl}`);

  if (parsed.platforms.length > 0) {
    const platformStr = parsed.platforms
      .map((p) => `${p.name}${p.introducedAt ? ` ${p.introducedAt}+` : ""}${p.beta ? " (beta)" : ""}`)
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
        lines.push(`- **${item.title}** (\`${item.url}\`)${abstract}`);
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
        lines.push(`- ${item.title} (\`${item.url}\`)`);
      }
      if (rel.items.length > 15) {
        lines.push(`- *(${rel.items.length - 15} more...)*`);
      }
    }
    lines.push("");
  }

  // RED-219: Render See Also sections
  if (parsed.seeAlsoSections.length > 0) {
    lines.push(`## See Also`);
    for (const section of parsed.seeAlsoSections) {
      if (section.items.length === 0) continue;
      lines.push(`\n### ${section.title}`);
      for (const item of section.items.slice(0, 20)) {
        const abstract = item.abstract ? ` — ${item.abstract}` : "";
        lines.push(`- **${item.title}** (\`${item.url}\`)${abstract}`);
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
      // Extract path from url like /documentation/swiftui -> swiftui
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
