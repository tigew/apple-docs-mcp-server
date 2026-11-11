import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// End-to-end checks of the built server over stdio. Everything here is answered
// without a network request, so the suite stays offline.

const SERVER = fileURLToPath(new URL("../dist/index.js", import.meta.url));

// Start the server, hand `use` a JSON-RPC request function plus the server's
// `initialize` result, and stop the server.
async function withServer(use) {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 10000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  try {
    const initialized = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "server-test", version: "0" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return await use(rpc, initialized);
  } finally {
    child.kill();
  }
}

test("the server lists every tool, in registration order", async () => {
  const { tools } = await withServer((rpc) => rpc("tools/list", {}));

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "apple_docs_list_technologies",
      "apple_docs_get_page",
      "apple_docs_search",
      "apple_docs_find_symbol",
      "apple_docs_get_symbol_raw",
      "apple_swift_book_get_page",
      "apple_swift_get_release_notes",
      "apple_wwdc_get_session",
      "apple_app_store_review_guidelines",
      "apple_app_store_connect_help",
      "apple_forums_list_threads",
      "apple_support_article",
      "apple_ml_research",
      "apple_developer_news",
      "apple_technical_qa",
    ]
  );
});

test("every tool is advertised as a read-only lookup", async () => {
  const { tools } = await withServer((rpc) => rpc("tools/list", {}));

  for (const tool of tools) {
    assert.deepEqual(
      tool.annotations,
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      tool.name
    );
  }
});

test("a tool reports a rejected input as an error result, not a failed request", async () => {
  // Path validation rejects this before any network request is made.
  const result = await withServer((rpc) =>
    rpc("tools/call", { name: "apple_docs_get_page", arguments: { path: "../etc/passwd" } })
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Error: Invalid path .*path traversal/);
});

test("the server reports the version from package.json", async () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  const initialized = await withServer((_rpc, initialized) => initialized);

  assert.equal(initialized.serverInfo.version, packageJson.version);
});

test("the package's bin command points at the built, executable entry script", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.deepEqual(Object.keys(packageJson.bin ?? {}), ["apple-docs-mcp-server"]);
  const script = readFileSync(new URL(`../${packageJson.bin["apple-docs-mcp-server"]}`, import.meta.url), "utf8");
  assert.match(script, /^#!\/usr\/bin\/env node\n/);
});

test("every tool that can return a long document accepts an offset to continue it", async () => {
  const { tools } = await withServer((rpc) => rpc("tools/list", {}));

  const paged = tools.filter((tool) => "offset" in tool.inputSchema.properties).map((tool) => tool.name);
  assert.deepEqual(paged, [
    "apple_docs_get_page",
    "apple_swift_book_get_page",
    "apple_swift_get_release_notes",
    "apple_wwdc_get_session",
    "apple_app_store_review_guidelines",
    "apple_app_store_connect_help",
    "apple_forums_list_threads",
    "apple_support_article",
    "apple_ml_research",
    "apple_developer_news",
    "apple_technical_qa",
  ]);
});

test("apple_wwdc_get_session needs only a year, so it can list and search sessions", async () => {
  const { tools } = await withServer((rpc) => rpc("tools/list", {}));
  const wwdc = tools.find((tool) => tool.name === "apple_wwdc_get_session");

  assert.deepEqual(wwdc.inputSchema.required, ["year"]);
  assert.ok("query" in wwdc.inputSchema.properties);
});

test("apple_docs_get_page can be asked for the Objective-C version of a page", async () => {
  const { tools } = await withServer((rpc) => rpc("tools/list", {}));
  const getPage = tools.find((tool) => tool.name === "apple_docs_get_page");

  assert.deepEqual(getPage.inputSchema.properties.language.enum, ["swift", "objc"]);
  assert.equal(getPage.inputSchema.properties.language.default, "swift");
});
