/**
 * Parsing whole DocC pages into the structures the tools return.
 */

import { AppleDocGroup, AppleDocPage, AppleDocReference, AppleDocSection, AppleDocTechnologyEntry, ParsedSymbol, ParsedTechnologies } from "../../types.js";
import {
  extractDeclaration,
  extractDeclarationLanguage,
  extractOverview,
  extractParameters,
  extractText,
} from "./content.js";
import { extractRestSections } from "./rest.js";
import { extractTutorialContent } from "./tutorials.js";
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
    // "$volume" is a placeholder Apple puts in tutorial hierarchies for an unnamed volume.
    .filter((c) => c && c !== "Technologies" && !c.startsWith("$"));

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

// Sample-code archives are published under this base; a page refers to its
// archive by a path relative to it.
const SAMPLE_CODE_DOWNLOAD_BASE = "https://docs-assets.developer.apple.com/published/";

/** The https URL of a sample-code page's downloadable project, if it has one. */
function extractSampleCodeDownloadUrl(page: AppleDocPage): string | undefined {
  const identifier = page.sampleCodeDownload?.action?.identifier;
  if (!identifier || !page.references || !Object.prototype.hasOwnProperty.call(page.references, identifier)) {
    return undefined;
  }
  const location = page.references[identifier].url;
  if (!location) return undefined;
  try {
    const url = new URL(location, SAMPLE_CODE_DOWNLOAD_BASE);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

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
  // Tutorials have a hero and tasks rather than content sections.
  const tutorial = extractTutorialContent(page);
  const sampleCodeDownloadUrl = extractSampleCodeDownloadUrl(page);

  const moduleName = meta.modules?.[0]?.name;

  return {
    title,
    kind,
    role,
    roleHeading: meta.roleHeading || tutorial?.roleHeading || undefined,
    symbolKind: meta.symbolKind || undefined,
    module: moduleName || undefined,
    abstract: abstract || tutorial?.abstract || "",
    declaration: declaration || undefined,
    declarationLanguage: declaration ? extractDeclarationLanguage(page.primaryContentSections) : undefined,
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
    overview: tutorial ? tutorial.overview : overview,
    ...extractRestSections(page),
    ...(sampleCodeDownloadUrl ? { sampleCodeDownloadUrl } : {}),
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
