/**
 * Markdown formatting for parsed documentation and search results.
 */

import { GlobalSearchResult, ParsedField, ParsedSymbol, ParsedTechnologies, SearchResult } from "../../types.js";

// Markdown shows a readable sample of long lists; the JSON format keeps every entry.
const MAX_ALLOWED_VALUES_SHOWN = 10;
const MAX_MENTIONS_SHOWN = 10;

/** `\`Type\` (path: \`a/b\`)`, or just the type when it has no documentation page. */
function formatType(typed: { type?: string; typePath?: string }): string {
  if (!typed.type) return "";
  return typed.typePath ? `\`${typed.type}\` (path: \`${typed.typePath}\`)` : `\`${typed.type}\``;
}

/** One list line for a parameter, property, or enumeration value. */
function formatField(field: ParsedField): string {
  const flags: string[] = [];
  if (typeof field.required === "boolean") flags.push(field.required ? "required" : "optional");
  if (field.deprecated) flags.push("deprecated");

  const head = [`**\`${field.name}\`**`, formatType(field), flags.length ? `(${flags.join(", ")})` : ""]
    .filter(Boolean)
    .join(" ");

  const notes: string[] = [];
  if (field.description) notes.push(/[.!?]$/.test(field.description) ? field.description : `${field.description}.`);
  if (field.allowedValues?.length) {
    const shown = field.allowedValues.slice(0, MAX_ALLOWED_VALUES_SHOWN).map((value) => `\`${value}\``).join(", ");
    const hidden = field.allowedValues.length - MAX_ALLOWED_VALUES_SHOWN;
    notes.push(`Allowed values: ${shown}${hidden > 0 ? ` (+${hidden} more)` : ""}.`);
  }
  for (const constraint of field.constraints ?? []) notes.push(`${constraint}.`);

  return notes.length ? `- ${head} — ${notes.join(" ")}` : `- ${head}`;
}

export function formatDocPageMarkdown(parsed: ParsedSymbol): string {
  const lines: string[] = [];

  // Say so first when this is not the page that was asked for, so a wrong
  // guess at a path is never mistaken for documentation of that path.
  if (parsed.redirectedFrom) {
    lines.push(
      `> **Note:** No page exists at \`${parsed.redirectedFrom}\`. Showing the closest match instead: \`${parsed.path}\`.`
    );
    lines.push("");
  }

  if (parsed.objcUnavailable) {
    lines.push("> **Note:** This page has no Objective-C version. Showing it as published.");
    lines.push("");
  }

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
    lines.push(`\`\`\`${parsed.declarationLanguage ?? ""}`);
    lines.push(parsed.declaration);
    lines.push(`\`\`\``);
    lines.push("");
  }

  // Web-service and configuration reference sections. These come before the
  // prose because the prose on these pages is often a very long example.
  if (parsed.details) {
    lines.push(`## Details`);
    lines.push(`- **Name**: \`${parsed.details.name}\``);
    if (parsed.details.ideTitle) lines.push(`- **Xcode name**: ${parsed.details.ideTitle}`);
    if (parsed.details.valueTypes.length) lines.push(`- **Type**: ${parsed.details.valueTypes.join(" or ")}`);
    lines.push("");
  }

  if (parsed.restEndpoints?.length) {
    lines.push(`## Endpoint`);
    for (const endpoint of parsed.restEndpoints) {
      lines.push(`- **${endpoint.title}**: \`${[endpoint.method, endpoint.url].filter(Boolean).join(" ")}\``);
    }
    lines.push("");
  }

  for (const group of parsed.restParameters ?? []) {
    lines.push(`## ${group.title}`);
    for (const field of group.items) lines.push(formatField(field));
    lines.push("");
  }

  if (parsed.restBody) {
    const body = parsed.restBody;
    lines.push(`## ${body.title}`);
    const summary = [formatType(body), body.mimeType].filter(Boolean).join(", ");
    if (summary) lines.push(summary);
    if (body.description) lines.push("", body.description);
    if (body.parameters?.length) {
      lines.push("");
      for (const field of body.parameters) lines.push(formatField(field));
    }
    lines.push("");
  }

  if (parsed.restResponses?.length) {
    lines.push(`## Response Codes`);
    for (const response of parsed.restResponses) {
      const summary = [formatType(response), response.mimeType].filter(Boolean).join(", ");
      const parts = [`**${[response.status, response.reason].filter(Boolean).join(" ")}**`, summary, response.description];
      lines.push(`- ${parts.filter(Boolean).join(" — ")}`);
    }
    lines.push("");
  }

  for (const list of [parsed.properties, parsed.possibleValues]) {
    if (!list?.items.length) continue;
    lines.push(`## ${list.title}`);
    for (const field of list.items) lines.push(formatField(field));
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

  if (parsed.mentionedIn?.length) {
    lines.push(`## Mentioned In`);
    for (const item of parsed.mentionedIn.slice(0, MAX_MENTIONS_SHOWN)) {
      lines.push(`- **${item.title}** (path: \`${item.path}\`)`);
    }
    if (parsed.mentionedIn.length > MAX_MENTIONS_SHOWN) {
      lines.push(`- *(${parsed.mentionedIn.length - MAX_MENTIONS_SHOWN} more...)*`);
    }
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
    if (result.objcTitle) lines.push(`**Objective-C name**: \`${result.objcTitle}\``);
    lines.push(`**Path**: \`${result.path}\` | **Kind**: ${result.kind} | **Role**: ${result.role}`);
    lines.push(`**URL**: ${result.webUrl}`);
    if (result.abstract) lines.push(result.abstract);
    lines.push("");
  }

  return lines.join("\n");
}
