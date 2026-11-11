/**
 * Tutorials (developer.apple.com/tutorials/…). These use the same render API
 * as documentation but a different page shape: instead of content sections
 * they have a hero, then chapters of tutorials (a collection), tasks made of
 * steps (a tutorial), or an article body.
 */

import { AppleDocContentItem, AppleDocPage, AppleDocReference } from "../../types.js";
import { extractText, renderContentBlocks } from "./content.js";
import { isTutorialPath, pathFromDocUrl } from "./paths.js";

type References = Record<string, AppleDocReference> | undefined;

interface TutorialStep {
  type?: string;
  content?: AppleDocContentItem[];
  caption?: AppleDocContentItem[];
  /** Identifier of a `file` reference holding the code shown beside the step. */
  code?: string | null;
}

interface TutorialSection {
  kind?: string;
  // hero
  chapter?: string;
  estimatedTimeInMinutes?: number;
  content?: AppleDocContentItem[];
  // volume
  name?: string | null;
  chapters?: Array<{ name?: string; content?: AppleDocContentItem[]; tutorials?: string[] }>;
  // tasks
  tasks?: Array<{
    title?: string;
    contentSection?: Array<{ content?: AppleDocContentItem[] }>;
    stepsSection?: TutorialStep[];
  }>;
  // assessments
  assessments?: Array<{
    title?: AppleDocContentItem[];
    content?: AppleDocContentItem[];
    choices?: Array<{ content?: AppleDocContentItem[]; isCorrect?: boolean; justification?: AppleDocContentItem[] }>;
  }>;
  // callToAction
  title?: string;
  action?: { identifier?: string };
}

/** A source file shown beside a step, as stored in a page's references. */
interface TutorialFile {
  fileName?: string;
  syntax?: string;
  content?: string[];
  /** 1-based lines that changed since the previous step. */
  highlights?: Array<{ line?: number }>;
}

// Lines of unchanged code shown either side of a change in an excerpt.
const EXCERPT_CONTEXT_LINES = 2;

const ROLE_HEADINGS: Record<string, string> = {
  overview: "Tutorials",
  project: "Tutorial",
  article: "Tutorial Article",
};

function lookup(references: References, identifier: string | undefined | null): AppleDocReference | undefined {
  if (!identifier || !references || !Object.prototype.hasOwnProperty.call(references, identifier)) return undefined;
  return references[identifier];
}

/** Content blocks as markdown blocks (no trailing newlines), for joining with blank lines. */
function blocks(content: AppleDocContentItem[] | undefined, references: References): string[] {
  if (!content?.length) return [];
  const rendered: string[] = [];
  renderContentBlocks(content, references, rendered);
  return rendered.map((block) => block.replace(/\n+$/, "")).filter(Boolean);
}

/** Content blocks flattened to one line. */
const inline = (content: AppleDocContentItem[] | undefined, references: References): string =>
  blocks(content, references).join(" ");

/** "3", "3–4", "3–4, 20" for a sorted list of line numbers. */
function formatLineList(lines: number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let end = i;
    while (end + 1 < lines.length && lines[end + 1] === lines[end] + 1) end++;
    ranges.push(end > i ? `${lines[i]}–${lines[end]}` : String(lines[i]));
    i = end;
  }
  return ranges.join(", ");
}

/**
 * The code beside a step. A file is shown whole the first time it appears in
 * a tutorial; after that, Apple repeats the entire file at every step with the
 * changed lines highlighted, so only those lines and a little context are
 * shown, with a "…" line between excerpts that are far apart.
 */
function renderStepCode(file: TutorialFile, seenFiles: Set<string>): string[] {
  const lines = file.content ?? [];
  if (lines.length === 0) return [];
  const name = file.fileName ?? "";
  const label = name ? `\`${name}\`` : "";
  const fence = `\`\`\`${file.syntax ?? ""}`;

  const changed = [...new Set((file.highlights ?? []).map((highlight) => highlight.line ?? 0))]
    .filter((line) => line >= 1 && line <= lines.length)
    .sort((a, b) => a - b);

  const firstAppearance = !seenFiles.has(name);
  seenFiles.add(name);
  if (firstAppearance || changed.length === 0) {
    return [[label, fence, ...lines, "```"].filter((line, index) => index !== 0 || line).join("\n")];
  }

  const excerpt: string[] = [];
  let shownThrough = 0;
  for (const line of changed) {
    const from = Math.max(line - EXCERPT_CONTEXT_LINES, shownThrough + 1);
    const to = Math.min(line + EXCERPT_CONTEXT_LINES, lines.length);
    if (from > to) continue;
    if (shownThrough > 0 && from > shownThrough + 1) excerpt.push("…");
    excerpt.push(...lines.slice(from - 1, to));
    shownThrough = to;
  }
  const heading = `${label ? `${label} — ` : ""}changed ${changed.length === 1 ? "line" : "lines"} ${formatLineList(changed)}`;
  return [[heading, fence, ...excerpt, "```"].join("\n")];
}

/** One list line for a tutorial inside a chapter. */
function renderTutorialLink(identifier: string, references: References): string | null {
  const reference = lookup(references, identifier);
  const path = pathFromDocUrl(reference?.url) ?? pathFromDocUrl(identifier);
  if (!path) return null;
  const title = reference?.title ?? path.split("/").pop() ?? path;
  const estimatedTime = (reference as { estimatedTime?: string } | undefined)?.estimatedTime;
  const notes = [extractText(reference?.abstract, references), estimatedTime].filter(Boolean).join(" · ");
  return `- **${title}** (path: \`${path}\`)${notes ? ` — ${notes}` : ""}`;
}

/**
 * Render a tutorial page. Returns null for any page that is not one, so
 * ordinary documentation is untouched.
 */
export function extractTutorialContent(
  page: AppleDocPage
): { roleHeading: string; abstract: string; overview: string } | null {
  const path = pathFromDocUrl(page.identifier?.url);
  const sections = page.sections as TutorialSection[] | undefined;
  if (!path || !isTutorialPath(path) || !sections?.length) return null;

  const references = page.references;
  const out: string[] = [];
  const seenFiles = new Set<string>();
  let abstract = "";

  for (const section of sections) {
    switch (section.kind) {
      case "hero": {
        abstract = inline(section.content, references);
        const estimatedTime =
          (page.metadata as { estimatedTime?: string } | undefined)?.estimatedTime ??
          (section.estimatedTimeInMinutes ? `${section.estimatedTimeInMinutes} min` : "");
        const facts = [
          section.chapter ? `**Chapter**: ${section.chapter}` : "",
          estimatedTime ? `**Estimated time**: ${estimatedTime}` : "",
        ].filter(Boolean);
        if (facts.length) out.push(facts.join(" · "));
        break;
      }
      case "volume": {
        if (section.name) out.push(`## ${section.name}`);
        out.push(...blocks(section.content, references));
        for (const chapter of section.chapters ?? []) {
          if (chapter.name) out.push(`### ${chapter.name}`);
          out.push(...blocks(chapter.content, references));
          const links = (chapter.tutorials ?? [])
            .map((identifier) => renderTutorialLink(identifier, references))
            .filter((link): link is string => link !== null);
          if (links.length) out.push(links.join("\n"));
        }
        break;
      }
      case "articleBody": {
        // The body is a list of layout groups, each holding ordinary blocks.
        for (const group of (section.content ?? []) as Array<{ content?: AppleDocContentItem[] }>) {
          out.push(...blocks(group?.content, references));
        }
        break;
      }
      case "tasks": {
        for (const task of section.tasks ?? []) {
          if (task.title) out.push(`## ${task.title}`);
          for (const group of task.contentSection ?? []) out.push(...blocks(group.content, references));
          let stepNumber = 0;
          for (const step of task.stepsSection ?? []) {
            const text = inline(step.content, references);
            // Only real steps are numbered; notes between them are shown as they are.
            if (step.type === "step") out.push(`**Step ${++stepNumber}.** ${text}`.trim());
            else if (text) out.push(text);
            const file = lookup(references, step.code) as TutorialFile | undefined;
            if (file) out.push(...renderStepCode(file, seenFiles));
            out.push(...blocks(step.caption, references));
          }
        }
        break;
      }
      case "assessments": {
        const assessments = section.assessments ?? [];
        if (assessments.length) out.push("## Check Your Understanding");
        assessments.forEach((assessment, index) => {
          const question = [inline(assessment.title, references), inline(assessment.content, references)]
            .filter(Boolean)
            .join(" ");
          out.push(`**Question ${index + 1}.** ${question}`.trim());
          const choices = (assessment.choices ?? []).map((choice) => {
            const answer = inline(choice.content, references);
            const why = inline(choice.justification, references);
            return `- ${choice.isCorrect ? `**${answer} (correct)**` : answer}${why ? ` — ${why}` : ""}`;
          });
          if (choices.length) out.push(choices.join("\n"));
        });
        break;
      }
      case "callToAction": {
        const next = lookup(references, section.action?.identifier);
        const nextPath = pathFromDocUrl(next?.url) ?? pathFromDocUrl(section.action?.identifier);
        const title = section.title ?? next?.title;
        if (title && nextPath) out.push(`**Next**: ${title} (path: \`${nextPath}\`)`);
        break;
      }
    }
  }

  return {
    roleHeading: ROLE_HEADINGS[page.kind ?? ""] ?? "Tutorial",
    abstract,
    overview: out.join("\n\n"),
  };
}
