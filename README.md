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
- **Claude Desktop** (or any MCP-compatible client)

### 1. Set up the project

```bash
# Navigate to the folder
cd apple-docs-mcp-server

# Install dependencies
npm install

# Build
npm run build
```

### 2. Configure Claude Desktop

Open your Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add the server under `mcpServers`:

```json
{
  "mcpServers": {
    "apple-docs": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/apple-docs-mcp-server/dist/index.js"]
    }
  }
}
```

Replace `/ABSOLUTE/PATH/TO/` with the actual path to this folder. Then restart Claude Desktop.

### 3. Verify it's working

In Claude, ask: *"List all Apple developer frameworks"* — Claude should call `apple_docs_list_technologies` and return a categorized list.

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
