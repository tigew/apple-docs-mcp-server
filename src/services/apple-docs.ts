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
  AppleDocPage,
  AppleDocSection,
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

/**
 * Fetch a documentation page from Apple's CDN.
 * @param path - The path portion after /documentation/ (e.g. "swiftui/view")
 */
export async function fetchDocPage(path: string): Promise<AppleDocPage> {
  const normalizedPath = normalizePath(path);
  const url = `${APPLE_DOCS_BASE_URL}/documentation/${normalizedPath}.json`;

  try {
    const response = await httpClient.get<AppleDocPage>(url);
    return response.data;
  } catch (error) {
    throw wrapFetchError(error, path);
  }
}

function normalizePath(path: string): string {
  // RED-218: Reject paths containing control characters (codepoint < 0x20 or 0x7F-0x9F)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F-\x9F]/.test(path)) {
    throw new Error(`Invalid path: contains control characters.`);
  }

  // RED-202: Decode URL-encoded sequences before checking for traversal
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error(`Invalid path "${path}": contains malformed percent-encoding.`);
  }

  // Strip leading slash, trailing slash, and .json suffix
  const normalized = decoded
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.json$/, "")
    .toLowerCase();

  // RED-007: Reject path traversal attempts (checked after decoding)
  if (normalized.includes("..")) {
    throw new Error(`Invalid path "${path}": path traversal ("..") is not allowed.`);
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
          const alt = (imgRef as unknown as { alt?: string }).alt ?? "Image";
          const variants = (imgRef as unknown as { variants?: Array<{ url: string }> }).variants;
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
            const headerRow = renderedRows[0];
            targetLines.push(`| ${headerRow.map((c) => c || " ").join(" | ")} |\n`);
            targetLines.push(`| ${Array(colCount).fill("---").join(" | ")} |\n`);
            for (const row of renderedRows.slice(1)) {
              while (row.length < colCount) row.push("");
              targetLines.push(`| ${row.join(" | ")} |\n`);
            }
          } else {
            // No header row: generate a blank header for valid markdown
            targetLines.push(`| ${Array(colCount).fill(" ").join(" | ")} |\n`);
            targetLines.push(`| ${Array(colCount).fill("---").join(" | ")} |\n`);
            for (const row of renderedRows) {
              while (row.length < colCount) row.push("");
              targetLines.push(`| ${row.join(" | ")} |\n`);
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
    items: section.identifiers
      .map((id) => {
        const ref = page.references?.[id];
        if (!ref) return null;
        return {
          title: ref.title ?? id,
          url: ref.url ?? "",
          abstract: extractText(ref.abstract, refs),
          kind: ref.kind ?? "unknown",
          role: ref.role ?? "unknown",
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null),
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
    items: section.identifiers
      .map((id) => {
        const ref = page.references?.[id];
        if (!ref) return null;
        return {
          title: ref.title ?? id,
          url: ref.url ?? "",
          abstract: extractText(ref.abstract, refs),
          kind: ref.kind ?? "unknown",
          role: ref.role ?? "unknown",
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null),
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
      // Collect all identifiers from groups within this section
      const allIdentifiers: string[] = [];
      if (section.groups) {
        for (const group of section.groups) {
          if (group.identifiers) {
            allIdentifiers.push(...group.identifiers);
          }
        }
      }
      if (section.identifiers) {
        allIdentifiers.push(...section.identifiers);
      }

      const techs = allIdentifiers
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

      const sectionTitle = section.title ?? "Technologies";
      if (techs.length > 0) {
        sections.push({ title: sectionTitle, technologies: techs });
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
  const lowerQuery = query.toLowerCase();
  const results: SearchResult[] = [];

  // RED-008 + REFACTOR SHOULD-FIX-1: Use normalizePath as single source of truth
  const normalizedFramework = normalizePath(frameworkPath);
  const frameworkUrlPrefix = `/documentation/${normalizedFramework}`;

  for (const [, ref] of Object.entries(page.references ?? {})) {
    if (!ref.url || !ref.title) continue;
    if (ref.type !== "topic") continue;

    // RED-008: Only include references within the requested framework
    if (!ref.url.toLowerCase().startsWith(frameworkUrlPrefix)) continue;

    const titleMatch = ref.title.toLowerCase().includes(lowerQuery);
    const abstractText = extractText(ref.abstract, page.references);
    const abstractMatch = abstractText.toLowerCase().includes(lowerQuery);

    if (titleMatch || abstractMatch) {
      // RED-003: Fix doubled /documentation/ in webUrl
      // ref.url already starts with /documentation/, so use APPLE_DOCS_WEB_BASE without it
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

  // RED-208: Sort results — title matches first, then alphabetically by title
  results.sort((a, b) => {
    const aTitle = a.title.toLowerCase().includes(lowerQuery);
    const bTitle = b.title.toLowerCase().includes(lowerQuery);
    if (aTitle && !bTitle) return -1;
    if (!aTitle && bTitle) return 1;
    return a.title.localeCompare(b.title);
  });

  return results.slice(0, limit);
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
