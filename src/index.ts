#!/usr/bin/env node
/**
 * Apple Developer Documentation MCP Server
 *
 * Provides tools to access Apple's developer documentation via their
 * public (unofficial) JSON API at:
 *   https://developer.apple.com/tutorials/data/documentation/{path}.json
 *
 * No authentication required. All documentation is publicly accessible.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  fetchDocPage,
  normalizePath,
  parseDocPage,
  parseTechnologies,
  searchFramework,
  searchGlobalSymbols,
  formatDocPageMarkdown,
  formatTechnologiesMarkdown,
  formatSearchResultsMarkdown,
  formatGlobalSearchResultsMarkdown,
} from "./services/apple-docs.js";
import {
  fetchSwiftBookPage,
  fetchSwiftReleaseNotes,
  formatSwiftReleaseNotesMarkdown,
} from "./services/swift-docs.js";
import { fetchWwdcSession, formatWwdcSessionMarkdown } from "./services/wwdc.js";
import {
  fetchGuidelineSection,
  fetchGuidelinesIndex,
  formatGuidelineSectionMarkdown,
  formatGuidelinesIndexMarkdown,
} from "./services/appstore-guidelines.js";
import {
  fetchHelpArticle,
  fetchHelpIndex,
  formatHelpArticleMarkdown,
  formatHelpIndexMarkdown,
} from "./services/appstore-connect-help.js";
import { fetchForumThreads, formatForumThreadsMarkdown } from "./services/forums.js";
import { fetchSupportArticle, formatSupportArticleMarkdown } from "./services/support-kb.js";
import {
  fetchMlResearchList,
  fetchMlResearchPost,
  formatMlResearchListMarkdown,
  formatMlResearchPostMarkdown,
} from "./services/ml-research.js";
import {
  fetchMarketingPage,
  fetchNewsList,
  fetchNewsPost,
  formatMarketingPageMarkdown,
  formatNewsListMarkdown,
  formatNewsPostMarkdown,
} from "./services/developer-news.js";
import { fetchTechnicalQa, formatTechnicalQaMarkdown } from "./services/technical-qa.js";
import { CHARACTER_LIMIT } from "./constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_SUMMARIZE_DEPTH = 10;

/**
 * Safe truncation that avoids cutting mid-surrogate-pair.
 */
function safeTruncate(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  let truncated = text.slice(0, limit);
  // If last char is a high surrogate (0xD800-0xDBFF), remove it to avoid orphan
  const lastCode = truncated.charCodeAt(truncated.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  // If last char is a low surrogate (0xDC00-0xDFFF) without a preceding high, remove it
  if (truncated.length > 0) {
    const finalCode = truncated.charCodeAt(truncated.length - 1);
    if (finalCode >= 0xdc00 && finalCode <= 0xdfff) {
      // Check if preceded by a high surrogate
      if (truncated.length < 2 || truncated.charCodeAt(truncated.length - 2) < 0xd800 || truncated.charCodeAt(truncated.length - 2) > 0xdbff) {
        truncated = truncated.slice(0, -1);
      }
    }
  }
  // Avoid cutting mid-JSON-escape-sequence (e.g., \uXXXX, \n, \t, \\)
  // If truncation ends with a trailing backslash that starts an incomplete escape, trim it
  if (truncated.length > 0) {
    // Count trailing backslashes — an odd number means the last one is an escape prefix
    let trailingBackslashes = 0;
    for (let i = truncated.length - 1; i >= 0 && truncated[i] === "\\"; i--) {
      trailingBackslashes++;
    }
    if (trailingBackslashes % 2 === 1) {
      truncated = truncated.slice(0, -1);
    }
    // Check for incomplete \uXXXX sequence (backslash + u + fewer than 4 hex chars at end)
    const uEscapeMatch = truncated.match(/\\u[0-9a-fA-F]{0,3}$/);
    if (uEscapeMatch) {
      truncated = truncated.slice(0, -uEscapeMatch[0].length);
    }
  }
  return truncated;
}

function clampTextResponse(text: string, suffix: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  const budget = Math.max(0, CHARACTER_LIMIT - suffix.length);
  return `${safeTruncate(text, budget)}${suffix}`;
}

function summarizeJsonValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_SUMMARIZE_DEPTH) return "[nested]";
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    const limit = depth === 0 ? 8 : 5;
    const items = value.slice(0, limit).map((item) => summarizeJsonValue(item, depth + 1));
    if (value.length > limit) {
      items.push({ _truncatedItems: value.length - limit });
    }
    return items;
  }

  const entries = Object.entries(value);
  const limit = depth === 0 ? 16 : 10;
  const summarizedEntries = entries.slice(0, limit).map(([key, entryValue]) => [
    key,
    summarizeJsonValue(entryValue, depth + 1),
  ]);

  if (entries.length > limit) {
    summarizedEntries.push(["_truncatedKeys", entries.length - limit]);
  }

  return Object.fromEntries(summarizedEntries);
}

function clampJsonResponse(value: unknown, note: string): string {
  const full = JSON.stringify(value, null, 2);
  if (full.length <= CHARACTER_LIMIT) return full;

  const summarized = {
    truncated: true,
    note,
    data: summarizeJsonValue(value),
  };
  const summarizedText = JSON.stringify(summarized, null, 2);
  if (summarizedText.length <= CHARACTER_LIMIT) return summarizedText;

  const minimal = JSON.stringify({ truncated: true, note }, null, 2);
  if (minimal.length >= CHARACTER_LIMIT) {
    return safeTruncate(minimal, CHARACTER_LIMIT);
  }

  // Use a conservative budget and verify the final output fits
  const previewBudget = Math.max(0, CHARACTER_LIMIT - minimal.length - 100);
  const result = JSON.stringify(
    {
      truncated: true,
      note,
      preview: safeTruncate(full, previewBudget),
    },
    null,
    2
  );

  // Final safety check: if JSON escaping caused the result to exceed the limit, re-truncate
  if (result.length > CHARACTER_LIMIT) {
    return safeTruncate(result, CHARACTER_LIMIT);
  }

  return result;
}

/**
 * Serialize a list-style JSON response, keeping as many array entries as fit in
 * CHARACTER_LIMIT instead of the generic summarizer's fixed 5-item cap (which
 * would drop hundreds of small records — e.g. the 261-article help index — down
 * to 5). Mirrors the markdown path, which already shows as many entries as fit.
 */
function clampJsonList(base: Record<string, unknown>, key: string, items: unknown[], note: string): string {
  const full = JSON.stringify({ ...base, [key]: items }, null, 2);
  if (full.length <= CHARACTER_LIMIT) return full;

  // Largest prefix of `items` that still fits, with a truncation note.
  let lo = 0;
  let hi = items.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = JSON.stringify(
      { ...base, truncated: true, note: `${note} Showing ${mid} of ${items.length}.`, [key]: items.slice(0, mid) },
      null,
      2
    );
    if (candidate.length <= CHARACTER_LIMIT) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return JSON.stringify(
    { ...base, truncated: true, note: `${note} Showing ${best} of ${items.length}.`, [key]: items.slice(0, best) },
    null,
    2
  );
}
// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "apple-docs-mcp-server",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool: apple_docs_list_technologies
// ---------------------------------------------------------------------------

server.registerTool(
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
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ response_format }) => {
    try {
      const page = await fetchDocPage("technologies");
      const parsed = parseTechnologies(page);

      let text: string;
      if (response_format === ResponseFormat.JSON) {
        // The full list (~400 frameworks with abstracts) exceeds the response
        // limit — drop abstracts rather than truncating away half the
        // frameworks, so every framework stays discoverable.
        text = JSON.stringify(parsed, null, 2);
        if (text.length > CHARACTER_LIMIT) {
          const compact = {
            note: "Abstracts omitted so the complete framework list fits in one response. Use apple_docs_get_page with a framework's path for its description.",
            sections: parsed.sections.map((section) => ({
              title: section.title,
              technologies: section.technologies.map(({ title, url, role }) => ({ title, url, role })),
            })),
          };
          text = clampJsonResponse(
            compact,
            "Response truncated. Use apple_docs_get_page with a specific framework path to get details."
          );
        }
      } else {
        text = formatTechnologiesMarkdown(parsed);
        if (text.length > CHARACTER_LIMIT) {
          text = formatTechnologiesMarkdown(parsed, { compact: true });
        }
        text = clampTextResponse(
          text,
          "\n\n*(Response truncated — use apple_docs_get_page with a specific framework path to get details.)*"
        );
      }

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: apple_docs_get_page
// ---------------------------------------------------------------------------

server.registerTool(
  "apple_docs_get_page",
  {
    title: "Get Apple Documentation Page",
    description: `Fetch and render a specific Apple Developer documentation page by its path.

The path corresponds to the URL path at developer.apple.com/documentation/{path}. For example:
  - Framework overview: "swiftui", "swift", "uikit", "foundation", "combine"
  - Symbol/type:        "swiftui/view", "swift/array", "uikit/uitableview"
  - Article:           "swiftui/declaring-a-custom-view"
  - Nested symbol:     "swiftui/view/body-swift.property"

Returns rich documentation including: abstract, Swift declaration, parameters, full documentation prose, topic sections (with child symbol paths you can pass directly to this tool), platform availability, deprecation status, hierarchy breadcrumb, and relationship info (inheritance, conformances).

Args:
  - path (string): The documentation path (everything after /documentation/ in the Apple docs URL). Case-insensitive.
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
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ path, response_format }) => {
    try {
      const page = await fetchDocPage(path);
      const parsed = parseDocPage(page, path);

      let text: string;
      if (response_format === ResponseFormat.JSON) {
        text = clampJsonResponse(
          parsed,
          "Response truncated. Use a more specific path to get details on a particular symbol."
        );
      } else {
        text = clampTextResponse(
          formatDocPageMarkdown(parsed),
          "\n\n*(Response truncated. Use a more specific path to get details on a particular symbol.)*"
        );
      }

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: apple_docs_search
// ---------------------------------------------------------------------------

server.registerTool(
  "apple_docs_search",
  {
    title: "Search Apple Documentation",
    description: `Search for symbols, articles, and topics within an Apple framework's documentation.

Matches against the framework's complete symbol tree — every type, enum case, extension member, and nested member, not just what's listed on the framework's own root page — plus its curated root-page references and descriptions. Multi-word queries match if any query word appears in a symbol's name or path, ranked by how many words matched (so "deferred start capture session" finds AVCaptureSession's deferred-start members even though "capture session" only appears in the path). Because the search is complete, an empty result is good evidence the symbol doesn't exist under that name — not just that it wasn't indexed. This is useful for discovering APIs when you know the framework but not the exact symbol name.

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
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ framework_path, query, limit, response_format }) => {
    try {
      const normalizedFrameworkPath = normalizePath(framework_path);
      const results = await searchFramework(normalizedFrameworkPath, query, limit);

      const realResultCount = results.filter((r) => r.kind !== "warning").length;
      const searchWarning = results.find((r) => r.kind === "warning");

      let text: string;
      if (response_format === ResponseFormat.JSON) {
        text = clampJsonResponse(
          {
            query,
            framework: normalizedFrameworkPath,
            count: realResultCount,
            ...(searchWarning
              ? { note: searchWarning.abstract }
              : realResultCount === 0
                ? {
                    note: "This search covers the framework's complete symbol tree, not just its root documentation page — an empty result is good evidence the symbol doesn't exist under this name in this framework.",
                  }
                : {}),
            results: results.filter((r) => r.kind !== "warning"),
          },
          "Response truncated. Reduce limit or refine your query."
        );
      } else {
        text = clampTextResponse(
          formatSearchResultsMarkdown(results, query, normalizedFrameworkPath),
          "\n\n*(Response truncated — reduce limit or refine your query.)*"
        );
      }

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: apple_docs_find_symbol
// ---------------------------------------------------------------------------

server.registerTool(
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
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ query, limit, response_format }) => {
    try {
      const results = await searchGlobalSymbols(query, limit);

      let text: string;
      if (response_format === ResponseFormat.JSON) {
        text = clampJsonResponse(
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
      } else {
        text = clampTextResponse(
          formatGlobalSearchResultsMarkdown(results, query),
          "\n\n*(Response truncated — reduce limit or refine your query.)*"
        );
      }

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: apple_docs_get_symbol_raw
// ---------------------------------------------------------------------------

server.registerTool(
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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ path }) => {
    try {
      const page = await fetchDocPage(path);
      let text = JSON.stringify(page, null, 2);

      if (text.length > CHARACTER_LIMIT) {
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
        text =
          compact.length <= CHARACTER_LIMIT
            ? compact
            : clampJsonResponse(
                {
                  ...trimmed,
                  _note: `Response truncated. Full references map omitted (${refCount} entries). Use apple_docs_get_page for formatted output.`,
                },
                "Response truncated. Use apple_docs_get_page for formatted output."
              );
      }

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: apple_swift_book_get_page — "The Swift Programming Language" (swift.org)
// ---------------------------------------------------------------------------

server.registerTool(
  "apple_swift_book_get_page",
  {
    title: "Get a Page from The Swift Programming Language",
    description: `Fetch a chapter or section from "The Swift Programming Language" (TSPL) book, published at docs.swift.org.

This is the authoritative reference for Swift-the-language concepts (syntax, types, generics, concurrency, macros, memory model), which the framework docs at developer.apple.com explicitly defer to but do not contain. Use this when a question is about the language itself rather than a specific framework's API.

Args:
  - path (string): A book path. Accepts the book root ("the-swift-programming-language"), a qualified path ("the-swift-programming-language/thebasics"), or a bare chapter slug ("thebasics", "concurrency", "macros", "generics", "accesscontrol"). Case-insensitive.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns the chapter's prose, code listings, and links to sub-topics (paths usable as input to this tool). Start with path="the-swift-programming-language" to see the table of contents.`,
    inputSchema: {
      path: z
        .string()
        .min(1, "Path must not be empty")
        .max(300, "Path is too long")
        .describe("Book path or chapter slug, e.g. 'the-swift-programming-language', 'thebasics', 'concurrency'"),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ path, response_format }) => {
    try {
      const parsed = await fetchSwiftBookPage(path);
      const text =
        response_format === ResponseFormat.JSON
          ? clampJsonResponse(parsed, "Response truncated. Use a more specific chapter path.")
          : clampTextResponse(
              formatDocPageMarkdown(parsed),
              "\n\n*(Response truncated. Use a more specific chapter path.)*"
            );
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: apple_swift_get_release_notes — Swift release notes / "What's new"
// ---------------------------------------------------------------------------

server.registerTool(
  "apple_swift_get_release_notes",
  {
    title: "Get Swift Release Notes and Updates",
    description: `List recent Swift release notes and "What's new in Swift" updates from swift.org and the swiftlang/swift release feed.

Use this for modern Swift-the-language release information (new language features, toolchain snapshots), which is published at swift.org — a different origin from developer.apple.com, so it does not appear in the framework docs or Xcode release notes.

Args:
  - limit (number): Maximum entries to return, 1–25 (default: 10)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns entries with title, date, source, link, and a short summary, newest first.`,
    inputSchema: {
      limit: z.number().int().min(1).max(25).default(10).describe("Maximum number of entries (default: 10)"),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ limit, response_format }) => {
    try {
      const entries = await fetchSwiftReleaseNotes(limit);
      const text =
        response_format === ResponseFormat.JSON
          ? clampJsonList({ count: entries.length }, "entries", entries, "Response truncated.")
          : clampTextResponse(
              formatSwiftReleaseNotesMarkdown(entries),
              "\n\n*(Response truncated — reduce limit.)*"
            );
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: apple_wwdc_get_session — WWDC session transcript + metadata
// ---------------------------------------------------------------------------

server.registerTool(
  "apple_wwdc_get_session",
  {
    title: "Get a WWDC Session Transcript",
    description: `Fetch the transcript, chapters, and code samples for a WWDC session video.

WWDC sessions are a primary source for how-and-why guidance on Apple APIs that often isn't in the reference docs. This returns the full spoken transcript plus session metadata, chapter markers, in-session code samples, and links to related sessions.

Args:
  - year (string): The 4-digit conference year, e.g. "2024".
  - session (string): The session id, e.g. "10176" (the NNN in developer.apple.com/videos/play/wwdcYYYY/NNN/).
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Find session ids by browsing developer.apple.com/videos/play/wwdc{year}/. A non-existent session returns a "not found" error.`,
    inputSchema: {
      year: z.string().min(4).max(4).describe("4-digit conference year, e.g. '2024'"),
      session: z.string().min(1).max(10).describe("Session id, e.g. '10176'"),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ year, session, response_format }) => {
    try {
      const parsed = await fetchWwdcSession(year, session);
      const text =
        response_format === ResponseFormat.JSON
          ? clampJsonResponse(parsed, "Response truncated. The transcript may be long.")
          : clampTextResponse(
              formatWwdcSessionMarkdown(parsed),
              "\n\n*(Response truncated — the transcript is long; fetch JSON for structured access.)*"
            );
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: apple_app_store_review_guidelines — App Store Review Guidelines
// ---------------------------------------------------------------------------

server.registerTool(
  "apple_app_store_review_guidelines",
  {
    title: "Get App Store Review Guidelines",
    description: `Read the App Store Review Guidelines — the rules apps must follow to pass App Review.

Call without a section to get the table of contents (all numbered sections with titles). Pass a section number to read that guideline's full text, including nested sub-points.

Args:
  - section (string, optional): A guideline number like "2", "2.3", or "2.3.1". Omit for the section index.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Examples:
  - List all sections:                 (no section)
  - Read the metadata accuracy rule:   section="2.3.1"
  - Read the whole Safety section:     section="1"`,
    inputSchema: {
      section: z
        .string()
        .max(20)
        .optional()
        .describe('Guideline number like "2.3.1". Omit to list all sections.'),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ section, response_format }) => {
    try {
      if (section && section.trim()) {
        const result = await fetchGuidelineSection(section.trim());
        const text =
          response_format === ResponseFormat.JSON
            ? clampJsonResponse(result, "Response truncated.")
            : clampTextResponse(formatGuidelineSectionMarkdown(result), "\n\n*(Response truncated.)*");
        return { content: [{ type: "text", text }] };
      }
      const index = await fetchGuidelinesIndex();
      const text =
        response_format === ResponseFormat.JSON
          ? clampJsonList({ count: index.length }, "sections", index, "Response truncated.")
          : clampTextResponse(formatGuidelinesIndexMarkdown(index), "\n\n*(Response truncated.)*");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: apple_app_store_connect_help — App Store Connect Help + TestFlight
// ---------------------------------------------------------------------------

server.registerTool(
  "apple_app_store_connect_help",
  {
    title: "Get App Store Connect Help Article",
    description: `Read App Store Connect Help center articles and the TestFlight product page — the how-to walkthroughs for managing apps, builds, testers, subscriptions, and Game Center in App Store Connect.

This is distinct from the App Store Connect REST API docs (use apple_docs_get_page with path "appstoreconnectapi" for those). Call without a path to list available help articles; pass a path to read one.

Args:
  - path (string, optional): An article path like "help/app-store-connect/test-a-beta-version/testflight-overview", or the exact value "testflight" for the TestFlight product page. Omit for the article index.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
    inputSchema: {
      path: z
        .string()
        .max(300)
        .optional()
        .describe('Help article path or "testflight". Omit to list available articles.'),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ path, response_format }) => {
    try {
      if (path && path.trim()) {
        const article = await fetchHelpArticle(path.trim());
        const text =
          response_format === ResponseFormat.JSON
            ? clampJsonResponse(article, "Response truncated. The article may be long.")
            : clampTextResponse(formatHelpArticleMarkdown(article), "\n\n*(Response truncated.)*");
        return { content: [{ type: "text", text }] };
      }
      const index = await fetchHelpIndex();
      const text =
        response_format === ResponseFormat.JSON
          ? clampJsonList({ count: index.length }, "articles", index, "Response truncated.")
          : clampTextResponse(formatHelpIndexMarkdown(index), "\n\n*(Response truncated.)*");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: apple_forums_list_threads — Apple Developer Forums (listings only)
// ---------------------------------------------------------------------------

server.registerTool(
  "apple_forums_list_threads",
  {
    title: "List Apple Developer Forums Threads",
    description: `List recent Apple Developer Forums thread titles, IDs, and links — optionally filtered by tag.

IMPORTANT LIMITATION: this returns thread *titles and links only*. Apple gates individual thread pages behind a JavaScript bot-challenge, so thread bodies and replies cannot be fetched automatically — open a returned URL in a browser to read the discussion. This is a discovery aid (what's being discussed, and where), not full-text forum search.

Args:
  - tag (string, optional): A forum tag slug to filter by, e.g. "swiftui", "app-store-connect", "widgetkit". Omit for recent threads across all tags.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
    inputSchema: {
      tag: z
        .string()
        .max(60)
        .optional()
        .describe('Forum tag slug like "swiftui". Omit for recent threads across all tags.'),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ tag, response_format }) => {
    try {
      const { tag: resolvedTag, threads } = await fetchForumThreads(tag?.trim() || undefined);
      const text =
        response_format === ResponseFormat.JSON
          ? clampJsonList(
              {
                tag: resolvedTag,
                count: threads.length,
                note: "Thread bodies are not available (bot-challenge gated); titles and links only.",
              },
              "threads",
              threads,
              "Response truncated."
            )
          : clampTextResponse(formatForumThreadsMarkdown(resolvedTag, threads), "\n\n*(Response truncated.)*");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: apple_support_article — support.apple.com consumer Knowledge Base
// ---------------------------------------------------------------------------

server.registerTool(
  "apple_support_article",
  {
    title: "Get an Apple Support (Knowledge Base) Article",
    description: `Fetch a support.apple.com Knowledge Base article by id — the authoritative consumer-facing source for device/feature eligibility lists, compatibility tables, and how-to steps.

Args:
  - id (string): The article id — a modern numeric id ("108351", "102651") or a legacy HT id ("HT201260", auto-resolved to its numeric replacement).
  - locale (string, optional): Locale segment like "en-us" (default) or "de-de".
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns the article title, summary, and body (including eligibility lists/tables). This is Apple's consumer support site, distinct from developer documentation.`,
    inputSchema: {
      id: z.string().min(1).max(20).describe('Article id, e.g. "108351" or "HT201260"'),
      locale: z.string().max(10).optional().describe('Locale like "en-us" (default) or "de-de"'),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, locale, response_format }) => {
    try {
      const article = await fetchSupportArticle(id, locale);
      const text =
        response_format === ResponseFormat.JSON
          ? clampJsonResponse(article, "Response truncated. The article may be long.")
          : clampTextResponse(formatSupportArticleMarkdown(article), "\n\n*(Response truncated.)*");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: apple_ml_research — machinelearning.apple.com research posts
// ---------------------------------------------------------------------------

server.registerTool(
  "apple_ml_research",
  {
    title: "Browse Apple Machine Learning Research",
    description: `Browse or read Apple's first-party Machine Learning Research posts from machinelearning.apple.com.

Call without a slug to list recent research posts; pass a slug to read one (title, authors, date, abstract/body, tags, and external links such as arXiv).

Args:
  - slug (string, optional): A post slug like "environment-free". Omit to list recent posts.
  - limit (number): Max posts when listing, 1–50 (default: 15)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
    inputSchema: {
      slug: z.string().max(200).optional().describe('Post slug like "environment-free". Omit to list recent posts.'),
      limit: z.number().int().min(1).max(50).default(15).describe("Max posts when listing (default: 15)"),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ slug, limit, response_format }) => {
    try {
      if (slug && slug.trim()) {
        const post = await fetchMlResearchPost(slug.trim());
        const text =
          response_format === ResponseFormat.JSON
            ? clampJsonResponse(post, "Response truncated.")
            : clampTextResponse(formatMlResearchPostMarkdown(post), "\n\n*(Response truncated.)*");
        return { content: [{ type: "text", text }] };
      }
      const list = await fetchMlResearchList(limit);
      const text =
        response_format === ResponseFormat.JSON
          ? clampJsonList({ count: list.length }, "posts", list, "Response truncated.")
          : clampTextResponse(formatMlResearchListMarkdown(list), "\n\n*(Response truncated.)*");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: apple_developer_news — Developer News + marketing microsite reader
// ---------------------------------------------------------------------------

server.registerTool(
  "apple_developer_news",
  {
    title: "Read Apple Developer News",
    description: `Read Apple Developer News posts (announcements: policy changes, SDK releases, deadlines) — and, best-effort, the developer marketing/topic microsites.

Modes:
  - No arguments: list recent developer news posts.
  - id: read a single news post by its id (the ?id= value on developer.apple.com/news/).
  - page: best-effort readable extraction of a developer.apple.com marketing microsite (e.g. "apple-intelligence", "private-cloud-compute"). These pages have no structured schema, so extraction is lossy and clearly labeled.

Args:
  - id (string, optional): A news post id like "tlur8uvi".
  - page (string, optional): A marketing microsite slug like "apple-intelligence".
  - limit (number): Max posts when listing, 1–50 (default: 15)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
    inputSchema: {
      id: z.string().max(32).optional().describe('News post id like "tlur8uvi"'),
      page: z.string().max(120).optional().describe('Marketing microsite slug like "apple-intelligence"'),
      limit: z.number().int().min(1).max(50).default(15).describe("Max posts when listing (default: 15)"),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, page, limit, response_format }) => {
    try {
      if (page && page.trim()) {
        const marketing = await fetchMarketingPage(page.trim());
        const text =
          response_format === ResponseFormat.JSON
            ? clampJsonResponse(marketing, "Response truncated.")
            : clampTextResponse(formatMarketingPageMarkdown(marketing), "\n\n*(Response truncated.)*");
        return { content: [{ type: "text", text }] };
      }
      if (id && id.trim()) {
        const post = await fetchNewsPost(id.trim());
        const text =
          response_format === ResponseFormat.JSON
            ? clampJsonResponse(post, "Response truncated.")
            : clampTextResponse(formatNewsPostMarkdown(post), "\n\n*(Response truncated.)*");
        return { content: [{ type: "text", text }] };
      }
      const list = await fetchNewsList(limit);
      const text =
        response_format === ResponseFormat.JSON
          ? clampJsonList({ count: list.length }, "posts", list, "Response truncated.")
          : clampTextResponse(formatNewsListMarkdown(list), "\n\n*(Response truncated.)*");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: apple_technical_qa — legacy Technical Q&A archive
// ---------------------------------------------------------------------------

server.registerTool(
  "apple_technical_qa",
  {
    title: "Get a Legacy Apple Technical Q&A",
    description: `Fetch an archived Apple Technical Q&A (developer.apple.com/library/archive/qa/*) by id.

This is superseded/archived content (each page carries a "no longer updated" banner), but individual Q&As are still referenced for specific low-level techniques. There is no listing (the id space is sparse), so you need a specific id.

Args:
  - id (string): A Technical Q&A id like "qa1361".
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
    inputSchema: {
      id: z.string().min(1).max(20).describe('Technical Q&A id like "qa1361"'),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, response_format }) => {
    try {
      const qa = await fetchTechnicalQa(id);
      const text =
        response_format === ResponseFormat.JSON
          ? clampJsonResponse(qa, "Response truncated.")
          : clampTextResponse(formatTechnicalQaMarkdown(qa), "\n\n*(Response truncated.)*");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Apple Developer Documentation MCP server running via stdio");
}

// Graceful shutdown — bounded by a timeout so a hung close() can't block
// SIGINT/SIGTERM from ever actually terminating the process.
const SHUTDOWN_TIMEOUT_MS = 2000;

async function shutdown(): Promise<void> {
  console.error("Shutting down MCP server...");
  await Promise.race([
    server.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error: unknown) => {
  console.error("Fatal server error:", error);
  process.exit(1);
});
