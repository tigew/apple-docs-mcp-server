/**
 * Apple Developer Documentation API client and parsing utilities.
 *
 * Apple exposes a public (unofficial) JSON API at:
 *   https://developer.apple.com/tutorials/data/documentation/{path}.json
 *
 * This mirrors the URL path structure of developer.apple.com/documentation/{path}.
 * The implementation lives in ./docs/; this module is its public surface.
 */

export { extractDeclaration, extractOverview, extractParameters, extractText, parseDocPage, parseTechnologies } from "./docs/content.js";
export { formatDocPageMarkdown, formatGlobalSearchResultsMarkdown, formatSearchResultsMarkdown, formatTechnologiesMarkdown } from "./docs/format.js";
export { flattenFrameworkIndexNodes, loadFrameworkIndexNodes } from "./docs/framework-index.js";
export type { FlattenedIndexSymbol } from "./docs/framework-index.js";
export { assembleSearchStream, parseGlobalSearchResponse, searchGlobalSymbols } from "./docs/global-search.js";
export { fetchDocPage } from "./docs/page.js";
export { normalizePath } from "./docs/paths.js";
export { boundedEditDistance, resolveChildPathFromParentPage, resolveFromIndexSymbols } from "./docs/resolve.js";
export { dedupeSearchResults, searchFramework, searchReferencesInPage } from "./docs/search.js";
