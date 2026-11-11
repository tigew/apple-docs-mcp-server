/**
 * Turning Apple's DocC render JSON into plain text: inline content, content blocks,
 * declarations, and parameter lists.
 */

import { MAX_RECURSION_DEPTH } from "../../constants.js";
import { AppleDocContentItem, AppleDocFragment, AppleDocInlineContent, AppleDocPage, AppleDocParameter, AppleDocReference } from "../../types.js";

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

/**
 * Render DocC content blocks (paragraphs, headings, code listings, asides,
 * tables, lists, ...) as markdown, appending one entry per block to
 * `targetLines`. Each entry ends with a newline.
 */
export function renderContentBlocks(
  items: AppleDocContentItem[],
  references: Record<string, AppleDocReference> | undefined,
  targetLines: string[],
  depth = 0
): void {
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
        renderContentBlocks(item.content, references, innerLines, depth + 1);
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
            renderContentBlocks(cellContent, references, cellLines, depth + 1);
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
          renderContentBlocks(entry.definition.content as AppleDocContentItem[], references, defLines, depth + 1);
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
          renderContentBlocks(listItem.content as AppleDocContentItem[], references, innerLines, depth + 1);
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
    } else if (item.type === "tabNavigator" && Array.isArray(item.tabs)) {
      // Each tab is a titled group of blocks (e.g. "Request" / "Response").
      for (const tab of item.tabs) {
        if (tab?.title) targetLines.push(`**${tab.title}**\n`);
        if (tab?.content) renderContentBlocks(tab.content, references, targetLines, depth + 1);
      }
    } else if (item.type === "row" || item.type === "tabNavigator") {
      // Layout containers: recurse into any nested content
      if (item.content) {
        renderContentBlocks(item.content as AppleDocContentItem[], references, targetLines, depth + 1);
      }
      if (item.items && Array.isArray(item.items)) {
        for (const child of item.items) {
          if (child && typeof child === "object" && "content" in child) {
            renderContentBlocks((child as { content: AppleDocContentItem[] }).content, references, targetLines, depth + 1);
          }
        }
      }
    }
  }
}

export function extractOverview(
  sections: AppleDocPage["primaryContentSections"],
  references?: Record<string, AppleDocReference>
): string {
  if (!sections) return "";

  const contentSection = sections.find((s) => s.kind === "content");
  if (!contentSection?.content) return "";

  const lines: string[] = [];

  renderContentBlocks(contentSection.content as AppleDocContentItem[], references, lines);

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
