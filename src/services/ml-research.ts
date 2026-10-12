/**
 * machinelearning.apple.com research adapter.
 *
 * The site is Next.js; its `__NEXT_DATA__` JSON island carries the full post
 * catalog (list page) and every field of a single post — so this is effectively
 * a clean JSON source, no DOM scraping of prose required.
 */

import { load } from "cheerio";
import { ML_RESEARCH_HOST, ML_RESEARCH_LIST_URL, ML_RESEARCH_POST_BASE } from "../constants.js";
import { fetchHtml } from "./safe-fetch.js";
import { normalizeInline, renderBlockText } from "./html-render.js";

export interface MlResearchListEntry {
  slug: string;
  title: string;
  authors: string;
  published: string;
  type: string;
  tags: string[];
}

export interface MlResearchPost extends MlResearchListEntry {
  url: string;
  body: string;
  links: Array<{ title: string; url: string }>;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateResearchSlug(input: string): string {
  const slug = String(input).trim().toLowerCase().replace(/^\/?research\//, "").replace(/\/+$/, "");
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Invalid research slug "${input}": expected a form like "environment-free".`);
  }
  return slug;
}

/** Extract and parse the __NEXT_DATA__ JSON island. Pure. */
export function extractNextData(html: string): Record<string, unknown> {
  const raw = load(html)("#__NEXT_DATA__").first().html();
  if (!raw) throw new Error("Could not locate __NEXT_DATA__ on the page (site layout may have changed).");
  const data = JSON.parse(raw);
  if (!data || typeof data !== "object") throw new Error("Malformed __NEXT_DATA__ payload.");
  return data as Record<string, unknown>;
}

function pageProps(data: Record<string, unknown>): Record<string, unknown> {
  const props = (data.props as { pageProps?: unknown } | undefined)?.pageProps;
  return props && typeof props === "object" ? (props as Record<string, unknown>) : {};
}

/** Strip HTML tags / affiliation markers to a clean one-line string. */
function plainText(html: string | undefined): string {
  if (!html) return "";
  return normalizeInline(load(`<div>${html}</div>`).text());
}

function cleanAuthors(authorsOrdered: unknown): string {
  if (typeof authorsOrdered !== "string") return "";
  // Strip affiliation markers like † ** ‡ that trail author names.
  return authorsOrdered.replace(/[†‡*§¶]/g, "").replace(/\s+,/g, ",").replace(/\s{2,}/g, " ").trim();
}

function toListEntry(post: Record<string, unknown>): MlResearchListEntry {
  return {
    slug: typeof post.slug === "string" ? post.slug : "",
    title: plainText(typeof post.title === "string" ? post.title : ""),
    authors: cleanAuthors(post.authorsOrdered),
    published: typeof post.published === "string" ? post.published : "",
    type: typeof post.type === "string" ? post.type : "",
    // Tags are objects ({ name, type, color, ... }); surface their `name`.
    // Tolerate a bare string too, in case the shape ever changes.
    tags: Array.isArray(post.tags)
      ? post.tags
          .map((t) => {
            if (typeof t === "string") return t;
            if (t && typeof t === "object" && typeof (t as Record<string, unknown>).name === "string") {
              return String((t as Record<string, unknown>).name);
            }
            return "";
          })
          .filter(Boolean)
      : [],
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export async function fetchMlResearchList(limit: number): Promise<MlResearchListEntry[]> {
  const { html } = await fetchHtml(ML_RESEARCH_LIST_URL, [ML_RESEARCH_HOST]);
  const posts = pageProps(extractNextData(html)).posts;
  if (!Array.isArray(posts)) return [];
  return posts
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map(toListEntry)
    .filter((e) => e.slug)
    .slice(0, limit);
}

export async function fetchMlResearchPost(slugInput: string): Promise<MlResearchPost> {
  const slug = validateResearchSlug(slugInput);
  const url = `${ML_RESEARCH_POST_BASE}/${slug}`;
  const { status, html } = await fetchHtml(url, [ML_RESEARCH_HOST]);
  if (status === 404) throw new Error(`ML research post "${slug}" was not found.`);

  const posts = pageProps(extractNextData(html)).posts;
  const post = Array.isArray(posts) && posts[0] && typeof posts[0] === "object" ? (posts[0] as Record<string, unknown>) : null;
  if (!post) throw new Error(`Could not extract research post "${slug}".`);

  const base = toListEntry(post);
  const bodyHtml = typeof post.body === "string" ? post.body : "";
  const $body = load(bodyHtml);
  const body = renderBlockText($body, $body("body").length ? $body("body") : $body.root());

  const links: Array<{ title: string; url: string }> = [];
  if (Array.isArray(post.links)) {
    for (const link of post.links) {
      if (link && typeof link === "object") {
        const l = link as Record<string, unknown>;
        const u = typeof l.url === "string" ? l.url : "";
        if (u) links.push({ title: typeof l.title === "string" && l.title ? l.title : u, url: u });
      }
    }
  }

  return { ...base, slug, url, body, links };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatMlResearchListMarkdown(entries: MlResearchListEntry[]): string {
  const lines = [
    "# Apple Machine Learning Research",
    `Source: ${ML_RESEARCH_LIST_URL}`,
    "",
    "Pass a `slug` to read a specific post.",
    "",
  ];
  for (const e of entries) {
    const meta = [e.published, e.type].filter(Boolean).join(" · ");
    lines.push(`- **${e.title}** (\`${e.slug}\`)${meta ? ` — ${meta}` : ""}`);
    if (e.authors) lines.push(`  ${e.authors}`);
  }
  return lines.join("\n");
}

export function formatMlResearchPostMarkdown(post: MlResearchPost): string {
  const lines = [`# ${post.title}`];
  const meta = [post.published, post.type].filter(Boolean).join(" · ");
  if (meta) lines.push(`**${meta}**`);
  if (post.authors) lines.push(`**Authors**: ${post.authors}`);
  lines.push(`**URL**: ${post.url}`);
  lines.push("");
  if (post.body) {
    lines.push(post.body);
    lines.push("");
  }
  if (post.tags.length) lines.push(`**Tags**: ${post.tags.join(", ")}`);
  if (post.links.length) {
    lines.push("## Links");
    for (const l of post.links) lines.push(`- [${l.title}](${l.url})`);
  }
  return lines.join("\n").trim();
}
