/**
 * Markdown formatting for parsed documentation and search results.
 */

import { GlobalSearchResult, ParsedSymbol, ParsedTechnologies, SearchResult } from "../../types.js";

export function formatDocPageMarkdown(parsed: ParsedSymbol): string {
  const lines: string[] = [];

  // Deprecation banner at top
  if (parsed.deprecated) {
    let banner = `> **DEPRECATED**${parsed.deprecatedAt ? ` (${parsed.deprecatedAt})` : ""}`;
    if (parsed.deprecationMessage) banner += `\n> ${parsed.deprecationMessage}`;
    lines.push(banner);
    lines.push("");
  }

  lines.push(`# ${parsed.title}`);

  // Metadata line with role heading, module, kind
  const metaParts: string[] = [];
  if (parsed.roleHeading) metaParts.push(parsed.roleHeading);
  else metaParts.push(`${parsed.kind} (${parsed.role})`);
  if (parsed.module) metaParts.push(`Module: ${parsed.module}`);
  lines.push(`**${metaParts.join(" | ")}**`);

  // Breadcrumb
  if (parsed.breadcrumb?.length) {
    lines.push(`**Path**: ${parsed.breadcrumb.join(" > ")} > ${parsed.title}`);
  }

  lines.push(`**URL**: ${parsed.webUrl}`);

  if (parsed.platforms.length > 0) {
    const platformStr = parsed.platforms
      .map((p) => {
        let s = p.name;
        if (p.introducedAt) s += ` ${p.introducedAt}+`;
        if (p.deprecatedAt) s += ` (deprecated ${p.deprecatedAt})`;
        else if (p.deprecated) s += ` (deprecated)`;
        if (p.renamed) s += ` → ${p.renamed}`;
        if (p.beta) s += ` (beta)`;
        return s;
      })
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

  // Parameters section
  if (parsed.parameters?.length) {
    lines.push(`## Parameters`);
    for (const param of parsed.parameters) {
      const desc = param.description ? ` — ${param.description}` : "";
      lines.push(`- **\`${param.name}\`**${desc}`);
    }
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
        lines.push(`- **${item.title}** (path: \`${item.path}\`)${abstract}`);
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
        lines.push(`- ${item.title} (path: \`${item.path}\`)`);
      }
      if (rel.items.length > 15) {
        lines.push(`- *(${rel.items.length - 15} more...)*`);
      }
    }
    lines.push("");
  }

  if (parsed.seeAlsoSections.length > 0) {
    lines.push(`## See Also`);
    for (const section of parsed.seeAlsoSections) {
      if (section.items.length === 0) continue;
      lines.push(`\n### ${section.title}`);
      for (const item of section.items.slice(0, 20)) {
        const abstract = item.abstract ? ` — ${item.abstract}` : "";
        lines.push(`- **${item.title}** (path: \`${item.path}\`)${abstract}`);
      }
      if (section.items.length > 20) {
        lines.push(`- *(${section.items.length - 20} more items...)*`);
      }
    }
  }

  return lines.join("\n");
}

export function formatTechnologiesMarkdown(
  parsed: ParsedTechnologies,
  options?: { compact?: boolean }
): string {
  const lines: string[] = ["# Apple Developer Technologies", ""];
  if (options?.compact) {
    lines.push(
      "*(Descriptions omitted so the complete framework list fits in one response — " +
        "use apple_docs_get_page with a framework's path for its description.)*",
      ""
    );
  }
  for (const section of parsed.sections) {
    lines.push(`## ${section.title}`);
    lines.push("");
    for (const tech of section.technologies) {
      const abstract = !options?.compact && tech.abstract ? ` — ${tech.abstract}` : "";
      // Strip the leading /documentation/ (framework docs) or a bare leading
      // slash (design paths keep their design/ prefix) to yield a get_page path.
      const path = tech.url.replace(/^\/documentation\//, "").replace(/^\//, "");
      lines.push(`- **${tech.title}** (\`${path}\`)${abstract}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function formatGlobalSearchResultsMarkdown(results: GlobalSearchResult[], query: string): string {
  if (results.length === 0) {
    return (
      `No results found for "${query}" across Apple's documentation. ` +
      `This global search works best with symbol or concept names (e.g. "RelevantContext", "widget relevance"). ` +
      `Try a different name, or search within a specific framework with apple_docs_search.`
    );
  }

  const lines = [
    `# Global Search Results: "${query}"`,
    `Found ${results.length} result(s) across all frameworks`,
    "",
  ];
  for (const result of results) {
    lines.push(`## ${result.title}`);
    lines.push(`**Framework**: ${result.framework} | **Path**: \`${result.path}\``);
    lines.push(`**URL**: ${result.webUrl}`);
    if (result.availability) lines.push(`**Availability**: ${result.availability}`);
    if (result.description) lines.push(result.description);
    lines.push("");
  }
  return lines.join("\n");
}

export function formatSearchResultsMarkdown(
  results: SearchResult[],
  query: string,
  frameworkPath: string
): string {
  const realResults = results.filter((r) => r.kind !== "warning");

  if (realResults.length === 0) {
    const warning = results.find((r) => r.kind === "warning");
    if (warning) {
      // The full symbol-tree fetch failed, so this is inconclusive — not
      // evidence the symbol doesn't exist, just that the search was incomplete.
      return `No results found for "${query}" in framework "${frameworkPath}". ${warning.abstract}`;
    }
    return (
      `No results found for "${query}" in framework "${frameworkPath}". ` +
      `This search covers the framework's complete symbol tree (types, enum cases, extension members, and nested ` +
      `members), not just its root documentation page — so this is good evidence the symbol doesn't exist under ` +
      `that name in this framework, not just that it wasn't indexed. The symbol may live in a different framework ` +
      `(e.g. types used in WidgetKit signatures that belong to RelevanceKit) — use apple_docs_find_symbol to search ` +
      `across all frameworks, or double-check the spelling.`
    );
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
