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
  AppleDocInlineContent,
  AppleDocContentItem,
  AppleDocFragment,
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
  // Strip leading slash, trailing slash, and .json suffix
  return path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.json$/, "")
    .toLowerCase();
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

export function extractText(content: AppleDocInlineContent[] | undefined): string {
  if (!content) return "";
  return content
    .map((item) => {
      if (item.type === "text") return item.text ?? "";
      if (item.type === "codeVoice") return `\`${item.code ?? ""}\``;
      if (item.type === "reference") return item.identifier ?? "";
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
  sections: AppleDocPage["primaryContentSections"]
): string {
  if (!sections) return "";

  const contentSection = sections.find((s) => s.kind === "content");
  if (!contentSection?.content) return "";

  const lines: string[] = [];

  function processItems(items: AppleDocContentItem[]): void {
    for (const item of items) {
      if (item.type === "heading") {
        const level = item.level ?? 2;
        lines.push(`${"#".repeat(level)} ${item.text ?? ""}\n`);
      } else if (item.type === "paragraph") {
        const text = extractText(item.inlineContent);
        if (text) lines.push(`${text}\n`);
      } else if (item.type === "codeListing") {
        const syntax = item.syntax ?? "";
        const codeLines = (item.code ?? []).join("\n");
        lines.push(`\`\`\`${syntax}\n${codeLines}\n\`\`\`\n`);
      } else if (item.type === "aside") {
        const style = item.style ? `[${item.style.toUpperCase()}] ` : "";
        if (item.content) {
          const innerLines: string[] = [];
          processItems(item.content);
          if (innerLines.length) {
            lines.push(`> ${style}${innerLines.join(" > ")}\n`);
          }
        }
      }
    }
  }

  processItems(contentSection.content as AppleDocContentItem[]);
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

  const abstract = extractText(page.abstract);
  const declaration = extractDeclaration(page.primaryContentSections);
  const overview = extractOverview(page.primaryContentSections);

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
          abstract: extractText(ref.abstract),
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

  const webUrl = `${APPLE_DOCS_WEB_BASE}/${path.toLowerCase()}`;

  return {
    title,
    kind,
    role,
    abstract,
    declaration: declaration || undefined,
    platforms,
    path,
    webUrl,
    topicSections,
    relationships,
    overview,
  };
}

export function parseTechnologies(page: AppleDocPage): ParsedTechnologies {
  const sections: ParsedTechnologies["sections"] = [];

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

  for (const [, ref] of Object.entries(page.references ?? {})) {
    if (!ref.url || !ref.title) continue;
    if (ref.type !== "topic") continue;

    const titleMatch = ref.title.toLowerCase().includes(lowerQuery);
    const abstractText = extractText(ref.abstract);
    const abstractMatch = abstractText.toLowerCase().includes(lowerQuery);

    if (titleMatch || abstractMatch) {
      results.push({
        title: ref.title,
        path: ref.url.replace(/^\/documentation\//, ""),
        webUrl: `${APPLE_DOCS_WEB_BASE}${ref.url}`,
        abstract: abstractText,
        kind: ref.kind ?? "unknown",
        role: ref.role ?? "unknown",
      });
    }

    if (results.length >= limit) break;
  }

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
