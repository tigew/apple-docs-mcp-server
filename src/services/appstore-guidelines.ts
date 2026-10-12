/**
 * App Store Review Guidelines scraper.
 *
 * The guidelines are a single server-rendered HTML page where every numbered
 * guideline carries a stable numeric id (`1`, `2.3`, `2.3.1`, ...). We fetch the
 * page once and either return a table-of-contents index or the self-contained
 * subtree for one addressable section (e.g. "2.3.1").
 */

import { load, type CheerioAPI, type Cheerio } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { APP_STORE_REVIEW_GUIDELINES_URL, APP_STORE_REVIEW_HOST } from "../constants.js";
import { fetchHtml } from "./safe-fetch.js";

export interface GuidelineTocEntry {
  number: string;
  title: string;
}

export interface GuidelineSection {
  number: string;
  title: string;
  text: string;
}

const NUMERIC_ID = /^\d+(?:\.\d+)*$/;
// The guideline body lives inside this container; scoping to it avoids picking
// up unrelated numeric ids from the global nav/footer chrome.
const CONTENT_SCOPE = "#content-container";

/** Reject anything that isn't a dotted guideline number before it touches a selector. */
export function validateGuidelineNumber(input: string): string {
  const n = String(input).trim();
  if (!NUMERIC_ID.test(n)) {
    throw new Error(`Invalid guideline number "${input}": expected a form like "2", "2.3", or "2.3.1".`);
  }
  return n;
}

const BLOCK_TAGS = new Set(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "div", "ul", "ol", "section"]);

/** Render an element subtree to readable, lightly-structured plain text. */
function renderText($: CheerioAPI, node: Cheerio<AnyNode>): string {
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
      if (tag === "br") {
        out.push("\n");
        return;
      }
      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) out.push("\n");
      if (tag === "li") out.push("- ");
      walk($(el));
      if (isBlock) out.push("\n");
    });
  };
  walk(node);
  return out
    .join("")
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function inlineText(node: Cheerio<AnyNode>): string {
  return node.text().replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/** Best-effort human title for a node carrying a numeric id. */
function titleFor($: CheerioAPI, node: Cheerio<Element>): string {
  const own = node.attr("data-sidenav");
  if (own) return own.trim();
  const ancestor = node.closest("[data-sidenav]");
  const inherited = ancestor.attr("data-sidenav");
  if (inherited) return inherited.trim();
  // Top-level sections are h3 text like "1. Safety".
  const h3 = node.closest("h3");
  if (h3.length) return inlineText(h3);
  return "";
}

/** Build the table-of-contents index (number + title) from the page. Pure. */
export function parseGuidelinesIndex(html: string): GuidelineTocEntry[] {
  const $ = load(html);
  const scope = $(CONTENT_SCOPE).length ? $(CONTENT_SCOPE) : $("body");
  const seen = new Set<string>();
  const entries: GuidelineTocEntry[] = [];

  scope.find("[id]").each((_, el) => {
    const node = $(el as Element);
    const id = node.attr("id");
    if (!id || !NUMERIC_ID.test(id) || seen.has(id)) return;
    // Top-level (1) and second-level (2.3) numbers live on a <span>; third-level
    // sub-points (2.3.1) live on their <li> and would only echo the parent's
    // title. Keep the index to the two titled levels — every sub-point is still
    // addressable directly via getGuidelineSection.
    if ((el as Element).name.toLowerCase() !== "span") return;
    const title = titleFor($, node);
    if (!title) return;
    seen.add(id);
    entries.push({ number: id, title });
  });

  entries.sort((a, b) => compareNumbers(a.number, b.number));
  return entries;
}

/** Extract one addressable section's self-contained text. Pure. */
export function parseGuidelineSection(html: string, number: string): GuidelineSection | null {
  const $ = load(html);
  const scope = $(CONTENT_SCOPE).length ? $(CONTENT_SCOPE) : $("body");
  const node = scope.find(`[id="${number}"]`).first();
  if (node.length === 0) return null;

  const tag = (node.get(0) as Element).name.toLowerCase();
  const title = titleFor($, node as Cheerio<Element>) || number;

  // Level-3 ids sit directly on the <li>; its subtree already contains the
  // nested (a)/(b) sub-points.
  if (tag === "li") {
    return { number, title, text: renderText($, node) };
  }

  // Top-level sections: the numeric id is a <span> inside an <h3>; the body is
  // the h3 plus its following siblings up to the next h3.
  const h3 = node.closest("h3");
  if (h3.length) {
    const parts = [inlineText(h3)];
    h3.nextUntil("h3").each((_, sib) => {
      const t = renderText($, $(sib as Element));
      if (t) parts.push(t);
    });
    return { number, title: inlineText(h3), text: parts.join("\n\n").trim() };
  }

  // Second-level: the numeric id is a <span> inside its <li>.
  const li = node.closest("li");
  if (li.length) {
    return { number, title, text: renderText($, li) };
  }

  return { number, title, text: renderText($, node) };
}

function compareNumbers(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchGuidelinesHtml(): Promise<string> {
  const { html } = await fetchHtml(APP_STORE_REVIEW_GUIDELINES_URL, [APP_STORE_REVIEW_HOST]);
  return html;
}

export async function fetchGuidelinesIndex(): Promise<GuidelineTocEntry[]> {
  return parseGuidelinesIndex(await fetchGuidelinesHtml());
}

export async function fetchGuidelineSection(numberInput: string): Promise<GuidelineSection> {
  const number = validateGuidelineNumber(numberInput);
  const section = parseGuidelineSection(await fetchGuidelinesHtml(), number);
  if (!section) {
    throw new Error(
      `App Store Review Guideline "${number}" was not found. Fetch without a section number to see the ` +
        `list of available guideline numbers.`
    );
  }
  return section;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatGuidelinesIndexMarkdown(entries: GuidelineTocEntry[]): string {
  const lines = [
    "# App Store Review Guidelines — Sections",
    `Source: ${APP_STORE_REVIEW_GUIDELINES_URL}`,
    "",
    "Pass a `section` number (e.g. \"2.3.1\") to read a specific guideline.",
    "",
  ];
  for (const entry of entries) {
    const indent = "  ".repeat(Math.max(0, entry.number.split(".").length - 1));
    lines.push(`${indent}- **${entry.number}** ${entry.title}`);
  }
  return lines.join("\n");
}

export function formatGuidelineSectionMarkdown(section: GuidelineSection): string {
  return [
    `# App Store Review Guideline ${section.number}`,
    section.title && section.title !== section.number ? `**${section.title}**` : "",
    `**URL**: ${APP_STORE_REVIEW_GUIDELINES_URL}#${section.number}`,
    "",
    section.text,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
