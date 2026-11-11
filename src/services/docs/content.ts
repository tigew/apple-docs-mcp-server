/**
 * Turning Apple's DocC render JSON into plain text and parsed structures.
 */

import { MAX_RECURSION_DEPTH } from "../../constants.js";
import { AppleDocContentItem, AppleDocFragment, AppleDocGroup, AppleDocInlineContent, AppleDocPage, AppleDocParameter, AppleDocReference, AppleDocSection, AppleDocTechnologyEntry, ParsedSymbol, ParsedTechnologies } from "../../types.js";
import { buildWebUrl, normalizeDocUrl, normalizePath, pathFromDocUrl } from "./paths.js";

export function resolveReferenceItems(
  identifiers: string[] | undefined,
  references: Record<string, AppleDocReference> | undefined
): ParsedSymbol["topicSections"][number]["items"] {
  if (!identifiers?.length || !references) return [];

  return identifiers
    .map((id) => {
      const ref = Object.prototype.hasOwnProperty.call(references, id) ? references[id] : undefined;
      if (!ref) return null;
      const refPath = pathFromDocUrl(ref.url);
      return {
        title: ref.title ?? id,
        path: refPath ?? (ref.url ?? ""),
        abstract: extractText(ref.abstract, references),
        kind: ref.kind ?? "unknown",
        role: ref.role ?? "unknown",
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

export function markdownTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n+/g, "<br>").trim();
}

/**
 * Normalize a DocC table row into an array of cells, each a content-block array.
 *
 * DocC's render schema encodes a row as `Cell[][]` — the row is itself the array
 * of cells and each cell is an array of content blocks. (An older shape wrapped
 * the cells in `{ cells: [{ content: [...] }] }`.) The previous converter only
 * understood the wrapped shape, so `row.cells` was always undefined for real
 * pages and every data row was dropped — table-bearing pages (e.g. Technote
 * TN3191, HIG articles) rendered as an empty `|  |` / `| --- |` husk. Accept
 * both shapes here so rows survive.
 */
export function tableRowCells(row: unknown): AppleDocContentItem[][] {
  if (Array.isArray(row)) {
    return row.map((cell) => (Array.isArray(cell) ? (cell as AppleDocContentItem[]) : []));
  }
  const wrapped = (row as { cells?: unknown })?.cells;
  if (Array.isArray(wrapped)) {
    return wrapped.map((cell) => {
      if (Array.isArray(cell)) return cell as AppleDocContentItem[];
      const content = (cell as { content?: unknown })?.content;
      return Array.isArray(content) ? (content as AppleDocContentItem[]) : [];
    });
  }
  return [];
}

export function extractTechnologyItem(
  technology: AppleDocTechnologyEntry,
  references: Record<string, AppleDocReference> | undefined
): ParsedTechnologies["sections"][number]["technologies"][number] | null {
  const destinationId = technology.destination?.identifier;
  const ref = destinationId && references
    ? (Object.prototype.hasOwnProperty.call(references, destinationId) ? references[destinationId] : undefined)
    : undefined;
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

export function extractTechnologySectionFromGroup(
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
    const ref = references && Object.prototype.hasOwnProperty.call(references, identifier)
      ? references[identifier]
      : undefined;
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

// ---------------------------------------------------------------------------
// Inline content / text extraction
// ---------------------------------------------------------------------------

export function extractText(
  content: AppleDocInlineContent[] | undefined,
  references?: Record<string, AppleDocReference>,
  depth = 0
): string {
  if (!content || depth > MAX_RECURSION_DEPTH) return "";
  return content
    .map((item) => {
      if (item.type === "text") return item.text ?? "";
      if (item.type === "codeVoice") return `\`${item.code ?? ""}\``;
      if (item.type === "emphasis") {
        const inner = extractText(item.inlineContent as AppleDocInlineContent[] | undefined, references, depth + 1);
        return inner ? `*${inner}*` : "";
      }
      if (item.type === "strong") {
        const inner = extractText(item.inlineContent as AppleDocInlineContent[] | undefined, references, depth + 1);
        return inner ? `**${inner}**` : "";
      }
      if (item.type === "strikethrough") {
        const inner = extractText(item.inlineContent as AppleDocInlineContent[] | undefined, references, depth + 1);
        return inner ? `~~${inner}~~` : "";
      }
      if (item.type === "subscript") {
        const inner = extractText(item.inlineContent as AppleDocInlineContent[] | undefined, references, depth + 1);
        return inner ? `<sub>${inner}</sub>` : "";
      }
      if (item.type === "superscript") {
        const inner = extractText(item.inlineContent as AppleDocInlineContent[] | undefined, references, depth + 1);
        return inner ? `<sup>${inner}</sup>` : "";
      }
      if (item.type === "newTerm") return `*${item.text ?? ""}*`;
      if (item.type === "link") {
        if (item.title && item.destination) return `[${item.title}](${item.destination})`;
        return item.destination ?? item.title ?? "";
      }
      if (item.type === "image") {
        const imgId = item.identifier ?? "";
        if (references && imgId && Object.prototype.hasOwnProperty.call(references, imgId)) {
          const imgRef = references[imgId];
          const alt = imgRef.alt ?? "Image";
          const variants = imgRef.variants;
          const url = variants?.[0]?.url ?? "";
          return url ? `![${alt}](${url})` : `[${alt}]`;
        }
        return "[Image]";
      }
      if (item.type === "reference") {
        const id = item.identifier ?? "";
        if (references && Object.prototype.hasOwnProperty.call(references, id) && references[id]?.title) {
          return references[id].title!;
        }
        const lastSegment = id.split("/").pop();
        return lastSegment ?? id;
      }
      // Fallback: try to extract text from inlineContent for unknown types
      if (item.inlineContent) {
        return extractText(item.inlineContent as AppleDocInlineContent[] | undefined, references, depth + 1);
      }
      return item.text ?? "";
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

  function processItems(items: AppleDocContentItem[], targetLines: string[], depth = 0): void {
    if (depth > MAX_RECURSION_DEPTH) return;
    if (!items || !Array.isArray(items)) return;

    for (const item of items) {
      if (item.type === "heading") {
        const level = Math.max(1, Math.min(6, item.level ?? 2));
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
        const style = item.style ? `**[${item.style.toUpperCase()}]** ` : "";
        if (item.content) {
          const innerLines: string[] = [];
          processItems(item.content, innerLines, depth + 1);
          if (innerLines.length) {
            const combined = innerLines.map((l, i) => {
              const prefix = i === 0 ? style : "";
              return `> ${prefix}${l}`;
            }).join("");
            targetLines.push(`${combined}\n`);
          }
        }
      } else if (item.type === "table") {
        if (item.rows && Array.isArray(item.rows) && item.rows.length > 0) {
          const renderedRows: string[][] = [];
          for (const row of item.rows) {
            const cellContents = tableRowCells(row);
            if (cellContents.length === 0) continue;
            const cells: string[] = [];
            for (const cellContent of cellContents) {
              const cellLines: string[] = [];
              processItems(cellContent, cellLines, depth + 1);
              cells.push(cellLines.map((l) => l.replace(/\n$/, "")).join(" ").trim());
            }
            renderedRows.push(cells);
          }
          const colCount = renderedRows.reduce((max, r) => Math.max(max, r.length), 1);
          if (item.header === "row" && renderedRows.length > 0) {
            const headerRow = renderedRows[0].map((cell) => markdownTableCell(cell || " "));
            while (headerRow.length < colCount) headerRow.push(" ");
            targetLines.push(`| ${headerRow.join(" | ")} |\n`);
            targetLines.push(`| ${Array(colCount).fill("---").join(" | ")} |\n`);
            for (const row of renderedRows.slice(1)) {
              while (row.length < colCount) row.push("");
              targetLines.push(`| ${row.map((cell) => markdownTableCell(cell)).join(" | ")} |\n`);
            }
          } else {
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
            processItems(entry.definition.content as AppleDocContentItem[], defLines, depth + 1);
            for (const dl of defLines) {
              targetLines.push(dl);
            }
          }
          targetLines.push("\n");
        }
      } else if (item.type === "unorderedList" || item.type === "orderedList") {
        const listItems = (item.items ?? []) as AppleDocContentItem[];
        listItems.forEach((listItem, index) => {
          const bullet = item.type === "orderedList" ? `${index + 1}. ` : "- ";
          if (listItem.content) {
            const innerLines: string[] = [];
            processItems(listItem.content as AppleDocContentItem[], innerLines, depth + 1);
            const text = innerLines.map((l) => l.replace(/\n$/, "")).join(" ");
            if (text) targetLines.push(`${bullet}${text}\n`);
          }
        });
      } else if (item.type === "links") {
        // Handle links blocks (curated link lists)
        const linkItems = item.items;
        if (linkItems && Array.isArray(linkItems) && references) {
          for (const rawLinkId of linkItems) {
            if (typeof rawLinkId !== "string") continue;
            const linkId = rawLinkId;
            if (Object.prototype.hasOwnProperty.call(references, linkId)) {
              const linkRef = references[linkId];
              const title = linkRef.title ?? linkId.split("/").pop() ?? linkId;
              const abstract = extractText(linkRef.abstract, references);
              const suffix = abstract ? ` — ${abstract}` : "";
              targetLines.push(`- **${title}**${suffix}\n`);
            }
          }
        }
      } else if (item.type === "row" || item.type === "tabNavigator") {
        // Layout containers: recurse into any nested content
        if (item.content) {
          processItems(item.content as AppleDocContentItem[], targetLines, depth + 1);
        }
        if (item.items && Array.isArray(item.items)) {
          for (const child of item.items) {
            if (child && typeof child === "object" && "content" in child) {
              processItems((child as { content: AppleDocContentItem[] }).content, targetLines, depth + 1);
            }
          }
        }
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

export function extractParameters(
  sections: AppleDocPage["primaryContentSections"],
  references?: Record<string, AppleDocReference>
): Array<{ name: string; description: string }> | undefined {
  if (!sections) return undefined;

  const paramSection = sections.find((s) => s.kind === "parameters");
  if (!paramSection?.parameters?.length) return undefined;

  const params = paramSection.parameters
    .map((p: AppleDocParameter) => ({
      name: p.name,
      description: (p.content ?? [])
        .filter((item) => item.type === "paragraph" && item.inlineContent)
        .map((item) => extractText(item.inlineContent, references))
        .filter(Boolean)
        .join(" "),
    }))
    .filter((p) => p.name);

  return params.length > 0 ? params : undefined;
}

export function extractBreadcrumb(
  hierarchy: AppleDocPage["hierarchy"],
  references?: Record<string, AppleDocReference>
): string[] | undefined {
  if (!hierarchy?.paths?.length) return undefined;
  const path = hierarchy.paths[0];
  if (!path?.length) return undefined;

  const crumbs = path
    .map((id) => {
      if (!references || !Object.prototype.hasOwnProperty.call(references, id)) {
        return id.split("/").pop() ?? id;
      }
      return references[id].title ?? id.split("/").pop() ?? id;
    })
    .filter((c) => c && c !== "Technologies");

  return crumbs.length > 0 ? crumbs : undefined;
}

export function extractDeprecationInfo(metadata: AppleDocPage["metadata"]): {
  deprecated: boolean;
  deprecatedAt?: string;
  deprecationMessage?: string;
} {
  const plats = metadata?.platforms ?? [];
  const deprecatedPlatforms = plats.filter((p) => p.deprecated || p.deprecatedAt);
  if (deprecatedPlatforms.length === 0) return { deprecated: false };

  // If all platforms are deprecated, mark the whole symbol as deprecated
  const allDeprecated = plats.length > 0 && deprecatedPlatforms.length === plats.length;

  // Find the earliest deprecation version for display
  const deprecatedAt = deprecatedPlatforms
    .filter((p) => p.deprecatedAt)
    .map((p) => `${p.name} ${p.deprecatedAt}`)
    .join(", ");

  // Extract deprecation message or renamed info if available
  const messageEntries = deprecatedPlatforms
    .filter((p) => p.message || p.renamed)
    .map((p) => p.renamed ? `Use ${p.renamed} instead.` : p.message!);
  // Dedupe messages (often the same across platforms)
  const uniqueMessages = [...new Set(messageEntries)];
  const deprecationMessage = uniqueMessages.length > 0 ? uniqueMessages.join(" ") : undefined;

  return {
    deprecated: allDeprecated,
    deprecatedAt: deprecatedAt || undefined,
    deprecationMessage,
  };
}

// ---------------------------------------------------------------------------
// Parsers for specific response shapes
// ---------------------------------------------------------------------------

export function parseDocPage(page: AppleDocPage, path: string): ParsedSymbol {
  const meta = page.metadata ?? {};
  const title = meta.title || page.identifier?.url || path;
  const kind = page.kind ?? "unknown";
  const role = meta.role ?? "unknown";
  const canonicalPath = pathFromDocUrl(page.identifier?.url) ?? normalizePath(path);

  const refs = page.references;
  const abstract = extractText(page.abstract, refs);
  const declaration = extractDeclaration(page.primaryContentSections);
  const overview = extractOverview(page.primaryContentSections, refs);
  const parameters = extractParameters(page.primaryContentSections, refs);
  const breadcrumb = extractBreadcrumb(page.hierarchy, refs);
  const deprecation = extractDeprecationInfo(meta);

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
    items: (section.identifiers ?? []).map((id) => {
      const ref = page.references && Object.prototype.hasOwnProperty.call(page.references, id) ? page.references[id] : undefined;
      const refPath = pathFromDocUrl(ref?.url);
      return {
        title: ref?.title ?? id,
        path: refPath ?? (ref?.url ?? ""),
      };
    }),
  }));

  // Parse seeAlsoSections
  const seeAlsoSections = (page.seeAlsoSections ?? []).map((section) => ({
    title: section.title,
    items: resolveReferenceItems(section.identifiers, refs),
  }));

  const webUrl = buildWebUrl(canonicalPath);

  const moduleName = meta.modules?.[0]?.name;

  return {
    title,
    kind,
    role,
    roleHeading: meta.roleHeading || undefined,
    symbolKind: meta.symbolKind || undefined,
    module: moduleName || undefined,
    abstract,
    declaration: declaration || undefined,
    parameters,
    platforms,
    deprecated: deprecation.deprecated || undefined,
    deprecatedAt: deprecation.deprecatedAt || undefined,
    deprecationMessage: deprecation.deprecationMessage || undefined,
    breadcrumb,
    path: canonicalPath,
    webUrl,
    topicSections,
    relationships,
    seeAlsoSections,
    overview,
  };
}

export function parseTechnologies(page: AppleDocPage): ParsedTechnologies {
  const sections: ParsedTechnologies["sections"] = [];

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
          const ref = page.references && Object.prototype.hasOwnProperty.call(page.references, id) ? page.references[id] : undefined;
          if (!ref) return null;
          return {
            title: ref.title ?? id,
            url: ref.url ? normalizeDocUrl(ref.url) : "",
            abstract: extractText(ref.abstract, page.references),
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
