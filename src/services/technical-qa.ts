/**
 * Legacy Technical Q&A archive adapter (developer.apple.com/library/archive/qa/*).
 *
 * Static, server-rendered HTML at `qa{NNNN}/_index.html` (the plain `index.html`
 * and trailing-slash forms are JS redirect stubs — always target `_index.html`).
 * This is explicitly superseded content — every page carries an Apple "no longer
 * updated" banner — but individual Q&As are still referenced, so get-by-id is
 * useful. The id space is sparse and non-contiguous, so there is no enumeration.
 */

import { load, type CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import { LEGACY_QA_BASE, LEGACY_QA_HOST } from "../constants.js";
import { fetchHtml } from "./safe-fetch.js";
import { normalizeInline } from "./html-render.js";

export interface TechnicalQa {
  id: string;
  docNumber: string;
  title: string;
  question: string;
  url: string;
  blocks: Array<{ type: "text" | "heading" | "code"; text: string; caption?: string }>;
}

const QA_ID_RE = /^qa\d{3,5}$/i;

export function validateQaId(input: string): string {
  const id = String(input).trim().toLowerCase().replace(/\/?_?index\.html?$/, "").replace(/\/+$/, "");
  const leaf = id.split("/").pop() ?? id;
  if (!QA_ID_RE.test(leaf)) {
    throw new Error(`Invalid Technical Q&A id "${input}": expected a form like "qa1361".`);
  }
  return leaf.toLowerCase();
}

/** Parse a Technical Q&A _index.html page. Returns null for a not-found page. Pure. */
export function parseTechnicalQa(html: string, id: string, url: string): TechnicalQa | null {
  const $: CheerioAPI = load(html);
  const docNumber = normalizeInline($("div.dtsDocNumber").first().text());
  // Real QA pages carry a dtsDocNumber; the 404 page (also text/html) does not.
  if (!docNumber) return null;

  const rawTitle = normalizeInline($("h1#pageTitle").first().text());
  const title = rawTitle.replace(/^Technical Q&A\s+QA\d+:\s*/i, "");

  const contents = $("article#contents").first();
  const questionHeading = contents.find("h2").first();
  const questionNode = questionHeading.get(0);
  const question = normalizeInline(questionHeading.text()).replace(/^Q:\s*/i, "");

  const blocks: TechnicalQa["blocks"] = [];
  contents.children().each((_, el) => {
    const node = $(el as Element);
    const tag = (el as Element).name.toLowerCase();

    // Skip the standard "no longer being updated" boilerplate box.
    if (node.hasClass("importantbox")) return;
    // Skip the question H2 itself — it's already surfaced as `question`, and
    // re-emitting it as a heading duplicates the Q on every page.
    if (el === questionNode) return;

    if (tag === "h2" || tag === "h3") {
      const t = normalizeInline(node.text());
      if (t) blocks.push({ type: "heading", text: t });
      return;
    }
    if (node.hasClass("codesample")) {
      // A code listing: preceding caption may be a sibling p.codesample; the
      // <pre> holds the (entity-encoded) source.
      const code = node.find("pre").first().text().replace(/\s+$/, "");
      const caption = normalizeInline(node.prevAll("p.codesample").first().text());
      if (code) blocks.push({ type: "code", text: code, caption: caption || undefined });
      return;
    }
    if (tag === "p") {
      const t = normalizeInline(node.text());
      if (!t) return;
      // Drop the "A: <question>" echo paragraph (some pages restate the
      // question as the answer lead-in): a bare "A:" or "A:" + the question.
      const withoutMarker = t.replace(/^A:\s*/i, "");
      if (!withoutMarker || withoutMarker === question) return;
      blocks.push({ type: "text", text: t });
    }
  });

  return { id, docNumber, title, question, url, blocks };
}

export async function fetchTechnicalQa(idInput: string): Promise<TechnicalQa> {
  const id = validateQaId(idInput);
  const url = `${LEGACY_QA_BASE}/${id}/_index.html`;
  const { status, html } = await fetchHtml(url, [LEGACY_QA_HOST]);
  if (status === 404) throw new Error(`Technical Q&A "${id}" was not found.`);

  const qa = parseTechnicalQa(html, id, url);
  if (!qa) {
    throw new Error(`Technical Q&A "${id}" was not found (no such archived document).`);
  }
  return qa;
}

export function formatTechnicalQaMarkdown(qa: TechnicalQa): string {
  const lines = [`# ${qa.title || qa.id}`];
  lines.push(`**${qa.docNumber}** | **URL**: ${qa.url}`);
  lines.push("> This is archived, superseded content — verify against current documentation.");
  lines.push("");
  if (qa.question) {
    lines.push(`**Q:** ${qa.question}`);
    lines.push("");
  }
  for (const block of qa.blocks) {
    if (block.type === "heading") {
      lines.push(`## ${block.text}`);
    } else if (block.type === "code") {
      if (block.caption) lines.push(`*${block.caption}*`);
      lines.push("```");
      lines.push(block.text);
      lines.push("```");
    } else {
      lines.push(block.text);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
