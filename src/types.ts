/**
 * TypeScript types for Apple Developer Documentation JSON API responses
 */

export interface AppleDocIdentifier {
  url: string;
  interfaceLanguage: string;
}

export interface AppleDocPlatform {
  name: string;
  introducedAt?: string;
  deprecatedAt?: string;
  beta?: boolean;
  unavailable?: boolean;
  deprecated?: boolean;
  message?: string;
  renamed?: string;
}

export interface AppleDocFragment {
  kind: string;
  text: string;
  identifier?: string;
  preciseIdentifier?: string;
}

export interface AppleDocInlineContent {
  type: string;
  text?: string;
  code?: string;
  identifier?: string;
  isActive?: boolean;
  inlineContent?: AppleDocInlineContent[];
  title?: string;
  destination?: string;
}

export interface AppleDocContentItem {
  type: string;
  level?: number;
  text?: string;
  anchor?: string;
  inlineContent?: AppleDocInlineContent[];
  code?: string[];
  syntax?: string;
  style?: string;
  content?: AppleDocContentItem[];
  items?: unknown[];
  // Table fields (avoids unsafe `as unknown as` casts)
  header?: string;
  rows?: AppleDocTableRow[];
}

/** A table cell is an array of content blocks (paragraphs, code, etc.). */
export type AppleDocTableCell = AppleDocContentItem[];

/**
 * DocC's render schema encodes a table row as an array of cells
 * (`rows: Cell[][]`, each cell an array of content blocks). An older/alternate
 * shape wrapped the cells in an object (`{ cells: [{ content: [...] }] }`).
 * Both are accepted so the converter is robust to either.
 */
export type AppleDocTableRow =
  | AppleDocTableCell[]
  | { cells?: Array<AppleDocTableCell | { content?: AppleDocTableCell }> };

export interface AppleDocParameter {
  name: string;
  content?: AppleDocContentItem[];
}

export interface AppleDocPrimaryContentSection {
  kind: string;
  content?: AppleDocContentItem[];
  declarations?: AppleDocDeclaration[];
  parameters?: AppleDocParameter[];
}

export interface AppleDocDeclaration {
  platforms: string[];
  languages: string[];
  tokens: AppleDocFragment[];
}

export interface AppleDocTopicSection {
  title: string;
  anchor: string;
  identifiers: string[];
}

export interface AppleDocReference {
  identifier: string;
  type: string;
  title?: string;
  url?: string;
  kind?: string;
  role?: string;
  abstract?: AppleDocInlineContent[];
  fragments?: AppleDocFragment[];
  navigatorTitle?: AppleDocFragment[];
  platforms?: AppleDocPlatform[];
  images?: AppleDocImage[];
  alt?: string;
  variants?: Array<{
    traits?: string[];
    url: string;
  }>;
}

export interface AppleDocImage {
  identifier: string;
  type: string;
  alt?: string;
  variants?: Array<{
    traits: string[];
    url: string;
  }>;
}

export interface AppleDocMetadata {
  title?: string;
  role?: string;
  roleHeading?: string;
  symbolKind?: string;
  modules?: Array<{ name: string }>;
  platforms?: AppleDocPlatform[];
  externalID?: string;
  fragments?: AppleDocFragment[];
  images?: AppleDocImage[];
}

export interface AppleDocRelationshipsSection {
  kind: string;
  type: string;
  title: string;
  identifiers: string[];
}

export interface AppleDocHierarchy {
  paths: string[][];
}

export interface AppleDocSection {
  kind?: string;
  title?: string;
  groups?: AppleDocGroup[];
  identifiers?: string[];
}

export interface AppleDocTechnologyEntry {
  title?: string;
  content?: AppleDocInlineContent[];
  languages?: string[];
  tags?: string[];
  destination?: {
    identifier?: string;
    type?: string;
    isActive?: boolean;
  };
}

export interface AppleDocGroup {
  name?: string;
  identifiers?: string[];
  technologies?: AppleDocTechnologyEntry[];
}
export interface AppleDocPage {
  identifier?: AppleDocIdentifier;
  kind?: string;
  abstract?: AppleDocInlineContent[];
  metadata?: AppleDocMetadata;
  primaryContentSections?: AppleDocPrimaryContentSection[];
  topicSections?: AppleDocTopicSection[];
  seeAlsoSections?: AppleDocTopicSection[];
  relationshipsSections?: AppleDocRelationshipsSection[];
  references?: Record<string, AppleDocReference>;
  hierarchy?: AppleDocHierarchy;
  variants?: Array<{ traits: Array<{ interfaceLanguage: string }>; paths: string[] }>;
  sections?: AppleDocSection[];
  schemaVersion?: { major: number; minor: number; patch: number };
}

export interface ParsedSymbol {
  title: string;
  kind: string;
  role: string;
  roleHeading?: string;
  symbolKind?: string;
  module?: string;
  abstract: string;
  declaration?: string;
  parameters?: Array<{ name: string; description: string }>;
  platforms: AppleDocPlatform[];
  deprecated?: boolean;
  deprecatedAt?: string;
  deprecationMessage?: string;
  breadcrumb?: string[];
  path: string;
  webUrl: string;
  topicSections: Array<{
    title: string;
    items: Array<{
      title: string;
      path: string;
      abstract: string;
      kind: string;
      role: string;
    }>;
  }>;
  relationships: Array<{
    title: string;
    type: string;
    items: Array<{ title: string; path: string }>;
  }>;
  seeAlsoSections: Array<{
    title: string;
    items: Array<{
      title: string;
      path: string;
      abstract: string;
      kind: string;
      role: string;
    }>;
  }>;
  overview: string;
}

export interface ParsedTechnologyItem {
  title: string;
  url: string;
  abstract: string;
  role: string;
}

export interface ParsedTechnologies {
  sections: Array<{
    title: string;
    technologies: ParsedTechnologyItem[];
  }>;
}

export interface SearchResult {
  title: string;
  path: string;
  webUrl: string;
  abstract: string;
  kind: string;
  role: string;
}

/** One hit from Apple's global (cross-framework) search API. */
export interface GlobalSearchResult {
  title: string;
  path: string;
  webUrl: string;
  framework: string;
  description: string;
  availability?: string;
}

/**
 * A symbol suggested as an alternative when a documentation path 404s
 * (typo correction, renamed type, overload disambiguation, or a hit in
 * another framework).
 */
export interface PathSuggestion {
  path: string;
  title: string;
  framework?: string;
}

/** Outcome of trying to resolve a 404'd path against the symbol indexes. */
export interface PathResolution {
  /** Set when exactly one high-confidence match exists — safe to fetch transparently. */
  autoResolvePath?: string;
  suggestions: PathSuggestion[];
  /** True when the suggestions came from other frameworks via global search. */
  crossFramework: boolean;
  /** Matches beyond the suggestion cap that were not included. */
  omittedCount?: number;
}

/**
 * A node in Apple's per-framework navigator index (the full symbol tree that
 * powers the docs-site sidebar), fetched from
 *   https://developer.apple.com/tutorials/data/index/{framework}.json
 */
export interface AppleDocIndexNode {
  title?: string;
  path?: string;
  type?: string;
  deprecated?: boolean;
  beta?: boolean;
  external?: boolean;
  children?: AppleDocIndexNode[];
}

export interface AppleDocIndexResponse {
  interfaceLanguages?: Record<string, AppleDocIndexNode[]>;
}
