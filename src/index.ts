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
  parseDocPage,
  parseTechnologies,
  searchFramework,
  formatDocPageMarkdown,
  formatTechnologiesMarkdown,
  formatSearchResultsMarkdown,
} from "./services/apple-docs.js";
import { CHARACTER_LIMIT } from "./constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * RED-213: Safe truncation that avoids cutting mid-surrogate-pair.
 */
function safeTruncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let truncated = text.slice(0, limit);
  // If last char is a high surrogate (0xD800-0xDBFF), remove it to avoid orphan
  const lastCode = truncated.charCodeAt(truncated.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}

function clampTextResponse(text: string, suffix: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  const budget = Math.max(0, CHARACTER_LIMIT - suffix.length);
  return `${safeTruncate(text, budget)}${suffix}`;
}

function summarizeJsonValue(value: unknown, depth = 0): unknown {
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

  const previewBudget = Math.max(0, CHARACTER_LIMIT - minimal.length - 32);
  return JSON.stringify(
    {
      truncated: true,
      note,
      preview: safeTruncate(full, previewBudget),
    },
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
        text = clampJsonResponse(
          parsed,
          "Response truncated. Use apple_docs_get_page with a specific framework path to get details."
        );
      } else {
        text = clampTextResponse(
          formatTechnologiesMarkdown(parsed),
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

Returns rich documentation including: abstract, Swift declaration, full documentation prose, topic sections (with child symbols), platform availability, and relationship info (inheritance, conformances).

Args:
  - path (string): The documentation path (everything after /documentation/ in the Apple docs URL). Case-insensitive.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  For markdown: Formatted documentation including declaration, overview, topics, and relationships.
  For JSON: Full parsed symbol object:
  {
    "title": string,
    "kind": string,             // e.g. "symbol", "article"
    "role": string,             // e.g. "symbol", "collection", "article"
    "abstract": string,
    "declaration": string,      // Swift declaration (if applicable)
    "platforms": [...],
    "path": string,
    "webUrl": string,
    "topicSections": [...],
    "relationships": [...],
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
  - Returns a 404 error message with suggestions if path is not found
  - Use apple_docs_list_technologies to discover valid framework names`,
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

Performs a text search through all references on the framework's documentation page, matching against symbol names and descriptions. This is useful for discovering APIs when you know the framework but not the exact symbol name.

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
apple_docs_get_page directly (e.g. path="swiftui/animation").`,
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
        .describe("Text to search for in symbol titles and descriptions"),
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
      const results = await searchFramework(framework_path, query, limit);

      let text: string;
      if (response_format === ResponseFormat.JSON) {
        text = clampJsonResponse(
          {
            query,
            framework: framework_path,
            count: results.length,
            results,
          },
          "Response truncated. Reduce limit or refine your query."
        );
      } else {
        text = clampTextResponse(
          formatSearchResultsMarkdown(results, query, framework_path),
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
        // Return a trimmed version with just the most useful parts
        const trimmed = {
          identifier: page.identifier,
          kind: page.kind,
          metadata: page.metadata,
          abstract: page.abstract,
          hierarchy: page.hierarchy,
          topicSections: page.topicSections,
          primaryContentSections: page.primaryContentSections,
          _note: `Response truncated. Full references map omitted (${Object.keys(page.references ?? {}).length} entries). Use apple_docs_get_page for formatted output.`,
        };
        text = clampJsonResponse(trimmed, "Response truncated. Use apple_docs_get_page for formatted output.");
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
// Transport
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Apple Developer Documentation MCP server running via stdio");
}

main().catch((error: unknown) => {
  console.error("Fatal server error:", error);
  process.exit(1);
});
