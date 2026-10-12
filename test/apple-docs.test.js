import test from "node:test";
import assert from "node:assert/strict";

import {
  boundedEditDistance,
  dedupeSearchResults,
  formatGlobalSearchResultsMarkdown,
  formatTechnologiesMarkdown,
  parseGlobalSearchResponse,
  resolveFromIndexSymbols,
  extractOverview,
  extractParameters,
  extractText,
  flattenFrameworkIndexNodes,
  formatDocPageMarkdown,
  formatSearchResultsMarkdown,
  normalizePath,
  parseDocPage,
  parseTechnologies,
  resolveChildPathFromParentPage,
  searchReferencesInPage,
} from "../dist/services/apple-docs.js";

function createBasePage() {
  return {
    identifier: {
      url: "/documentation/testkit",
      interfaceLanguage: "swift",
    },
    kind: "symbol",
    metadata: {
      title: "TestKit",
      role: "collection",
      platforms: [],
    },
    abstract: [{ type: "text", text: "Base abstract" }],
    primaryContentSections: [],
    topicSections: [],
    seeAlsoSections: [],
    relationshipsSections: [],
    references: {},
  };
}

test("normalizePath accepts Apple docs URLs and strips transport-only suffixes", () => {
  assert.equal(
    normalizePath(" https://developer.apple.com/documentation/SwiftUI//View.JSON?utm=1#overview "),
    "swiftui/view"
  );
  assert.equal(normalizePath("/documentation/Foundation/URLSession/"), "foundation/urlsession");
});

test("normalizePath preserves the design/ tree for HIG paths across input forms", () => {
  // Design (HIG / SF Symbols) pages keep their design/ prefix as the canonical
  // path — that prefix is how fetch routing picks the /design/ JSON endpoint.
  assert.equal(
    normalizePath("design/Human-Interface-Guidelines/Buttons"),
    "design/human-interface-guidelines/buttons"
  );
  assert.equal(
    normalizePath("https://developer.apple.com/design/human-interface-guidelines/typography"),
    "design/human-interface-guidelines/typography"
  );
  assert.equal(
    normalizePath("doc://com.apple.HIG/design/Human-Interface-Guidelines/sf-symbols"),
    "design/human-interface-guidelines/sf-symbols"
  );
  // The documentation tree still strips its prefix (unchanged behavior).
  assert.equal(
    normalizePath("doc://com.apple.SwiftUI/documentation/SwiftUI/View"),
    "swiftui/view"
  );
});

test("parseDocPage builds a /design/ web URL for HIG pages, not /documentation/design/", () => {
  const page = {
    identifier: { url: "doc://com.apple.HIG/design/Human-Interface-Guidelines/buttons", interfaceLanguage: "swift" },
    kind: "article",
    metadata: { title: "Buttons", role: "collection", platforms: [] },
    abstract: [{ type: "text", text: "Guidance on buttons." }],
    primaryContentSections: [],
    topicSections: [],
    seeAlsoSections: [],
    relationshipsSections: [],
  };
  const parsed = parseDocPage(page, "design/human-interface-guidelines/buttons");
  assert.equal(parsed.path, "design/human-interface-guidelines/buttons");
  assert.equal(parsed.webUrl, "https://developer.apple.com/design/human-interface-guidelines/buttons");
});

test("normalizePath rejects traversal and empty normalized paths", () => {
  assert.throws(() => normalizePath("%2e%2e/secret"), /path traversal/);
  assert.throws(() => normalizePath(" /documentation/ "), /no documentation path remained/);
  assert.throws(
    () => normalizePath("https://carekit-apple.github.io/CareKit/documentation/carekit"),
    /only developer\.apple\.com documentation URLs are supported/
  );
});

test("parseTechnologies handles live-style technology groups, dedupes entries, and preserves external links", () => {
  const page = {
    ...createBasePage(),
    sections: [
      {
        kind: "technologies",
        groups: [
          {
            name: "App Frameworks",
            technologies: [
              {
                title: "SwiftUI",
                destination: { identifier: "doc://swiftui", type: "reference", isActive: true },
                content: [{ type: "text", text: "Declarative UI" }],
              },
              {
                title: "External CareKit",
                destination: { identifier: "https://carekit.example/docs", type: "reference", isActive: true },
                content: [{ type: "text", text: "Health framework docs" }],
              },
              {
                title: "SwiftUI duplicate",
                destination: { identifier: "doc://swiftui", type: "reference", isActive: true },
              },
            ],
            identifiers: ["doc://uikit"],
          },
        ],
      },
    ],
    references: {
      "doc://swiftui": {
        identifier: "doc://swiftui",
        type: "topic",
        title: "SwiftUI",
        url: "/documentation/swiftui",
        abstract: [{ type: "text", text: "Declarative UI" }],
      },
      "doc://uikit": {
        identifier: "doc://uikit",
        type: "topic",
        title: "UIKit",
        url: "/documentation/uikit",
        abstract: [{ type: "text", text: "Imperative UI" }],
      },
      "https://carekit.example/docs": {
        identifier: "https://carekit.example/docs",
        type: "link",
        url: "https://carekit.example/docs",
      },
    },
  };

  const parsed = parseTechnologies(page);
  assert.equal(parsed.sections.length, 1);
  assert.equal(parsed.sections[0].title, "App Frameworks");
  assert.deepEqual(
    parsed.sections[0].technologies.map((technology) => technology.title),
    ["SwiftUI", "External CareKit", "UIKit"]
  );
  assert.equal(parsed.sections[0].technologies[0].url, "/documentation/swiftui");
  assert.equal(parsed.sections[0].technologies[1].url, "https://carekit.example/docs");
  assert.equal(parsed.sections[0].technologies[1].abstract, "Health framework docs");
  assert.equal(parsed.sections[0].technologies[2].url, "/documentation/uikit");
});

test("extractOverview renders large mixed content without malformed trailing headings", () => {
  const lines = Array.from({ length: 150 }, (_, index) => ({
    type: "paragraph",
    inlineContent: [{ type: "text", text: `Paragraph ${index}` }],
  }));

  const overview = extractOverview([
    {
      kind: "content",
      content: [
        {
          type: "heading",
          level: 2,
          text: "Overview",
        },
        {
          type: "table",
          header: "row",
          rows: [
            {
              cells: [
                { content: [{ type: "paragraph", inlineContent: [{ type: "text", text: "A|B" }] }] },
                { content: [{ type: "paragraph", inlineContent: [{ type: "text", text: "C" }] }] },
              ],
            },
            {
              cells: [
                { content: [{ type: "paragraph", inlineContent: [{ type: "text", text: "1" }] }] },
                { content: [{ type: "paragraph", inlineContent: [{ type: "text", text: "2" }] }] },
              ],
            },
          ],
        },
        {
          type: "aside",
          style: "note",
          content: [{ type: "paragraph", inlineContent: [{ type: "text", text: "Remember this." }] }],
        },
        ...lines,
        {
          type: "heading",
          level: 3,
          text: "Dangling heading",
        },
      ],
    },
  ]);

  assert.match(overview, /\| A\\\|B \| C \|/);
  assert.match(overview, /> \*\*\[NOTE\]\*\* Remember this\./);
  assert.doesNotMatch(overview, /Dangling heading$/);
  assert.match(overview, /Paragraph 149/);
});

test("parseDocPage and markdown formatting remain bounded on large section payloads", () => {
  const page = createBasePage();

  for (let index = 0; index < 40; index += 1) {
    const identifier = `doc://item/${index}`;
    page.references[identifier] = {
      identifier,
      type: "topic",
      title: `Item ${index}`,
      url: `/documentation/testkit/item-${index}`,
      kind: "symbol",
      role: "symbol",
      abstract: [{ type: "text", text: `Abstract ${index}` }],
    };
  }

  page.topicSections = [{ title: "Topics", anchor: "topics", identifiers: Object.keys(page.references) }];
  page.seeAlsoSections = [{ title: "See also", anchor: "see-also", identifiers: Object.keys(page.references) }];
  page.relationshipsSections = [
    {
      kind: "relationships",
      type: "conformsTo",
      title: "Conforms To",
      identifiers: Object.keys(page.references),
    },
  ];

  const parsed = parseDocPage(page, "TestKit");
  const markdown = formatDocPageMarkdown(parsed);

  assert.equal(parsed.path, "testkit");
  assert.match(markdown, /\# TestKit/);
  assert.match(markdown, /\(20 more items\.\.\.\)/);
  assert.match(markdown, /\(25 more\.\.\.\)/);
  assert.ok(markdown.length > 1000);
});

test("parseDocPage prefers the fetched page identifier over a stale requested alias", () => {
  const page = {
    ...createBasePage(),
    identifier: {
      url: "/documentation/swiftui/view/modifier(_:)",
      interfaceLanguage: "swift",
    },
    metadata: {
      title: "modifier(_:)",
      role: "symbol",
      platforms: [],
    },
  };

  const parsed = parseDocPage(page, "swiftui/view/modifier(_:)-bogus");
  assert.equal(parsed.path, "swiftui/view/modifier(_:)");
  assert.equal(parsed.webUrl, "https://developer.apple.com/documentation/swiftui/view/modifier(_:)");
});

test("resolveChildPathFromParentPage matches overloaded symbol paths by title and slug prefix", () => {
  const parentPage = {
    ...createBasePage(),
    identifier: {
      url: "/documentation/swift/array",
      interfaceLanguage: "swift",
    },
    metadata: {
      title: "Array",
      role: "symbol",
      platforms: [],
    },
    references: {
      "doc://map": {
        identifier: "doc://map",
        type: "topic",
        title: "map(_:)",
        role: "symbol",
        kind: "symbol",
        url: "/documentation/swift/array/map(_:)-87vg",
      },
      "doc://filter": {
        identifier: "doc://filter",
        type: "topic",
        title: "filter(_:)",
        role: "symbol",
        kind: "symbol",
        url: "/documentation/swift/array/filter(_:)",
      },
      "doc://body": {
        identifier: "doc://body",
        type: "topic",
        title: "body",
        role: "symbol",
        kind: "symbol",
        url: "https://developer.apple.com/documentation/swift/array/body-swift.property",
      },
    },
  };

  assert.equal(resolveChildPathFromParentPage(parentPage, "swift/array", "map(_:)"), "swift/array/map(_:)-87vg");
  assert.equal(
    resolveChildPathFromParentPage(parentPage, "swift/array", "body-swift.property"),
    "swift/array/body-swift.property"
  );
  assert.equal(resolveChildPathFromParentPage(parentPage, "swift/array", "filter(_)"), null);
});

test("searchReferencesInPage finds child-only symbols inside scoped framework pages", () => {
  const results = searchReferencesInPage(
    {
      ...createBasePage(),
      references: {
        "doc://urlsession": {
          identifier: "doc://urlsession",
          type: "topic",
          title: "URLSession",
          role: "symbol",
          kind: "symbol",
          url: "/documentation/foundation/urlsession",
          abstract: [{ type: "text", text: "Loads data from URLs." }],
        },
        "doc://other": {
          identifier: "doc://other",
          type: "topic",
          title: "UIView",
          role: "symbol",
          kind: "symbol",
          url: "/documentation/uikit/uiview",
          abstract: [{ type: "text", text: "UIKit view." }],
        },
      },
    },
    "urlsession",
    "foundation"
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].path, "foundation/urlsession");
  assert.match(results[0].webUrl, /developer\.apple\.com\/documentation\/foundation\/urlsession$/);
});

test("dedupeSearchResults prefers canonical unsuffixed paths for duplicate aliases", () => {
  const deduped = dedupeSearchResults([
    {
      title: "contentToolbar(for:content:)",
      path: "swiftui/view/contenttoolbar(for:content:)-9f1kx",
      webUrl: "https://developer.apple.com/documentation/swiftui/view/contenttoolbar(for:content:)-9f1kx",
      abstract: "Populates the toolbar of the specified content view type with the views you provide.",
      kind: "symbol",
      role: "symbol",
    },
    {
      title: "contentToolbar(for:content:)",
      path: "swiftui/view/contenttoolbar(for:content:)",
      webUrl: "https://developer.apple.com/documentation/swiftui/view/contenttoolbar(for:content:)",
      abstract: "Populates the toolbar of the specified content view type with the views you provide.",
      kind: "symbol",
      role: "symbol",
    },
    {
      title: "body",
      path: "swiftui/uiviewrepresentable/body",
      webUrl: "https://developer.apple.com/documentation/swiftui/uiviewrepresentable/body",
      abstract: "Declares the content and behavior of this view.",
      kind: "symbol",
      role: "symbol",
    },
  ]);

  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].path, "swiftui/view/contenttoolbar(for:content:)");
  assert.equal(deduped[1].path, "swiftui/uiviewrepresentable/body");
});

test("formatDocPageMarkdown renders explicit caps for section sizes", () => {
  const parsed = {
    title: "Formatter Check",
    kind: "symbol",
    role: "symbol",
    abstract: "Short abstract",
    declaration: "struct FormatterCheck {}",
    platforms: [],
    path: "formattercheck",
    webUrl: "https://developer.apple.com/documentation/formattercheck",
    overview: "Overview body",
    topicSections: [
      {
        title: "Topics",
        items: Array.from({ length: 21 }, (_, index) => ({
          title: `Topic ${index}`,
          path: `formattercheck/topic-${index}`,
          abstract: "",
          kind: "symbol",
          role: "symbol",
        })),
      },
    ],
    relationships: [
      {
        title: "Relationships",
        type: "inheritsFrom",
        items: Array.from({ length: 16 }, (_, index) => ({
          title: `Rel ${index}`,
          path: `formattercheck/rel-${index}`,
        })),
      },
    ],
    seeAlsoSections: [
      {
        title: "See also",
        items: Array.from({ length: 22 }, (_, index) => ({
          title: `See ${index}`,
          path: `formattercheck/see-${index}`,
          abstract: "",
          kind: "symbol",
          role: "symbol",
        })),
      },
    ],
  };

  const markdown = formatDocPageMarkdown(parsed);
  assert.match(markdown, /\(1 more items\.\.\.\)/);
  assert.match(markdown, /\(1 more\.\.\.\)/);
  assert.match(markdown, /\(2 more items\.\.\.\)/);
});

// =========================================================================
// New tests for bug fixes
// =========================================================================

test("normalizePath rejects double-encoded path traversal (BUG-15)", () => {
  assert.throws(() => normalizePath("%252e%252e/secret"), /path traversal/);
});

test("normalizePath rejects dangerous URI schemes (data:, javascript:)", () => {
  assert.throws(() => normalizePath("javascript:alert(1)"), /unsupported URI scheme/);
  assert.throws(() => normalizePath("data:text/html,<script>"), /unsupported URI scheme/);
  assert.throws(() => normalizePath("ftp://example.com/foo"), /unsupported URI scheme/);
});

test("normalizePath rejects paths with URL-unsafe characters (@, ;, ,)", () => {
  assert.throws(() => normalizePath("swiftui;evil=1"), /not allowed in documentation paths/);
  assert.throws(() => normalizePath("evil@host"), /not allowed in documentation paths/);
});

test("normalizePath handles doc:// URIs", () => {
  assert.equal(
    normalizePath("doc://com.apple.SwiftUI/documentation/SwiftUI/View"),
    "swiftui/view"
  );
});

test("normalizePath control character edge cases", () => {
  assert.throws(() => normalizePath("swift\x00ui"), /control characters/);
  assert.throws(() => normalizePath("swift\x7Fui"), /control characters/);
  assert.throws(() => normalizePath("swift\x80ui"), /control characters/);
  // 0xA0 (non-breaking space) should NOT throw for control chars
  assert.doesNotThrow(() => normalizePath("swift\u00A0ui"));
});

test("normalizePath idempotency", () => {
  const once = normalizePath("SwiftUI/View");
  const twice = normalizePath(once);
  assert.equal(once, twice);
});

test("parseDocPage handles doc:// identifier URLs and produces correct webUrl (NEW-1)", () => {
  const page = {
    ...createBasePage(),
    identifier: {
      url: "doc://com.apple.SwiftUI/documentation/SwiftUI/View",
      interfaceLanguage: "swift",
    },
    metadata: {
      title: "View",
      role: "symbol",
      platforms: [],
    },
  };

  const parsed = parseDocPage(page, "swiftui/view");
  assert.equal(parsed.path, "swiftui/view");
  assert.equal(parsed.webUrl, "https://developer.apple.com/documentation/swiftui/view");
});

test("extractText handles all inline content types including strikethrough, sub, sup", () => {
  const refs = {};

  // Basic types
  assert.equal(extractText(undefined), "");
  assert.equal(extractText([{ type: "text", text: "hello" }]), "hello");
  assert.equal(extractText([{ type: "codeVoice", code: "Array" }]), "`Array`");
  assert.equal(extractText([{ type: "newTerm", text: "protocol" }]), "*protocol*");

  // Emphasis / strong
  assert.equal(
    extractText([{ type: "emphasis", inlineContent: [{ type: "text", text: "italic" }] }]),
    "*italic*"
  );
  assert.equal(
    extractText([{ type: "emphasis", inlineContent: [] }]),
    ""
  );
  assert.equal(
    extractText([{ type: "strong", inlineContent: [{ type: "text", text: "bold" }] }]),
    "**bold**"
  );

  // Strikethrough, subscript, superscript
  assert.equal(
    extractText([{ type: "strikethrough", inlineContent: [{ type: "text", text: "old" }] }]),
    "~~old~~"
  );
  assert.equal(
    extractText([{ type: "subscript", inlineContent: [{ type: "text", text: "2" }] }]),
    "<sub>2</sub>"
  );
  assert.equal(
    extractText([{ type: "superscript", inlineContent: [{ type: "text", text: "n" }] }]),
    "<sup>n</sup>"
  );

  // Links
  assert.equal(
    extractText([{ type: "link", title: "Apple", destination: "https://apple.com" }]),
    "[Apple](https://apple.com)"
  );
  assert.equal(extractText([{ type: "link", destination: "https://apple.com" }]), "https://apple.com");
  assert.equal(extractText([{ type: "link", title: "Apple" }]), "Apple");
  assert.equal(extractText([{ type: "link" }]), "");

  // Unknown type with inlineContent fallback
  assert.equal(
    extractText([{ type: "unknownFuture", inlineContent: [{ type: "text", text: "fallback" }] }]),
    "fallback"
  );

  // Unknown type with text fallback
  assert.equal(
    extractText([{ type: "unknownFuture", text: "raw" }]),
    "raw"
  );
});

test("extractText handles image and reference types with references map", () => {
  const refs = {
    "img-1": {
      identifier: "img-1",
      type: "image",
      alt: "Screenshot",
      variants: [{ url: "https://example.com/img.png" }],
    },
    "doc://Foo/documentation/Foo/Bar": {
      identifier: "doc://Foo/documentation/Foo/Bar",
      type: "topic",
      title: "Bar",
    },
  };

  assert.equal(
    extractText([{ type: "image", identifier: "img-1" }], refs),
    "![Screenshot](https://example.com/img.png)"
  );
  assert.equal(
    extractText([{ type: "image", identifier: "missing" }], refs),
    "[Image]"
  );
  assert.equal(
    extractText([{ type: "reference", identifier: "doc://Foo/documentation/Foo/Bar" }], refs),
    "Bar"
  );
  assert.equal(
    extractText([{ type: "reference", identifier: "doc://unknown/path/Baz" }], refs),
    "Baz"
  );
});

test("extractOverview handles table with missing cell content (BUG-6)", () => {
  const overview = extractOverview([
    {
      kind: "content",
      content: [
        {
          type: "table",
          header: "row",
          rows: [
            {
              cells: [
                { content: [{ type: "paragraph", inlineContent: [{ type: "text", text: "Header" }] }] },
                {},
              ],
            },
            {
              cells: [
                { content: [{ type: "paragraph", inlineContent: [{ type: "text", text: "Data" }] }] },
                { content: [{ type: "paragraph", inlineContent: [{ type: "text", text: "Val" }] }] },
              ],
            },
          ],
        },
      ],
    },
  ]);

  assert.match(overview, /Header/);
  assert.match(overview, /Data/);
  assert.match(overview, /Val/);
});

test("extractOverview renders DocC 'rows: Cell[][]' tables (TN3191 table-drop bug)", () => {
  // Real DocC render schema: a row IS the array of cells, and each cell is an
  // array of content blocks — not { cells: [{ content }] }. The old converter
  // looked for row.cells (always undefined here) and silently dropped every
  // data row, leaving a header-less "|  |\n| --- |" husk.
  const cell = (text) => [{ type: "paragraph", inlineContent: [{ type: "text", text }] }];
  const overview = extractOverview([
    {
      kind: "content",
      content: [
        {
          type: "table",
          header: "row",
          rows: [
            [cell("RFC"), cell("Capability"), cell("Description")],
            [cell("RFC 3501"), cell("Pipelining"), cell("Enqueues multiple IMAP commands.")],
            [cell("RFC 2177"), cell("IDLE"), cell("Server pushes mailbox updates.")],
          ],
        },
      ],
    },
  ]);

  // Header row and both data rows must survive.
  assert.match(overview, /\| RFC \| Capability \| Description \|/);
  assert.match(overview, /Pipelining/);
  assert.match(overview, /RFC 2177/);
  assert.match(overview, /Server pushes mailbox updates\./);
  // The separator row exists and the table is not an empty husk.
  assert.match(overview, /\| --- \| --- \| --- \|/);
});

test("extractOverview handles links content type (NEW-5)", () => {
  const refs = {
    "doc://link-1": {
      identifier: "doc://link-1",
      type: "topic",
      title: "Getting Started",
      abstract: [{ type: "text", text: "Start here." }],
    },
  };

  const overview = extractOverview(
    [
      {
        kind: "content",
        content: [
          {
            type: "links",
            style: "detailedGrid",
            items: ["doc://link-1"],
          },
        ],
      },
    ],
    refs
  );

  assert.match(overview, /Getting Started/);
  assert.match(overview, /Start here/);
});

test("extractOverview clamps heading levels to 1-6", () => {
  const overview = extractOverview([
    {
      kind: "content",
      content: [
        { type: "heading", level: 0, text: "Zero" },
        { type: "paragraph", inlineContent: [{ type: "text", text: "Content" }] },
        { type: "heading", level: 100, text: "Huge" },
        { type: "paragraph", inlineContent: [{ type: "text", text: "More" }] },
      ],
    },
  ]);

  assert.match(overview, /^# Zero/m);
  assert.match(overview, /^###### Huge/m);
});

test("extractOverview respects recursion depth limit (BUG-2)", () => {
  // Build deeply nested aside structure
  let content = [{ type: "paragraph", inlineContent: [{ type: "text", text: "deep" }] }];
  for (let i = 0; i < 60; i++) {
    content = [{ type: "aside", style: "note", content }];
  }

  // Should not throw stack overflow
  const overview = extractOverview([{ kind: "content", content }]);
  assert.ok(typeof overview === "string");
});

test("formatSearchResultsMarkdown handles zero and populated results", () => {
  assert.match(
    formatSearchResultsMarkdown([], "test", "swiftui"),
    /No results found/
  );

  const results = [
    {
      title: "View",
      path: "swiftui/view",
      webUrl: "https://developer.apple.com/documentation/swiftui/view",
      abstract: "A type that represents UI.",
      kind: "symbol",
      role: "symbol",
    },
  ];
  const md = formatSearchResultsMarkdown(results, "view", "swiftui");
  assert.match(md, /## View/);
  assert.match(md, /swiftui\/view/);
  assert.match(md, /1 result/);
});

test("parseDocPage uses || for empty title fallback (BUG-13)", () => {
  const page = {
    ...createBasePage(),
    metadata: {
      title: "",
      role: "symbol",
      platforms: [],
    },
  };

  const parsed = parseDocPage(page, "testkit");
  // Empty title should fall through to identifier URL or path, not stay empty
  assert.ok(parsed.title.length > 0);
});

// =========================================================================
// Improvement tests: parameters, breadcrumb, deprecation, path in items
// =========================================================================

test("extractParameters returns structured parameter data from primaryContentSections", () => {
  const sections = [
    {
      kind: "parameters",
      parameters: [
        {
          name: "newElement",
          content: [
            {
              type: "paragraph",
              inlineContent: [{ type: "text", text: "The element to append." }],
            },
          ],
        },
        {
          name: "position",
          content: [
            {
              type: "paragraph",
              inlineContent: [{ type: "text", text: "The index." }],
            },
          ],
        },
      ],
    },
  ];

  const params = extractParameters(sections);
  assert.ok(params);
  assert.equal(params.length, 2);
  assert.equal(params[0].name, "newElement");
  assert.equal(params[0].description, "The element to append.");
  assert.equal(params[1].name, "position");
});

test("extractParameters returns undefined when no parameters section exists", () => {
  assert.equal(extractParameters([{ kind: "content", content: [] }]), undefined);
  assert.equal(extractParameters(undefined), undefined);
  assert.equal(extractParameters([{ kind: "parameters", parameters: [] }]), undefined);
});

test("parseDocPage extracts breadcrumb from hierarchy paths", () => {
  const page = {
    ...createBasePage(),
    identifier: {
      url: "doc://com.apple.Swift/documentation/Swift/Array/append(_:)",
      interfaceLanguage: "swift",
    },
    metadata: {
      title: "append(_:)",
      role: "symbol",
      roleHeading: "Instance Method",
      symbolKind: "method",
      modules: [{ name: "Swift" }],
      platforms: [],
    },
    hierarchy: {
      paths: [
        [
          "doc://com.apple.documentation/documentation/technologies",
          "doc://com.apple.Swift/documentation/Swift",
          "doc://com.apple.Swift/documentation/Swift/Array",
        ],
      ],
    },
    references: {
      "doc://com.apple.documentation/documentation/technologies": {
        identifier: "doc://com.apple.documentation/documentation/technologies",
        type: "topic",
        title: "Technologies",
      },
      "doc://com.apple.Swift/documentation/Swift": {
        identifier: "doc://com.apple.Swift/documentation/Swift",
        type: "topic",
        title: "Swift",
      },
      "doc://com.apple.Swift/documentation/Swift/Array": {
        identifier: "doc://com.apple.Swift/documentation/Swift/Array",
        type: "topic",
        title: "Array",
      },
    },
  };

  const parsed = parseDocPage(page, "swift/array/append(_:)");
  assert.ok(parsed.breadcrumb);
  assert.deepEqual(parsed.breadcrumb, ["Swift", "Array"]);
  assert.equal(parsed.roleHeading, "Instance Method");
  assert.equal(parsed.symbolKind, "method");
  assert.equal(parsed.module, "Swift");
});

test("parseDocPage detects deprecation from platform metadata", () => {
  const page = {
    ...createBasePage(),
    metadata: {
      title: "OldAPI",
      role: "symbol",
      platforms: [
        { name: "iOS", deprecated: true, deprecatedAt: "15.0" },
        { name: "macOS", deprecated: true, deprecatedAt: "12.0" },
      ],
    },
  };

  const parsed = parseDocPage(page, "testkit/oldapi");
  assert.equal(parsed.deprecated, true);
  assert.match(parsed.deprecatedAt, /iOS 15\.0/);
  assert.match(parsed.deprecatedAt, /macOS 12\.0/);
});

test("parseDocPage does not mark as deprecated when only some platforms are deprecated", () => {
  const page = {
    ...createBasePage(),
    metadata: {
      title: "PartiallyDeprecated",
      role: "symbol",
      platforms: [
        { name: "iOS", deprecated: true, deprecatedAt: "16.0" },
        { name: "macOS", deprecated: false },
      ],
    },
  };

  const parsed = parseDocPage(page, "testkit/partial");
  assert.equal(parsed.deprecated, undefined);
  assert.ok(parsed.deprecatedAt); // still shows which platforms are deprecated
});

test("parseDocPage topic items have path field usable with apple_docs_get_page", () => {
  const page = {
    ...createBasePage(),
    topicSections: [
      {
        title: "Methods",
        anchor: "methods",
        identifiers: ["doc://method1"],
      },
    ],
    references: {
      "doc://method1": {
        identifier: "doc://method1",
        type: "topic",
        title: "append(_:)",
        role: "symbol",
        kind: "symbol",
        url: "/documentation/swift/array/append(_:)",
        abstract: [{ type: "text", text: "Adds element." }],
      },
    },
  };

  const parsed = parseDocPage(page, "swift/array");
  assert.equal(parsed.topicSections[0].items[0].path, "swift/array/append(_:)");
  // Verify path is directly usable (no /documentation/ prefix, no leading slash)
  assert.ok(!parsed.topicSections[0].items[0].path.startsWith("/"));
  assert.ok(!parsed.topicSections[0].items[0].path.includes("/documentation/"));
});

test("parseDocPage relationship items have path field", () => {
  const page = {
    ...createBasePage(),
    relationshipsSections: [
      {
        kind: "relationships",
        type: "conformsTo",
        title: "Conforms To",
        identifiers: ["doc://proto1"],
      },
    ],
    references: {
      "doc://proto1": {
        identifier: "doc://proto1",
        type: "topic",
        title: "Equatable",
        role: "symbol",
        kind: "symbol",
        url: "/documentation/swift/equatable",
      },
    },
  };

  const parsed = parseDocPage(page, "swift/array");
  assert.equal(parsed.relationships[0].items[0].path, "swift/equatable");
  assert.ok(!parsed.relationships[0].items[0].path.startsWith("/"));
});

test("formatDocPageMarkdown renders parameters section", () => {
  const parsed = {
    title: "append(_:)",
    kind: "symbol",
    role: "symbol",
    roleHeading: "Instance Method",
    module: "Swift",
    abstract: "Adds a new element.",
    declaration: "mutating func append(_ newElement: Element)",
    parameters: [
      { name: "newElement", description: "The element to append to the array." },
    ],
    platforms: [],
    path: "swift/array/append(_:)",
    webUrl: "https://developer.apple.com/documentation/swift/array/append(_:)",
    overview: "",
    topicSections: [],
    relationships: [],
    seeAlsoSections: [],
  };

  const markdown = formatDocPageMarkdown(parsed);
  assert.match(markdown, /## Parameters/);
  assert.match(markdown, /\*\*`newElement`\*\*/);
  assert.match(markdown, /The element to append/);
});

test("formatDocPageMarkdown renders deprecation banner and breadcrumb", () => {
  const parsed = {
    title: "OldView",
    kind: "symbol",
    role: "symbol",
    roleHeading: "Structure",
    module: "SwiftUI",
    abstract: "A deprecated view.",
    deprecated: true,
    deprecatedAt: "iOS 15.0, macOS 12.0",
    breadcrumb: ["SwiftUI"],
    platforms: [
      { name: "iOS", deprecated: true, deprecatedAt: "15.0" },
      { name: "macOS", deprecated: true, deprecatedAt: "12.0" },
    ],
    path: "swiftui/oldview",
    webUrl: "https://developer.apple.com/documentation/swiftui/oldview",
    overview: "",
    topicSections: [],
    relationships: [],
    seeAlsoSections: [],
  };

  const markdown = formatDocPageMarkdown(parsed);
  // Deprecation banner should be at top
  assert.match(markdown, /^> \*\*DEPRECATED\*\*/);
  assert.match(markdown, /iOS 15\.0, macOS 12\.0/);
  // Breadcrumb
  assert.match(markdown, /SwiftUI > OldView/);
  // Role heading instead of raw kind/role
  assert.match(markdown, /Structure/);
  assert.match(markdown, /Module: SwiftUI/);
  // Platform deprecation info
  assert.match(markdown, /deprecated 15\.0/);
});

// =========================================================================
// Stress test fixes: doc:// URI handling in search and collection
// =========================================================================

test("searchReferencesInPage matches references with doc:// URIs (STRESS-1)", () => {
  const results = searchReferencesInPage(
    {
      ...createBasePage(),
      references: {
        "doc://com.apple.SwiftUI/documentation/SwiftUI/View": {
          identifier: "doc://com.apple.SwiftUI/documentation/SwiftUI/View",
          type: "topic",
          title: "View",
          role: "symbol",
          kind: "symbol",
          url: "doc://com.apple.SwiftUI/documentation/SwiftUI/View",
          abstract: [{ type: "text", text: "A type that represents UI." }],
        },
        "doc://com.apple.SwiftUI/documentation/SwiftUI/Text": {
          identifier: "doc://com.apple.SwiftUI/documentation/SwiftUI/Text",
          type: "topic",
          title: "Text",
          role: "symbol",
          kind: "symbol",
          url: "doc://com.apple.SwiftUI/documentation/SwiftUI/Text",
          abstract: [{ type: "text", text: "Displays text." }],
        },
        "doc://com.apple.UIKit/documentation/UIKit/UIView": {
          identifier: "doc://com.apple.UIKit/documentation/UIKit/UIView",
          type: "topic",
          title: "UIView",
          role: "symbol",
          kind: "symbol",
          url: "doc://com.apple.UIKit/documentation/UIKit/UIView",
          abstract: [{ type: "text", text: "UIKit view." }],
        },
      },
    },
    "View",
    "swiftui"
  );

  // Should find the SwiftUI View but not UIKit UIView
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "View");
  assert.equal(results[0].path, "swiftui/view");
});

test("normalizePath rejects zero-width Unicode characters (STRESS-3)", () => {
  assert.throws(() => normalizePath("swift\u200Bui"), /invisible Unicode/);
  assert.throws(() => normalizePath("swift\uFEFFui"), /invisible Unicode/);
  assert.throws(() => normalizePath("swift\u200Dui"), /invisible Unicode/);
});

test("normalizePath rejects encoded control characters after decoding (STRESS-4)", () => {
  assert.throws(() => normalizePath("swift%00ui"), /control characters/);
  assert.throws(() => normalizePath("swift%0Aui"), /control characters/);
});

test("normalizePath rejects SSRF subdomain bypass (SEC-011)", () => {
  assert.throws(
    () => normalizePath("https://developer.apple.com.evil.com/documentation/swiftui"),
    /only developer\.apple\.com/
  );
  assert.throws(
    () => normalizePath("https://developer.apple.comevil.com/documentation/swiftui"),
    /only developer\.apple\.com/
  );
  // Valid Apple URL should still work
  assert.equal(normalizePath("https://developer.apple.com/documentation/swiftui"), "swiftui");
});

test("parseDocPage handles missing identifiers in relationshipsSections gracefully", () => {
  const page = {
    ...createBasePage(),
    relationshipsSections: [
      {
        kind: "relationships",
        type: "conformsTo",
        title: "Conforms To",
        // identifiers is missing/undefined
      },
    ],
  };

  const parsed = parseDocPage(page, "testkit");
  assert.ok(parsed.relationships);
  assert.equal(parsed.relationships.length, 1);
  assert.equal(parsed.relationships[0].title, "Conforms To");
  assert.deepEqual(parsed.relationships[0].items, []);
});

// =========================================================================
// Stress test round 2: overloaded symbol resolution, deprecation messages
// =========================================================================

test("resolveChildPathFromParentPage picks the shortest path when multiple overloads match by title (STRESS-5)", () => {
  // Note: Apple's reference data doesn't carry per-candidate deprecation info
  // at this level (verified against the live swift/array.json — neither
  // flatMap(_:) overload's own page reports deprecated:true), so there's no
  // reliable signal to disambiguate "the deprecated one" here. This test
  // exercises the length-based tie-break fallback, not deprecation-awareness.
  const parentPage = {
    ...createBasePage(),
    identifier: {
      url: "/documentation/swift/array",
      interfaceLanguage: "swift",
    },
    metadata: {
      title: "Array",
      role: "symbol",
      platforms: [],
    },
    references: {
      "doc://flatmap-long-suffix": {
        identifier: "doc://flatmap-long-suffix",
        type: "topic",
        title: "flatMap(_:)",
        role: "symbol",
        kind: "symbol",
        url: "/documentation/swift/array/flatmap(_:)-6chu8",
      },
      "doc://flatmap-short-suffix": {
        identifier: "doc://flatmap-short-suffix",
        type: "topic",
        title: "flatMap(_:)",
        role: "symbol",
        kind: "symbol",
        url: "/documentation/swift/array/flatmap(_:)-i3mr",
      },
    },
  };

  const resolved = resolveChildPathFromParentPage(parentPage, "swift/array", "flatmap(_:)");
  assert.ok(resolved);
  // Should prefer the shorter path (no long hash suffix) when multiple title matches exist
  assert.equal(resolved, "swift/array/flatmap(_:)-i3mr");
});

test("resolveChildPathFromParentPage picks exact leaf when available among multiple title matches (STRESS-6)", () => {
  const parentPage = {
    ...createBasePage(),
    identifier: {
      url: "/documentation/swift/array",
      interfaceLanguage: "swift",
    },
    metadata: {
      title: "Array",
      role: "symbol",
      platforms: [],
    },
    references: {
      "doc://contains-hash": {
        identifier: "doc://contains-hash",
        type: "topic",
        title: "contains(_:)",
        role: "symbol",
        kind: "symbol",
        url: "/documentation/swift/array/contains(_:)-abc1",
      },
      "doc://contains-exact": {
        identifier: "doc://contains-exact",
        type: "topic",
        title: "contains(_:)",
        role: "symbol",
        kind: "symbol",
        url: "/documentation/swift/array/contains(_:)",
      },
    },
  };

  const resolved = resolveChildPathFromParentPage(parentPage, "swift/array", "contains(_:)");
  // Should prefer the exact leaf match (no hash suffix)
  assert.equal(resolved, "swift/array/contains(_:)");
});

test("parseDocPage extracts deprecation message and renamed info (STRESS-7)", () => {
  const page = {
    ...createBasePage(),
    metadata: {
      title: "flatMap(_:)",
      role: "symbol",
      platforms: [
        { name: "iOS", introducedAt: "8.0", deprecated: false, unavailable: false },
        {
          name: "Swift",
          deprecatedAt: "4.1",
          deprecated: false,
          renamed: "compactMap(_:)",
          message: "Please use compactMap(_:) for the case where closure returns an optional value",
        },
      ],
    },
  };

  const parsed = parseDocPage(page, "swift/array/flatmap(_:)");
  assert.equal(parsed.deprecatedAt, "Swift 4.1");
  assert.ok(parsed.deprecationMessage);
  assert.match(parsed.deprecationMessage, /compactMap/);
});

test("safeTruncate-like behavior: clampJsonResponse handles content safely", () => {
  // This is a basic sanity check — full truncation correctness tested via formatDocPageMarkdown
  const parsed = {
    title: "Test",
    kind: "symbol",
    role: "symbol",
    abstract: "A".repeat(30000),
    platforms: [],
    path: "test",
    webUrl: "https://developer.apple.com/documentation/test",
    overview: "",
    topicSections: [],
    relationships: [],
    seeAlsoSections: [],
  };

  const markdown = formatDocPageMarkdown(parsed);
  assert.ok(markdown.length > 0);
  assert.match(markdown, /# Test/);
});

// =========================================================================
// flattenFrameworkIndexNodes: navigator-index tree flattening
// =========================================================================

test("flattenFrameworkIndexNodes recurses into children and normalizes paths", () => {
  const tree = [
    {
      title: "AVCaptureSession",
      path: "/documentation/AVFoundation/AVCaptureSession",
      type: "class",
      children: [
        {
          title: "var automaticallyRunsDeferredStart: Bool",
          path: "/documentation/AVFoundation/AVCaptureSession/automaticallyRunsDeferredStart",
          type: "property",
        },
      ],
    },
  ];

  const flattened = flattenFrameworkIndexNodes(tree);
  assert.equal(flattened.length, 2);
  assert.equal(flattened[0].path, "avfoundation/avcapturesession");
  assert.equal(flattened[1].path, "avfoundation/avcapturesession/automaticallyrunsdeferredstart");
  assert.equal(flattened[1].type, "property");
});

test("flattenFrameworkIndexNodes skips group markers (no path) and external links", () => {
  const tree = [
    {
      title: "Capture",
      type: "groupMarker",
      children: [
        {
          title: "AVCaptureDevice",
          path: "/documentation/AVFoundation/AVCaptureDevice",
          type: "class",
        },
      ],
    },
    {
      title: "External guide",
      path: "https://example.com/guide",
      type: "article",
      external: true,
    },
  ];

  const flattened = flattenFrameworkIndexNodes(tree);
  assert.equal(flattened.length, 1);
  assert.equal(flattened[0].path, "avfoundation/avcapturedevice");
});

test("flattenFrameworkIndexNodes falls back to the normalized path when title is missing", () => {
  const tree = [{ path: "/documentation/Foundation/URLSession", type: "class" }];
  const flattened = flattenFrameworkIndexNodes(tree);
  assert.equal(flattened.length, 1);
  assert.equal(flattened[0].title, "foundation/urlsession");
});

// =========================================================================
// formatSearchResultsMarkdown: partial-failure warning messaging
// =========================================================================

test("formatSearchResultsMarkdown treats an index-fetch-failure warning as inconclusive, not a definitive empty result", () => {
  const warningOnly = [
    {
      title: "⚠ Partial results",
      path: "",
      webUrl: "",
      abstract: "Could not load the full symbol index for \"avfoundation\" — try again.",
      kind: "warning",
      role: "warning",
    },
  ];

  const markdown = formatSearchResultsMarkdown(warningOnly, "deferred", "avfoundation");
  assert.match(markdown, /No results found/);
  assert.match(markdown, /Could not load the full symbol index/);
  // Should NOT claim this is evidence the symbol doesn't exist — the search was incomplete
  assert.doesNotMatch(markdown, /good evidence the symbol doesn't exist/);
});

// =========================================================================
// 404 suggestion engine: boundedEditDistance, resolveFromIndexSymbols,
// parseGlobalSearchResponse
// =========================================================================

test("boundedEditDistance computes small distances and bails past the bound", () => {
  assert.equal(boundedEditDistance("relevance()", "relevance()", 2), 0);
  assert.equal(boundedEditDistance("relevances()", "relevance()", 2), 1);
  assert.equal(boundedEditDistance("kitten", "sitting", 2), 3); // real distance 3 → max+1
  assert.equal(boundedEditDistance("short", "muchlongerstring", 2), 3); // length gap fast path
});

test("resolveFromIndexSymbols lists every overload of a bare member name with declarations", () => {
  const symbols = [
    { title: "func result(value: V) -> Self", path: "appintents/intentresultcontainer/result(value:)-8x1q2", type: "method" },
    { title: "func result() -> Self", path: "appintents/intentresultcontainer/result()-3k9f", type: "method" },
    { title: "func result(dialog: IntentDialog) -> Self", path: "appintents/intentresultcontainer/result(dialog:)", type: "method" },
    { title: "SomethingElse", path: "appintents/somethingelse", type: "struct" },
  ];

  const resolution = resolveFromIndexSymbols("appintents/intentresultcontainer/result", symbols);
  assert.equal(resolution.autoResolvePath, undefined); // multiple overloads → never auto-resolve
  assert.equal(resolution.suggestions.length, 3);
  assert.ok(resolution.suggestions.every((s) => s.path.includes("/result(") || s.path.includes("/result()")));
  assert.ok(resolution.suggestions.some((s) => s.title.includes("dialog:")));
});

test("resolveFromIndexSymbols auto-resolves a bare name with exactly one overload", () => {
  const symbols = [
    { title: "func onAppear(perform: (() -> Void)?) -> some View", path: "swiftui/view/onappear(perform:)", type: "method" },
  ];
  const resolution = resolveFromIndexSymbols("swiftui/view/onappear", symbols);
  assert.equal(resolution.autoResolvePath, "swiftui/view/onappear(perform:)");
});

test("resolveFromIndexSymbols auto-resolves renamed types via punctuation-insensitive title match", () => {
  const symbols = [
    { title: "CKShare.Metadata", path: "cloudkit/ckshare/metadata", type: "class" },
    { title: "CKShare", path: "cloudkit/ckshare", type: "class" },
  ];
  const resolution = resolveFromIndexSymbols("cloudkit/cksharemetadata", symbols);
  assert.equal(resolution.autoResolvePath, "cloudkit/ckshare/metadata");
  assert.equal(resolution.suggestions[0].title, "CKShare.Metadata");
});

test("resolveFromIndexSymbols suggests but never auto-resolves typo matches", () => {
  const symbols = [
    { title: "func relevance() async -> WidgetRelevance<Self.Intent>", path: "widgetkit/appintenttimelineprovider/relevance()", type: "method" },
    { title: "func placeholder(in: Context) -> Entry", path: "widgetkit/appintenttimelineprovider/placeholder(in:)", type: "method" },
  ];
  const resolution = resolveFromIndexSymbols("widgetkit/appintenttimelineprovider/relevances()", symbols);
  assert.equal(resolution.autoResolvePath, undefined);
  assert.equal(resolution.suggestions.length, 1);
  assert.equal(resolution.suggestions[0].path, "widgetkit/appintenttimelineprovider/relevance()");
});

test("resolveFromIndexSymbols auto-resolves an exact symbol name found at one other spot in the framework", () => {
  const symbols = [
    { title: "TimelineEntryRelevance", path: "widgetkit/timelineentryrelevance", type: "struct" },
  ];
  const resolution = resolveFromIndexSymbols("widgetkit/timelineentry/timelineentryrelevance", symbols);
  assert.equal(resolution.autoResolvePath, "widgetkit/timelineentryrelevance");
});

test("parseGlobalSearchResponse validates permalinks, dedupes, and extracts framework names", () => {
  const data = {
    results: [
      {
        documentation: {
          metadata: {
            title: "RelevantContext",
            permalink: "https://developer.apple.com/documentation/relevancekit/relevantcontext",
            hierarchy: "RelevanceKit > RelevantContext",
            description: "Contextual clues.",
            availability: "iOS 17.0+",
          },
        },
      },
      {
        documentation: {
          metadata: {
            title: "Duplicate",
            permalink: "https://developer.apple.com/documentation/relevancekit/relevantcontext",
          },
        },
      },
      {
        documentation: {
          metadata: {
            title: "Evil",
            permalink: "https://evil.example.com/documentation/relevancekit/relevantcontext",
          },
        },
      },
      { notDocumentation: {} },
    ],
  };

  const results = parseGlobalSearchResponse(data, 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].path, "relevancekit/relevantcontext");
  assert.equal(results[0].framework, "RelevanceKit");
  assert.equal(results[0].availability, "iOS 17.0+");
  assert.equal(results[0].webUrl, "https://developer.apple.com/documentation/relevancekit/relevantcontext");

  assert.deepEqual(parseGlobalSearchResponse(null, 5), []);
  assert.deepEqual(parseGlobalSearchResponse({ error: { message: "nope" } }, 5), []);
});

test("formatTechnologiesMarkdown compact mode drops abstracts but keeps every framework", () => {
  const parsed = {
    sections: [
      {
        title: "App Services",
        technologies: [
          { title: "RelevanceKit", url: "/documentation/relevancekit", abstract: "Provide relevance clues.", role: "collection" },
          { title: "WidgetKit", url: "/documentation/widgetkit", abstract: "Extend apps with widgets.", role: "collection" },
        ],
      },
    ],
  };

  const full = formatTechnologiesMarkdown(parsed);
  assert.match(full, /Provide relevance clues/);

  const compact = formatTechnologiesMarkdown(parsed, { compact: true });
  assert.doesNotMatch(compact, /Provide relevance clues/);
  assert.match(compact, /\*\*RelevanceKit\*\* \(`relevancekit`\)/);
  assert.match(compact, /\*\*WidgetKit\*\* \(`widgetkit`\)/);
  assert.match(compact, /Descriptions omitted/);
});

test("formatGlobalSearchResultsMarkdown renders results and a helpful empty state", () => {
  const markdown = formatGlobalSearchResultsMarkdown(
    [
      {
        title: "RelevantContext",
        path: "relevancekit/relevantcontext",
        webUrl: "https://developer.apple.com/documentation/relevancekit/relevantcontext",
        framework: "RelevanceKit",
        description: "Contextual clues.",
        availability: "iOS 17.0+",
      },
    ],
    "RelevantContext"
  );
  assert.match(markdown, /\*\*Framework\*\*: RelevanceKit/);
  assert.match(markdown, /`relevancekit\/relevantcontext`/);

  const empty = formatGlobalSearchResultsMarkdown([], "nonexistent");
  assert.match(empty, /No results found/);
  assert.match(empty, /apple_docs_search/);
});
