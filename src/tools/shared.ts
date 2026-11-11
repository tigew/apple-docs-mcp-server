/**
 * Shared plumbing for the MCP tool modules: registration with common
 * annotations and error handling, and format-aware response rendering.
 */

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { paginateJson, paginateJsonList, paginateText } from "./truncation.js";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/** The `response_format` input every formatted tool accepts. */
export const responseFormatParam = z
  .enum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

// Every tool in this server is a repeatable, read-only lookup against a public
// web source.
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** The validated arguments the SDK passes to a tool whose input schema is `Shape`. */
type ToolArgs<Shape extends z.ZodRawShape> = Parameters<ToolCallback<Shape>>[0];

/**
 * Register a read-only tool whose `body` resolves to the response text. An
 * error thrown by `body` is reported to the client as an MCP error result
 * rather than failing the request.
 */
export function registerReadTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: { title: string; description: string; inputSchema: Shape },
  body: (args: ToolArgs<Shape>) => Promise<string>
): void {
  const callback = async (args: ToolArgs<Shape>): Promise<CallToolResult> => {
    try {
      return { content: [{ type: "text", text: await body(args) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  };
  // The SDK's callback type is conditional on the schema, which TypeScript
  // cannot resolve while `Shape` is still generic, hence the cast. It is sound:
  // `callback` takes exactly that type's first parameter and returns its result.
  server.registerTool(
    name,
    { ...config, annotations: READ_ONLY_ANNOTATIONS },
    callback as unknown as ToolCallback<Shape>
  );
}

/**
 * The `offset` input of every tool that can return more than fits in one
 * response. Its unit depends on the response (characters, or list items for a
 * JSON list), so callers treat it as opaque and pass back what they were given.
 */
export const offsetParam = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe(
    "Where to continue a truncated response from: pass the offset that response told you to use. Omit to start at the beginning."
  );

/**
 * Render one value as JSON or markdown. A response too large to return at
 * once is returned a page at a time, starting from `offset`.
 */
export function render<T>(format: ResponseFormat, value: T, toMarkdown: (value: T) => string, offset = 0): string {
  return format === ResponseFormat.JSON ? paginateJson(value, offset) : paginateText(toMarkdown(value), offset);
}

/**
 * Render a list as JSON or markdown, a page at a time from `offset` when it
 * is too large to return at once. JSON is `{ ...base, [key]: items }`, paged
 * by whole items so every page is valid JSON.
 */
export function renderList<T>(
  format: ResponseFormat,
  list: { base: Record<string, unknown>; key: string; items: T[] },
  toMarkdown: (items: T[]) => string,
  offset = 0
): string {
  return format === ResponseFormat.JSON
    ? paginateJsonList(list.base, list.key, list.items, offset)
    : paginateText(toMarkdown(list.items), offset);
}
