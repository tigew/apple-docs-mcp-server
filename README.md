# Apple Developer Documentation MCP Server

An MCP (Model Context Protocol) server that gives Claude and other LLMs direct access to Apple's entire developer documentation — frameworks, symbols, articles, and more.

**No API key required.** Uses Apple's public documentation CDN.

---

## Tools

**Developer documentation** (`developer.apple.com/documentation` + Human Interface Guidelines):

| Tool | Description |
|------|-------------|
| `apple_docs_list_technologies` | List all Apple frameworks grouped by category |
| `apple_docs_get_page` | Get documentation for any framework, symbol, article, or **HIG / SF Symbols design** page |
| `apple_docs_search` | Search within a framework by keyword |
| `apple_docs_find_symbol` | Find a symbol across **all** frameworks (when you don't know which framework defines it) |
| `apple_docs_get_symbol_raw` | Fetch raw JSON from Apple's documentation API |

**Beyond the docs tree** (other Apple-authored surfaces):

| Tool | Description |
|------|-------------|
| `apple_swift_book_get_page` | Read *The Swift Programming Language* (TSPL) chapters from swift.org — the language reference the framework docs defer to |
| `apple_swift_get_release_notes` | Recent Swift release notes / "What's new in Swift" from swift.org |
| `apple_wwdc_get_session` | Read a WWDC session **transcript**, chapters, and code samples — or list and search a year's sessions to find the session id |
| `apple_app_store_review_guidelines` | Browse or read a numbered App Store Review Guideline (e.g. `2.3.1`) |
| `apple_app_store_connect_help` | Read App Store Connect Help articles and the TestFlight page |
| `apple_forums_list_threads` | List recent Developer Forums thread titles/links (optionally by tag) — see note below |
| `apple_support_article` | Read a support.apple.com Knowledge Base article (device/feature eligibility, compatibility) by id |
| `apple_ml_research` | Browse/read Apple Machine Learning Research posts from machinelearning.apple.com |
| `apple_developer_news` | List/read Apple Developer News posts; best-effort reader for marketing microsites |
| `apple_technical_qa` | Read an archived legacy Technical Q&A (`qa1361`) |

> **Design guidance** (Human Interface Guidelines, SF Symbols) is served by the same DocC backend as framework docs, so it's reached through `apple_docs_get_page` with a `design/…` path (e.g. `design/human-interface-guidelines/buttons`), not a separate tool. The downloadable design templates at **developer.apple.com/design/resources/** are a static (non-DocC) download page, so they aren't fetchable through these tools — visit that URL directly for Sketch/Figma/Photoshop templates.

> **Forums limitation:** `apple_forums_list_threads` returns thread **titles and links only**. Apple gates individual thread pages behind a JavaScript bot-challenge that a plain-HTTPS client can't pass, so post bodies and replies can't be fetched automatically — open a returned URL in a browser to read a thread.

### Example prompts once connected

- *"What are the most important SwiftUI view modifiers?"*
- *"Show me the documentation for URLSession"*
- *"What does the Human Interface Guidelines say about buttons?"*
- *"How does Swift handle actors and concurrency?"* (reads TSPL)
- *"Get the transcript for WWDC 2024 session 10176"*
- *"Which WWDC 2024 sessions cover Swift Testing?"* (searches the year's sessions)
- *"What are the App Store rules on accurate metadata?"* (guideline 2.3)
- *"List all Apple frameworks"*

---

## Installation

### Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **git** — `npx` fetches this repository with it

---

### Claude Code (easiest)

```bash
claude mcp add --scope user apple-docs -- npx -y github:tigew/apple-docs-mcp-server
```

Done. `npx` downloads this repository from GitHub, builds it, and runs it. The `--scope user` flag makes it available in every project, not just this folder.

> **Use the `github:` form exactly as written.** This project is not published to npm, and the bare name `apple-docs-mcp-server` on the npm registry is an unrelated package by another author — `npx apple-docs-mcp-server` would run that one, not this server.

---

### Claude Desktop

**Step 1** — Open your Claude Desktop config:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

**Step 2** — Add the server:

```json
{
  "mcpServers": {
    "apple-docs": {
      "command": "npx",
      "args": ["-y", "github:tigew/apple-docs-mcp-server"]
    }
  }
}
```

**Step 3** — Restart Claude Desktop.

---

### From a local clone

Use this instead if you want to change the code or stay on a specific commit:

```bash
git clone https://github.com/tigew/apple-docs-mcp-server.git ~/apple-docs-mcp-server
cd ~/apple-docs-mcp-server && npm install   # also builds
claude mcp add --scope user apple-docs -- node ~/apple-docs-mcp-server/dist/index.js
```

For Claude Desktop, use `"command": "node"` with `"args": ["/full/path/to/apple-docs-mcp-server/dist/index.js"]`. After pulling new commits, run `npm run build` and restart the client.

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

### Find a symbol when you don't know its framework
```
apple_docs_find_symbol(query="RelevantContext")   → RelevanceKit
apple_docs_find_symbol(query="WidgetRelevance")   → WidgetKit
```
Types often appear in one framework's signatures but are defined in another (e.g. `RelevantContext` shows up in WidgetKit APIs but lives in RelevanceKit).

### Web-service (REST) reference pages

Endpoint, object, and enumeration pages render their full reference data, not just the summary:

```
apple_docs_get_page(path="appstoreconnectapi/get-v1-apps")   → method and URL, query parameters, response codes, example
apple_docs_get_page(path="appstoreconnectapi/app")           → the object's properties and their types
apple_docs_get_page(path="appstoreconnectapi/platform")      → the possible values
```

### Objective-C

```
apple_docs_get_page(path="uikit/uiview/addsubview(_:)", language="objc")   → "- (void) addSubview:(UIView *) view;"
apple_docs_search(framework_path="uikit", query="drawRect")                → finds draw(_:), shown with its Objective-C name
```

Search covers both the Swift and Objective-C symbol trees, and an Objective-C selector used as a path (`uikit/uiview/drawrect:`) resolves to the page it shares with the Swift method.

### Reading long responses

A response too long to return at once ends with a note such as `Call again with offset=24663 to continue`. Pass that `offset` back to the same tool, with the same arguments, to get the next part — this is how a full WWDC transcript or a long article is read to the end. JSON responses page the same way (`next_offset`).

### Forgiving path resolution

`apple_docs_get_page` recovers from imperfect paths instead of returning a bare 404:

- **Wrong framework, exact name** — `widgetkit/relevantcontext` auto-resolves to `relevancekit/relevantcontext`
- **Legacy/renamed types** — `cloudkit/cksharemetadata` auto-resolves to `cloudkit/ckshare/metadata` (`CKShare.Metadata`)
- **Bare member names** — `swiftui/view/onappear` auto-resolves to `swiftui/view/onappear(perform:)`; if the name has *multiple* overloads (e.g. `appintents/intentresult/result`), the error lists every overload with its full declaration and disambiguation-suffixed path
- **Typos** — `…/relevances()` returns a "did you mean" list including `…/relevance()`

Whenever a different page is returned than the one asked for, the response opens with a note naming both paths.

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

**Human Interface Guidelines / SF Symbols** use the very same DocC render API, just under a `design/` tree (`…/tutorials/data/design/{path}.json`), so `apple_docs_get_page` serves them through the same parser.

**Other surfaces** each talk to a different origin and are fetched through a shared, SSRF-hardened client (HTTPS-only, per-surface host allowlist, redirect targets re-validated on every hop):
- **Swift.org** (`docs.swift.org`) publishes TSPL with the identical DocC schema, so it reuses the same parser; release notes come from swift.org / GitHub Atom feeds.
- **machinelearning.apple.com** exposes its full post catalog via a `__NEXT_DATA__` JSON island (parsed as JSON, not scraped).
- **WWDC**, **App Store Review Guidelines**, **App Store Connect Help**, **Forums listings**, **support.apple.com KB**, **Developer News**, and **legacy Technical Q&A** are server-rendered HTML with no JSON API, parsed with `cheerio`.
- **Marketing microsites** (`apple-intelligence`, `private-cloud-compute`) have no per-page schema, so `apple_developer_news`'s `page` mode does a clearly-labeled best-effort readability pass only.

---

## Development

```bash
# Watch mode (auto-recompile on changes)
npm run dev

# Offline parser/formatter regression suite
npm test

# Clean build artifacts
npm run clean && npm run build
```

---

## Notes

- **Caching**: Responses are kept in memory and reused — reference pages for 30 minutes, a framework's symbol index for an hour, listings of new content (forums, news, release feeds) for 5 minutes. A path found not to exist is remembered for 10 minutes. Nothing is written to disk, so each new server process starts empty.
- **Retries and rate limiting**: A request that fails with a server error, a brief rate limit, or a dropped connection is retried up to twice with growing waits. Apple's CDN is generally permissive for documentation fetches, but avoid hammering it in tight loops.
- **Unofficial API**: This uses Apple's undocumented JSON API. It has been stable for years but could theoretically change. Global search (`apple_docs_find_symbol` and cross-framework 404 recovery) additionally uses the API behind the developer.apple.com search page; if that endpoint changes, those features degrade gracefully to plain 404s while everything else keeps working.
- **HTML-scraped surfaces are more fragile**: WWDC, App Store Review Guidelines, App Store Connect Help, and Forums listings are parsed from server-rendered HTML (no JSON API exists for them). If Apple restyles those pages, extraction for that surface may need updating, while the JSON-backed docs, HIG, and Swift-book tools keep working.
- **No auth needed**: All content is publicly accessible without a developer account.
