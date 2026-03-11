# Apple Developer Documentation MCP Server

An MCP (Model Context Protocol) server that gives Claude and other LLMs direct access to Apple's entire developer documentation — frameworks, symbols, articles, and more.

**No API key required.** Uses Apple's public documentation CDN.

---

## Tools

| Tool | Description |
|------|-------------|
| `apple_docs_list_technologies` | List all Apple frameworks grouped by category |
| `apple_docs_get_page` | Get documentation for any framework, symbol, or article |
| `apple_docs_search` | Search within a framework by keyword |
| `apple_docs_get_symbol_raw` | Fetch raw JSON from Apple's documentation API |

### Example prompts once connected

- *"What are the most important SwiftUI view modifiers?"*
- *"Show me the documentation for URLSession"*
- *"How do I use async/await in Swift?"*
- *"What properties does UIViewController have?"*
- *"Search SwiftUI for animation-related APIs"*
- *"List all Apple frameworks"*

---

## Installation

### Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org)

---

### Claude Code (easiest)

```bash
git clone https://github.com/tigew/apple-docs-mcp-server.git ~/apple-docs-mcp-server
cd ~/apple-docs-mcp-server && npm install && npm run build
claude mcp add apple-docs -- node ~/apple-docs-mcp-server/dist/index.js
```

Done. The last command registers it automatically — no config files to edit.

---

### Claude Desktop

**Step 1** — Clone and build:

```bash
git clone https://github.com/tigew/apple-docs-mcp-server.git
cd apple-docs-mcp-server
npm install && npm run build
pwd  # copy this path — you'll need it in the next step
```

**Step 2** — Open your Claude Desktop config:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

**Step 3** — Add the server:

```json
{
  "mcpServers": {
    "apple-docs": {
      "command": "node",
      "args": ["/paste/your/path/here/apple-docs-mcp-server/dist/index.js"]
    }
  }
}
```

**Step 4** — Restart Claude Desktop.

---

### Verify it's working

Ask Claude: *"List all Apple developer frameworks"* — it should call `apple_docs_list_technologies` and return a categorized list.

---

## Usage Examples

### Get framework overview
```
apple_docs_get_page(path="swiftui")
apple_docs_get_page(path="foundation")
apple_docs_get_page(path="swift")
```

### Look up a specific type
```
apple_docs_get_page(path="swiftui/view")
apple_docs_get_page(path="swift/array")
apple_docs_get_page(path="uikit/uiviewcontroller")
apple_docs_get_page(path="foundation/urlsession")
apple_docs_get_page(path="combine/publisher")
```

### Search within a framework
```
apple_docs_search(framework_path="swiftui", query="animation")
apple_docs_search(framework_path="foundation", query="url")
apple_docs_search(framework_path="uikit", query="table")
```

### Discover path conventions

Paths mirror the URL at `developer.apple.com/documentation/`. For example:
- `developer.apple.com/documentation/swiftui/view` → path `"swiftui/view"`
- `developer.apple.com/documentation/swift/array/map(_:)` → path `"swift/array/map(_:)"`

---

## How it works

Apple exposes a public JSON API that powers their documentation website. Each page at:
```
https://developer.apple.com/documentation/{path}
```
has a corresponding JSON file at:
```
https://developer.apple.com/tutorials/data/documentation/{path}.json
```

This MCP server fetches and parses those JSON files, extracting declarations, abstracts, topic sections, platform availability, relationships (inheritance, conformances), and prose documentation.

---

## Development

```bash
# Watch mode (auto-recompile on changes)
npm run dev

# Clean build artifacts
npm run clean && npm run build
```

---

## Notes

- **Rate limiting**: Apple's CDN is generally permissive for documentation fetches, but avoid hammering it in tight loops.
- **Unofficial API**: This uses Apple's undocumented JSON API. It has been stable for years but could theoretically change.
- **No auth needed**: All documentation is publicly accessible without a developer account.
