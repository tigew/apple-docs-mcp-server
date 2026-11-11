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
  // tabNavigator
  tabs?: Array<{ title?: string; content?: AppleDocContentItem[] }>;
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

/**
 * A named, typed entry in a web-service reference section: a REST parameter,
 * an object property, a response code, or an enumeration value.
 */
export interface AppleDocRestField extends AppleDocParameter {
  type?: AppleDocFragment[];
  required?: boolean;
  deprecated?: boolean;
  /** Constraints such as `{ kind: "allowedValues", values: [...] }` or `{ kind: "maximum", value: "200" }`. */
  attributes?: Array<{ kind: string; value?: unknown; values?: unknown[] }>;
  // Response-code entries only
  status?: number;
  reason?: string;
  mimeType?: string;
}

export interface AppleDocPrimaryContentSection {
  kind: string;
  title?: string;
  content?: AppleDocContentItem[];
  declarations?: AppleDocDeclaration[];
  parameters?: AppleDocParameter[];
  // kind "restEndpoint": method, base URL, path, and path-parameter tokens
  tokens?: AppleDocFragment[];
  // kinds "restParameters" (with `source`: query | path | header), "restResponses", "properties"
  items?: AppleDocRestField[];
  source?: string;
  // kind "restBody"
  bodyContentType?: AppleDocFragment[];
  mimeType?: string;
  // kind "possibleValues"
  values?: AppleDocRestField[];
  // kind "details" (property-list keys and entitlements)
  details?: {
    name?: string;
    ideTitle?: string;
    value?: Array<{ baseType?: string; arrayMode?: boolean }>;
  };
  // kind "mentions": identifiers of the pages that mention this one
  mentions?: string[];
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
/** One operation of a JSON Patch (RFC 6902). */
export interface JsonPatchOperation {
  op: string;
  path: string;
  value?: unknown;
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
  /** Other-language renditions of this page, each a JSON Patch over this document. */
  variantOverrides?: Array<{ traits?: Array<{ interfaceLanguage?: string }>; patch?: JsonPatchOperation[] }>;
  sections?: AppleDocSection[];
  schemaVersion?: { major: number; minor: number; patch: number };
}

/** A parameter, property, or enumeration value on a web-service reference page. */
export interface ParsedField {
  name: string;
  type?: string;
  /** Documentation path of `type`, when it is a documented type. Usable with apple_docs_get_page. */
  typePath?: string;
  required?: boolean;
  description: string;
  allowedValues?: string[];
  /** Other constraints, e.g. "Maximum: 200". */
  constraints?: string[];
  deprecated?: boolean;
}

/** Reference sections found on web-service and configuration pages; each is set only when present. */
export interface ParsedRestSections {
  restEndpoints?: Array<{ title: string; method: string; url: string }>;
  /** One group per parameter source (path, query, header). */
  restParameters?: Array<{ title: string; source: string; items: ParsedField[] }>;
  restBody?: {
    title: string;
    mimeType?: string;
    type?: string;
    typePath?: string;
    description: string;
    parameters?: ParsedField[];
  };
  restResponses?: Array<{
    status: number;
    reason?: string;
    mimeType?: string;
    type?: string;
    typePath?: string;
    description: string;
  }>;
  properties?: { title: string; items: ParsedField[] };
  possibleValues?: { title: string; items: ParsedField[] };
  /** Property-list key or entitlement details. */
  details?: { name: string; ideTitle?: string; valueTypes: string[] };
  mentionedIn?: Array<{ title: string; path: string }>;
}

export interface ParsedSymbol extends ParsedRestSections {
  /**
   * Set when the requested path does not exist and this page was returned in
   * its place (see fetchDocPageResolved): the path that was asked for.
   */
  redirectedFrom?: string;
  title: string;
  kind: string;
  role: string;
  roleHeading?: string;
  symbolKind?: string;
  module?: string;
  abstract: string;
  declaration?: string;
  /** Language of `declaration`: "swift" or "objc". Absent for declarations in neither (e.g. web-service objects). */
  declarationLanguage?: string;
  /** Set when the Objective-C version was asked for and this page has none. */
  objcUnavailable?: boolean;
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
  /** The symbol's Objective-C name, when that name is what the query matched. */
  objcTitle?: string;
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
  /**
   * True when a lookup failed for a reason other than "no such thing" (a
   * timeout, a server error), so the answer may be missing matches.
   */
  incomplete?: boolean;
}

/**
 * A node in Apple's per-framework navigator index (the full symbol tree that
 * powers the docs-site sidebar), fetched from
 *   https://developer.apple.com/tutorials/data/index/{framework}
 * (formerly served with a `.json` suffix, which is kept as a fallback).
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
