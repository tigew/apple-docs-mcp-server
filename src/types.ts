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
}

export interface AppleDocPrimaryContentSection {
  kind: string;
  content?: AppleDocContentItem[];
  declarations?: AppleDocDeclaration[];
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

// REFACTOR SHOULD-FIX-4: Proper type for page sections (used in /technologies endpoint)
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
  identifier: AppleDocIdentifier;
  kind: string;
  abstract?: AppleDocInlineContent[];
  metadata: AppleDocMetadata;
  primaryContentSections?: AppleDocPrimaryContentSection[];
  topicSections?: AppleDocTopicSection[];
  seeAlsoSections?: AppleDocTopicSection[];
  relationshipsSections?: AppleDocRelationshipsSection[];
  references: Record<string, AppleDocReference>;
  hierarchy?: AppleDocHierarchy;
  variants?: Array<{ traits: Array<{ interfaceLanguage: string }>; paths: string[] }>;
  sections?: AppleDocSection[];
  schemaVersion?: { major: number; minor: number; patch: number };
}

export interface ParsedSymbol {
  title: string;
  kind: string;
  role: string;
  abstract: string;
  declaration?: string;
  platforms: AppleDocPlatform[];
  path: string;
  webUrl: string;
  topicSections: Array<{
    title: string;
    items: Array<{
      title: string;
      url: string;
      abstract: string;
      kind: string;
      role: string;
    }>;
  }>;
  relationships: Array<{
    title: string;
    type: string;
    items: Array<{ title: string; url: string }>;
  }>;
  seeAlsoSections: Array<{
    title: string;
    items: Array<{
      title: string;
      url: string;
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
