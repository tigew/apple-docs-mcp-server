/**
 * Constants for the Apple Developer Documentation MCP Server
 */

export const APPLE_DEV_ORIGIN = "https://developer.apple.com";
export const APPLE_DOCS_BASE_URL = "https://developer.apple.com/tutorials/data";
export const APPLE_DOCS_WEB_BASE = "https://developer.apple.com/documentation";
// Apple Design guidance (Human Interface Guidelines, SF Symbols) is served by
// the same swift-docc render API as framework docs, but under a `design/` tree
// instead of `documentation/` — both the JSON endpoint and the human web URL
// differ from the documentation tree. Paths in this tree keep their `design/`
// prefix as their canonical internal path.
export const APPLE_DESIGN_PATH_PREFIX = "design/";
// Global cross-framework search — the same API the developer.apple.com search
// page calls (POST {text, targetResultLocale}). Unofficial, like the docs API.
export const APPLE_GLOBAL_SEARCH_URL = "https://devintserv.msc.sbz.apple.com/api/v1/search";
// Hosts the documentation clients are permitted to reach — enforced on every
// redirect hop so a 3xx can't smuggle a fetch to another host.
export const APPLE_DEV_HOST = "developer.apple.com";
export const APPLE_GLOBAL_SEARCH_HOST = "devintserv.msc.sbz.apple.com";
export const CHARACTER_LIMIT = 25000;
export const REQUEST_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Additional Apple-authored surfaces (each a distinct origin from the docs API)
// ---------------------------------------------------------------------------

// "The Swift Programming Language" (TSPL / swift-book) is published as a
// swift-docc-render bundle at docs.swift.org — the SAME render-JSON schema as
// developer.apple.com docs, but under a `/swift-book/data/documentation/` base
// (note: no `tutorials/` segment) and served from a different host.
export const SWIFT_BOOK_HOST = "docs.swift.org";
export const SWIFT_BOOK_JSON_BASE = "https://docs.swift.org/swift-book/data/documentation";
export const SWIFT_BOOK_WEB_BASE = "https://docs.swift.org/swift-book/documentation";
export const SWIFT_BOOK_ROOT_SLUG = "the-swift-programming-language";

// Swift release notes / "What's new in Swift" come from Atom feeds (no JSON API).
export const SWIFT_ORG_HOST = "www.swift.org";
export const SWIFT_ORG_ATOM_URL = "https://www.swift.org/atom.xml";
export const SWIFT_RELEASES_HOST = "github.com";
export const SWIFT_RELEASES_ATOM_URL = "https://github.com/swiftlang/swift/releases.atom";

// WWDC session video + transcript pages — legacy server-rendered HTML, no JSON.
export const WWDC_HOST = "developer.apple.com";
export const WWDC_SESSION_BASE = "https://developer.apple.com/videos/play";

// App Store Review Guidelines — a single server-rendered HTML page with stable
// numeric anchors on every guideline (1, 2.3, 2.3.1, ...).
export const APP_STORE_REVIEW_HOST = "developer.apple.com";
export const APP_STORE_REVIEW_GUIDELINES_URL =
  "https://developer.apple.com/app-store/review/guidelines/";

// App Store Connect Help center + TestFlight product page — server-rendered HTML.
export const ASC_HELP_HOST = "developer.apple.com";
export const ASC_HELP_ORIGIN = "https://developer.apple.com";
export const ASC_HELP_LANDING_URL = "https://developer.apple.com/help/app-store-connect/";
export const ASC_HELP_PATH_PREFIX = "/help/app-store-connect/";
export const ASC_TESTFLIGHT_PATH = "/testflight/";

// Apple Developer Forums — thread bodies are behind a JS bot-challenge that a
// plain-HTTPS client cannot pass, so only listing metadata (thread titles/IDs/
// tags) from the home and per-tag pages is reachable. Bodies are out of scope.
export const APPLE_FORUMS_HOST = "developer.apple.com";
export const APPLE_FORUMS_HOME_URL = "https://developer.apple.com/forums/";
export const APPLE_FORUMS_TAGS_BASE = "https://developer.apple.com/forums/tags";
export const APPLE_FORUMS_THREAD_BASE = "https://developer.apple.com/forums/thread";

// support.apple.com consumer Knowledge Base — server-rendered HTML, no JSON API.
// Articles live at /{locale}/{id}; legacy HT-numbers 301-redirect to numeric ids.
export const SUPPORT_KB_HOST = "support.apple.com";
export const SUPPORT_KB_BASE = "https://support.apple.com";
export const SUPPORT_KB_DEFAULT_LOCALE = "en-us";

// machinelearning.apple.com research posts — a Next.js site whose __NEXT_DATA__
// JSON island carries the full post catalog and per-post fields.
export const ML_RESEARCH_HOST = "machinelearning.apple.com";
export const ML_RESEARCH_LIST_URL = "https://machinelearning.apple.com/research/";
export const ML_RESEARCH_POST_BASE = "https://machinelearning.apple.com/research";

// developer.apple.com Developer News (+ best-effort marketing microsite reader).
export const DEV_NEWS_HOST = "developer.apple.com";
export const DEV_NEWS_INDEX_URL = "https://developer.apple.com/news/";
export const DEV_NEWS_POST_BASE = "https://developer.apple.com/news/";
export const DEV_MARKETING_ORIGIN = "https://developer.apple.com";

// Legacy Technical Q&A archive — static server-rendered HTML at qa{NNNN}/_index.html.
export const LEGACY_QA_HOST = "developer.apple.com";
export const LEGACY_QA_BASE = "https://developer.apple.com/library/archive/qa";
