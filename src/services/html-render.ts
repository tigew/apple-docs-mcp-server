/**
 * Shared helpers for turning a scraped HTML subtree into readable, lightly
 * structured plain text (used by the support-KB, Technical-Q&A, and marketing
 * readers). Block-level elements become newline-separated; list items get a
 * bullet; tables render as GitHub-flavored markdown.
 */

import type { CheerioAPI, Cheerio } from "cheerio";
import type { AnyNode, Element } from "domhandler";

const BLOCK_TAGS = new Set([
  "p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "div", "ul", "ol", "section", "tr", "pre",
]);

// Non-content tags whose text must never leak into extracted prose (inline
// <style>/<script> blocks otherwise dump raw CSS/JS into the output).
const SKIP_TAGS = new Set(["style", "script", "noscript", "svg", "head", "link", "meta", "template", "iframe"]);

export function normalizeInline(text: string): string {
  return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/** Render a table element to markdown rows. */
function renderTable($: CheerioAPI, table: Cheerio<Element>): string {
  const rows: string[][] = [];
  table.find("tr").each((_, tr) => {
    const cells: string[] = [];
    $(tr)
      .find("th, td")
      .each((__, cell) => {
        cells.push(normalizeInline($(cell).text()).replace(/\|/g, "\\|"));
      });
    if (cells.length) rows.push(cells);
  });
  if (rows.length === 0) return "";
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 1);
  const pad = (r: string[]) => {
    const c = [...r];
    while (c.length < cols) c.push("");
    return c;
  };
  const out = [`| ${pad(rows[0]).join(" | ")} |`, `| ${Array(cols).fill("---").join(" | ")} |`];
  for (const r of rows.slice(1)) out.push(`| ${pad(r).join(" | ")} |`);
  return out.join("\n");
}

/**
 * Render an element subtree to readable text. `headingTags` are emitted as
 * markdown headings; tables are rendered as markdown and not descended into.
 */
export function renderBlockText(
  $: CheerioAPI,
  root: Cheerio<AnyNode>,
  headingTags: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"])
): string {
  const out: string[] = [];

  const walk = (n: Cheerio<AnyNode>): void => {
    n.contents().each((_, child) => {
      if (child.type === "text") {
        out.push((child as { data?: string }).data ?? "");
        return;
      }
      if (child.type !== "tag") return;
      const el = child as Element;
      const tag = el.name.toLowerCase();

      if (SKIP_TAGS.has(tag)) return;
      if (tag === "br") {
        out.push("\n");
        return;
      }
      if (tag === "table") {
        const md = renderTable($, $(el) as Cheerio<Element>);
        if (md) out.push(`\n${md}\n`);
        return; // don't descend — already rendered
      }
      if (headingTags.has(tag)) {
        const level = Number(tag.slice(1)) || 2;
        out.push(`\n${"#".repeat(level)} ${normalizeInline($(el).text())}\n`);
        return;
      }

      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) out.push("\n");
      if (tag === "li") out.push("- ");
      walk($(el));
      if (isBlock) out.push("\n");
    });
  };

  walk(root);
  return out
    .join("")
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
