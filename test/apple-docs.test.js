import test from "node:test";
import assert from "node:assert/strict";

import {
  collectSearchPagePaths,
  collectDirectMatchPaths,
  dedupeSearchResults,
  extractOverview,
  formatDocPageMarkdown,
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

test("normalizePath rejects traversal and empty normalized paths", () => {
  assert.throws(() => normalizePath("%2e%2e/secret"), /path traversal/);
  assert.throws(() => normalizePath(" /documentation/ "), /no documentation path remained/);
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

test("collectSearchPagePaths stays in-framework, dedupes, and respects its crawl cap", () => {
  const references = {};
  for (let index = 0; index < 30; index += 1) {
    references[`doc://child/${index}`] = {
      identifier: `doc://child/${index}`,
      type: "topic",
      title: `Child ${index}`,
      role: "collectionGroup",
      kind: "article",
      url: `/documentation/foundation/child-${index}`,
    };
  }
  references["doc://dup"] = {
    identifier: "doc://dup",
    type: "topic",
    title: "Duplicate",
    role: "collectionGroup",
    kind: "article",
    url: "/documentation/foundation/child-0",
  };
  references["doc://other-framework"] = {
    identifier: "doc://other-framework",
    type: "topic",
    title: "Other",
    role: "collectionGroup",
    kind: "article",
    url: "/documentation/uikit/not-allowed",
  };

  const paths = collectSearchPagePaths(
    {
      ...createBasePage(),
      references,
    },
    "foundation"
  );

  assert.equal(paths.length, 30);
  assert.equal(paths[0], "foundation/child-0");
  assert.equal(paths.includes("uikit/not-allowed"), false);
});

test("collectDirectMatchPaths surfaces query-matching symbols and heuristic exact paths", () => {
  const paths = collectDirectMatchPaths(
    {
      ...createBasePage(),
      identifier: {
        url: "/documentation/swiftui",
        interfaceLanguage: "swift",
      },
      metadata: {
        title: "SwiftUI",
        role: "collection",
        platforms: [],
      },
      references: {
        "doc://animation": {
          identifier: "doc://animation",
          type: "topic",
          title: "Animation",
          role: "symbol",
          kind: "symbol",
          url: "/documentation/swiftui/animation",
          abstract: [{ type: "text", text: "Animate state transitions." }],
        },
      },
    },
    "swiftui",
    "animatable"
  );

  assert.equal(paths.includes("swiftui/animatable"), true);
  assert.equal(paths.includes("swiftui/animation"), false);

  const animationPaths = collectDirectMatchPaths(
    {
      ...createBasePage(),
      identifier: {
        url: "/documentation/swiftui",
        interfaceLanguage: "swift",
      },
      metadata: {
        title: "SwiftUI",
        role: "collection",
        platforms: [],
      },
      references: {
        "doc://animation": {
          identifier: "doc://animation",
          type: "topic",
          title: "Animation",
          role: "symbol",
          kind: "symbol",
          url: "/documentation/swiftui/animation",
          abstract: [{ type: "text", text: "Animate state transitions." }],
        },
      },
    },
    "swiftui",
    "animation"
  );

  assert.equal(animationPaths.includes("swiftui/animation"), true);
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
          url: `/documentation/topic-${index}`,
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
          url: `/documentation/rel-${index}`,
        })),
      },
    ],
    seeAlsoSections: [
      {
        title: "See also",
        items: Array.from({ length: 22 }, (_, index) => ({
          title: `See ${index}`,
          url: `/documentation/see-${index}`,
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
