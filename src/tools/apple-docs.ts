/**
 * MCP tools for developer.apple.com/documentation (framework docs, HIG, technotes).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHARACTER_LIMIT } from "../constants.js";
import {
  fetchDocPage,
  fetchDocPageResolved,
  formatDocPageMarkdown,
  formatGlobalSearchResultsMarkdown,
  formatSearchResultsMarkdown,
  formatTechnologiesMarkdown,
  normalizePath,
  parseDocPage,
  parseTechnologies,
  searchFramework,
  searchGlobalSymbols,
  selectLanguageVariant,
} from "../services/apple-docs.js";
import { offsetParam, registerReadTool, render, ResponseFormat, responseFormatParam } from "./shared.js";
import { clampJsonResponse, clampTextResponse } from "./truncation.js";

export function registerAppleDocsTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // Tool: apple_docs_list_technologies
  // ---------------------------------------------------------------------------

  registerReadTool(
    server,
    "apple_docs_list_technologies",
    {
      title: "List Apple Technologies",
      description: `List all Apple developer frameworks and technologies available in Apple's documentation.

Returns a structured list of all Apple frameworks grouped by category (e.g. App Frameworks, Graphics & Games, System, etc.), with their documentation path and a brief description.

Use this tool when:
- You want to discover available Apple frameworks
- You need the correct path for a framework to pass to apple_docs_get_page
- The user asks "what frameworks does Apple have?"

Returns:
  For markdown format: A categorized list of technologies with paths and descriptions.
  For JSON format:
  {
    "sections": [
      {
        "title": string,            // Category name (e.g. "App Frameworks")
        "technologies": [
          {
            "title": string,        // Framework display name (e.g. "SwiftUI")
            "url": string,          // Relative URL (e.g. "/documentation/swiftui")
            "abstract": string,     // Brief description
            "role": string          // Usually "collection"
          }
        ]
      }
    ]
  }

Examples:
  - "What Apple frameworks are available?" -> call with no arguments
  - "What's the path for the SwiftUI framework?" -> call, look for SwiftUI entry, path is "swiftui"`,
      inputSchema: {
        response_format: responseFormatParam,
      },
    },
    async ({ response_format }) => {
      const parsed = parseTechnologies(await fetchDocPage("technologies"));

      if (response_format === ResponseFormat.JSON) {
        // The full list (~400 frameworks with abstracts) exceeds the response
        // limit — drop abstracts rather than truncating away half the
        // frameworks, so every framework stays discoverable.
        const full = JSON.stringify(parsed, null, 2);
        if (full.length <= CHARACTER_LIMIT) return full;
        const compact = {
          note: "Abstracts omitted so the complete framework list fits in one response. Use apple_docs_get_page with a framework's path for its description.",
          sections: parsed.sections.map((section) => ({
            title: section.title,
            technologies: section.technologies.map(({ title, url, role }) => ({ title, url, role })),
          })),
        };
        return clampJsonResponse(
          compact,
          "Response truncated. Use apple_docs_get_page with a specific framework path to get details."
        );
      }

      let text = formatTechnologiesMarkdown(parsed);
      if (text.length > CHARACTER_LIMIT) {
        text = formatTechnologiesMarkdown(parsed, { compact: true });
      }
      return clampTextResponse(
        text,
        "\n\n*(Response truncated — use apple_docs_get_page with a specific framework path to get details.)*"
      );
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: apple_docs_get_page
  // ---------------------------------------------------------------------------

  registerReadTool(
    server,
    "apple_docs_get_page",
    {
      title: "Get Apple Documentation Page",
      description: `Fetch and render a specific Apple Developer documentation page by its path.

The path corresponds to the URL path at developer.apple.com/documentation/{path}. For example:
  - Framework overview: "swiftui", "swift", "uikit", "foundation", "combine"
  - Symbol/type:        "swiftui/view", "swift/array", "uikit/uitableview"
  - Article:           "swiftui/declaring-a-custom-view"
  - Nested symbol:     "swiftui/view/body-swift.property"
  - Tutorial:          "tutorials/swiftui" (a collection), "tutorials/swiftui/creating-and-combining-views" (its steps and code)

Returns rich documentation including: abstract, Swift declaration, parameters, full documentation prose, topic sections (with child symbol paths you can pass directly to this tool), platform availability, deprecation status, hierarchy breadcrumb, and relationship info (inheritance, conformances).

Args:
  - path (string): The documentation path (everything after /documentation/ in the Apple docs URL). Case-insensitive.
  - language ('swift' | 'objc'): Which version of the page to return (default: 'swift'). 'objc' gives the Objective-C names and declarations.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  For markdown: Formatted documentation including declaration, parameters, overview, topics, and relationships.
  For JSON: Full parsed symbol object:
  {
    "title": string,
    "kind": string,             // e.g. "symbol", "article"
    "role": string,             // e.g. "symbol", "collection", "article"
    "roleHeading": string,      // e.g. "Instance Method", "Structure"
    "module": string,           // e.g. "Swift", "SwiftUI"
    "abstract": string,
    "declaration": string,      // Swift declaration (if applicable)
    "parameters": [             // Function/method parameters (if applicable)
      { "name": string, "description": string }
    ],
    "platforms": [...],
    "deprecated": boolean,      // true if deprecated on all platforms
    "deprecatedAt": string,     // Platform-specific deprecation versions
    "breadcrumb": string[],     // Hierarchy path (e.g. ["Swift", "Array"])
    "path": string,             // Usable as input to this tool
    "webUrl": string,
    "topicSections": [...],     // Child symbols with paths usable as input to this tool
    "relationships": [...],
    "seeAlsoSections": [...],
    "overview": string
  }

Examples:
  - Get SwiftUI framework overview:  path="swiftui"
  - Get View protocol docs:          path="swiftui/view"
  - Get Array docs:                  path="swift/array"
  - Get UIViewController docs:       path="uikit/uiviewcontroller"
  - Get Foundation overview:         path="foundation"
  - Get URLSession docs:             path="foundation/urlsession"

Error Handling:
  - Unambiguous near-misses resolve automatically: a bare member name with a single overload, a renamed type (e.g. "cloudkit/cksharemetadata" → "cloudkit/ckshare/metadata"), or an exact symbol name that lives elsewhere (even in another framework, e.g. "widgetkit/relevantcontext" → "relevancekit/relevantcontext")
  - Ambiguous misses return a 404 with "did you mean" suggestions — including every overload of a member name with its declaration (e.g. path=".../intentresultcontainer/result" lists all result(...) overloads with their disambiguation suffixes)
  - Use apple_docs_list_technologies to discover framework names, or apple_docs_find_symbol to locate a symbol across all frameworks`,
      inputSchema: {
        path: z
          .string()
          .min(1, "Path must not be empty")
          .max(500, "Path is too long")
          .describe(
            "The documentation path (everything after /documentation/ in the Apple docs URL). E.g.: 'swiftui', 'swiftui/view', 'swift/array', 'foundation/urlsession'"
          ),
        language: z
          .enum(["swift", "objc"])
          .default("swift")
          .describe("Which version of the page to return: 'swift' (default) or 'objc' for Objective-C names and declarations"),
        response_format: responseFormatParam,
        offset: offsetParam,
      },
    },
    async ({ path, language, response_format, offset }) => {
      const { page, redirectedFrom } = await fetchDocPageResolved(path);
      // Only an explicit request for Objective-C changes the page; pages that
      // exist in a single language are otherwise returned as published.
      const variant = language === "objc" ? selectLanguageVariant(page, "objc") : { page, available: true };
      const parsed = parseDocPage(variant.page, path);
      return render(
        response_format,
        {
          ...(redirectedFrom ? { redirectedFrom } : {}),
          ...(variant.available ? {} : { objcUnavailable: true }),
          ...parsed,
        },
        formatDocPageMarkdown,
        offset
      );
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: apple_docs_search
  // ---------------------------------------------------------------------------

  registerReadTool(
    server,
    "apple_docs_search",
    {
      title: "Search Apple Documentation",
      description: `Search for symbols, articles, and topics within an Apple framework's documentation.

Matches against the framework's complete symbol tree — every type, enum case, extension member, and nested member, by Swift or Objective-C name, not just what's listed on the framework's own root page — plus its curated root-page references and descriptions. Multi-word queries match if any query word appears in a symbol's name or path, ranked by how many words matched (so "deferred start capture session" finds AVCaptureSession's deferred-start members even though "capture session" only appears in the path). Because the search covers both language trees, an empty result is good evidence the symbol doesn't exist under that name — not just that it wasn't indexed. This is useful for discovering APIs when you know the framework but not the exact symbol name.

Args:
  - framework_path (string): The framework to search in (e.g. "swiftui", "foundation", "uikit")
  - query (string): Search query — matched against symbol titles and descriptions
  - limit (number): Maximum number of results to return, 1–50 (default: 20)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  For markdown: Formatted list of matching symbols with paths and descriptions.
  For JSON:
  {
    "query": string,
    "framework": string,
    "count": number,
    "results": [
      {
        "title": string,
        "path": string,     // Use as input to apple_docs_get_page
        "webUrl": string,
        "abstract": string,
        "kind": string,
        "role": string
      }
    ]
  }

Examples:
  - Find animation-related APIs in SwiftUI:  framework_path="swiftui", query="animation"
  - Search for table views in UIKit:         framework_path="uikit", query="table"
  - Find async/await types in Swift:         framework_path="swift", query="async"
  - Look for URL types in Foundation:        framework_path="foundation", query="url"

Note: For very specific symbol lookups where you know the exact name, use
apple_docs_get_page directly (e.g. path="swiftui/animation"). If you don't know
which framework a symbol belongs to, use apple_docs_find_symbol instead — this
tool only searches within the one framework you name.`,
      inputSchema: {
        framework_path: z
          .string()
          .min(1)
          .max(200)
          .describe("The framework to search within (e.g. 'swiftui', 'foundation', 'uikit', 'swift')"),
        query: z
          .string()
          .min(1, "Search query must not be empty")
          .max(200, "Search query too long")
          .describe("Text to search for in symbol titles, paths, and descriptions. Multi-word queries match any word (ranked by how many matched), not the literal phrase."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe("Maximum number of results to return (default: 20)"),
        response_format: responseFormatParam,
      },
    },
    async ({ framework_path, query, limit, response_format }) => {
      const normalizedFrameworkPath = normalizePath(framework_path);
      const results = await searchFramework(normalizedFrameworkPath, query, limit);

      if (response_format !== ResponseFormat.JSON) {
        return clampTextResponse(
          formatSearchResultsMarkdown(results, query, normalizedFrameworkPath),
          "\n\n*(Response truncated — reduce limit or refine your query.)*"
        );
      }

      // A "warning" entry is how searchFramework reports a failed index fetch.
      const realResults = results.filter((r) => r.kind !== "warning");
      const searchWarning = results.find((r) => r.kind === "warning");
      return clampJsonResponse(
        {
          query,
          framework: normalizedFrameworkPath,
          count: realResults.length,
          ...(searchWarning
            ? { note: searchWarning.abstract }
            : realResults.length === 0
              ? {
                  note: "This search covers the framework's complete symbol tree, not just its root documentation page — an empty result is good evidence the symbol doesn't exist under this name in this framework.",
                }
              : {}),
          results: realResults,
        },
        "Response truncated. Reduce limit or refine your query."
      );
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: apple_docs_find_symbol
  // ---------------------------------------------------------------------------

  registerReadTool(
    server,
    "apple_docs_find_symbol",
    {
      title: "Find Symbol Across All Apple Frameworks",
      description: `Search Apple's documentation across ALL frameworks at once — use this when you know a symbol or concept name but not which framework it belongs to.

This is the tool for cross-framework symbol resolution. Types often appear in one framework's signatures but are defined in another (e.g. RelevantContext appears in WidgetKit APIs but lives in RelevanceKit) — this tool finds where a symbol is actually documented. Works best with symbol or concept names ("RelevantContext", "CKShareMetadata", "widget relevance"), not full-text phrases.

Args:
  - query (string): Symbol or concept name to find (e.g. "RelevantContext", "URLSession")
  - limit (number): Maximum number of results, 1–25 (default: 10)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  For markdown: Each result with its framework, documentation path, availability, and description.
  For JSON:
  {
    "query": string,
    "count": number,
    "results": [
      {
        "title": string,        // e.g. "RelevantContext"
        "path": string,         // Use as input to apple_docs_get_page
        "webUrl": string,
        "framework": string,    // e.g. "RelevanceKit"
        "description": string,
        "availability": string  // e.g. "iOS 17.0+ | watchOS 10.0+"
      }
    ]
  }

Examples:
  - Which framework defines RelevantContext?  query="RelevantContext"
  - Find a type you saw in a signature:       query="WidgetRelevance"
  - Locate a renamed/legacy type:             query="CKShareMetadata"

Note: To browse or exhaustively search one framework's complete symbol tree, use apple_docs_search with a framework_path instead.`,
      inputSchema: {
        query: z
          .string()
          .min(1, "Search query must not be empty")
          .max(200, "Search query too long")
          .describe("Symbol or concept name to find across all Apple frameworks (e.g. 'RelevantContext')"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .default(10)
          .describe("Maximum number of results to return (default: 10)"),
        response_format: responseFormatParam,
      },
    },
    async ({ query, limit, response_format }) => {
      const results = await searchGlobalSymbols(query, limit);

      if (response_format !== ResponseFormat.JSON) {
        return clampTextResponse(
          formatGlobalSearchResultsMarkdown(results, query),
          "\n\n*(Response truncated — reduce limit or refine your query.)*"
        );
      }
      return clampJsonResponse(
        {
          query,
          count: results.length,
          ...(results.length === 0
            ? { note: "No results. This global search works best with symbol or concept names. Try a different name, or search within a specific framework with apple_docs_search." }
            : {}),
          results,
        },
        "Response truncated. Reduce limit or refine your query."
      );
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: apple_docs_get_symbol_raw
  // ---------------------------------------------------------------------------

  registerReadTool(
    server,
    "apple_docs_get_symbol_raw",
    {
      title: "Get Raw Apple Documentation JSON",
      description: `Fetch the raw JSON response from Apple's documentation API for a given path.

Returns the full, unprocessed JSON object from Apple's documentation CDN. Useful for:
- Debugging or inspecting the raw data structure
- Accessing fields not exposed by apple_docs_get_page (e.g. full references map)
- Building custom processing on top of the raw data

Args:
  - path (string): The documentation path (e.g. "swiftui/view", "foundation/urlsession")

Returns:
  The raw Apple documentation JSON object as a string.

Note: This can be very large. Prefer apple_docs_get_page for most use cases.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(500)
          .describe("The documentation path (e.g. 'swiftui/view', 'swift/array')"),
      },
    },
    async ({ path }) => {
      const page = await fetchDocPage(path);
      const full = JSON.stringify(page, null, 2);
      if (full.length <= CHARACTER_LIMIT) return full;

      // Return a trimmed version with just the most useful parts.
      const refCount = Object.keys(page.references ?? {}).length;
      const trimmed = {
        identifier: page.identifier,
        kind: page.kind,
        metadata: page.metadata,
        abstract: page.abstract,
        hierarchy: page.hierarchy,
        topicSections: page.topicSections,
        primaryContentSections: page.primaryContentSections,
      };
      // Prefer a COMPACT (non-pretty) serialization that only drops the large
      // references map. This keeps content arrays whole — e.g. every row of a
      // DocC table — which the generic summarizer would otherwise cap at 5
      // items mid-section (the original TN3191 "_truncatedItems where the table
      // rows should be" symptom). Only fall back to summarization if even the
      // compact form is too large.
      const compact = JSON.stringify({
        ...trimmed,
        _note: `References map omitted (${refCount} entries); compact JSON. Use apple_docs_get_page for formatted output.`,
      });
      return compact.length <= CHARACTER_LIMIT
        ? compact
        : clampJsonResponse(
            {
              ...trimmed,
              _note: `Response truncated. Full references map omitted (${refCount} entries). Use apple_docs_get_page for formatted output.`,
            },
            "Response truncated. Use apple_docs_get_page for formatted output."
          );
    }
  );
}
