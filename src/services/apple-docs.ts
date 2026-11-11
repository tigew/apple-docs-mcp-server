/**
 * Apple Developer Documentation API client and parsing utilities.
 *
 * Apple exposes a public (unofficial) JSON API at:
 *   https://developer.apple.com/tutorials/data/documentation/{path}.json
 *
 * This mirrors the URL path structure of developer.apple.com/documentation/{path}.
 * The implementation lives in ./docs/; this module is its public surface.
 */

export { extractDeclaration, extractOverview, extractParameters, extractText } from "./docs/content.js";
export { formatDocPageMarkdown, formatGlobalSearchResultsMarkdown, formatSearchResultsMarkdown, formatTechnologiesMarkdown } from "./docs/format.js";
export { flattenFrameworkIndexNodes, loadFrameworkIndexNodes, mergeFrameworkIndexSymbols } from "./docs/framework-index.js";
export type { FlattenedIndexSymbol, FrameworkIndexTrees } from "./docs/framework-index.js";
export { assembleSearchStream, parseGlobalSearchResponse, searchGlobalSymbols } from "./docs/global-search.js";
export { fetchDocPage, fetchDocPageResolved } from "./docs/page.js";
export { parseDocPage, parseTechnologies } from "./docs/parse.js";
export { normalizePath } from "./docs/paths.js";
export { boundedEditDistance, resolveChildPathFromParentPage, resolveFromIndexSymbols } from "./docs/resolve.js";
export {
  dedupeSearchResults,
  fillMissingAbstracts,
  searchFramework,
  searchIndexSymbols,
  searchReferencesInPage,
} from "./docs/search.js";
export { applyJsonPatch, selectLanguageVariant } from "./docs/variants.js";
export type { DocLanguage } from "./docs/variants.js";
