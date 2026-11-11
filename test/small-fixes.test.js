import test from "node:test";
import assert from "node:assert/strict";

import {
  extractParameters,
  fillMissingAbstracts,
  formatDocPageMarkdown,
  formatSearchResultsMarkdown,
  mergeFrameworkIndexSymbols,
  parseDocPage,
  searchIndexSymbols,
} from "../dist/services/apple-docs.js";
import { formatWwdcSessionMarkdown } from "../dist/services/wwdc.js";

const paragraph = (text) => ({ type: "paragraph", inlineContent: [{ type: "text", text }] });

function symbol(overrides = {}) {
  return {
    title: "Thing",
    kind: "symbol",
    role: "symbol",
    abstract: "",
    platforms: [],
    path: "testkit/thing",
    webUrl: "https://developer.apple.com/documentation/testkit/thing",
    topicSections: [],
    relationships: [],
    seeAlsoSections: [],
    overview: "",
    ...overrides,
  };
}

const items = (count, prefix) =>
  Array.from({ length: count }, (_, i) => ({ title: `${prefix} ${i}`, path: `testkit/${prefix.toLowerCase()}-${i}`, abstract: "", kind: "symbol", role: "symbol" }));

// ---------------------------------------------------------------------------
// Capped lists say how to reach the items they leave out
// ---------------------------------------------------------------------------

test("a topic section cut at twenty items says how to get the rest", () => {
  const markdown = formatDocPageMarkdown(symbol({ topicSections: [{ title: "Methods", items: items(25, "Method") }] }));

  assert.match(markdown, /- \*\*Method 19\*\*/);
  assert.doesNotMatch(markdown, /- \*\*Method 20\*\*/);
  assert.match(
    markdown,
    /- \*\(5 more items — request response_format "json" for the full list, or use apple_docs_search to find one\)\*/
  );
});

test("relationship and see-also lists that are cut say how to get the rest too", () => {
  const markdown = formatDocPageMarkdown(
    symbol({
      relationships: [{ title: "Conforming Types", type: "conformingTypes", items: items(18, "Type") }],
      seeAlsoSections: [{ title: "Related", items: items(23, "Related") }],
    })
  );

  assert.match(markdown, /- \*\(3 more — request response_format "json" for the full list\)\*/);
  assert.match(markdown, /- \*\(3 more items — request response_format "json" for the full list, or use apple_docs_search to find one\)\*/);
});

// ---------------------------------------------------------------------------
// Parameter descriptions keep everything in them, not just plain paragraphs
// ---------------------------------------------------------------------------

test("a parameter description keeps its lists and code, not only its paragraphs", () => {
  const parameters = extractParameters([
    {
      kind: "parameters",
      parameters: [
        {
          name: "mode",
          content: [
            paragraph("How to combine the values."),
            {
              type: "unorderedList",
              items: [{ content: [paragraph("union: keep both")] }, { content: [paragraph("replace: keep the new one")] }],
            },
          ],
        },
        { name: "plain", content: [paragraph("One sentence.")] },
      ],
    },
  ]);

  assert.deepEqual(parameters, [
    { name: "mode", description: "How to combine the values.\n- union: keep both\n- replace: keep the new one" },
    { name: "plain", description: "One sentence." },
  ]);
});

test("a multi-line parameter description is indented under its parameter", () => {
  const markdown = formatDocPageMarkdown(
    symbol({ parameters: [{ name: "mode", description: "How to combine the values.\n- union: keep both\n- replace: keep the new one" }] })
  );

  assert.match(markdown, /- \*\*`mode`\*\* — How to combine the values\.\n  - union: keep both\n  - replace: keep the new one\n/);
});

// ---------------------------------------------------------------------------
// WWDC code samples are not all Swift
// ---------------------------------------------------------------------------

test("WWDC code samples are not labelled as Swift, since many are shell commands or other languages", () => {
  const markdown = formatWwdcSessionMarkdown({
    year: "2024",
    id: "10136",
    url: "https://developer.apple.com/videos/play/wwdc2024/10136/",
    webUrl: "https://developer.apple.com/videos/play/wwdc2024/10136/",
    title: "What’s new in Swift",
    description: "",
    chapters: [],
    transcript: "",
    sampleCode: [
      { title: "Swift Build", time: "9:15", code: "swift build" },
      { title: "C++ Interoperability", time: "22:29", code: "struct Person {\n  Person(const Person&) = delete;\n};" },
    ],
    resources: [],
    relatedVideos: [],
  });

  assert.match(markdown, /### `9:15` Swift Build\n```\nswift build\n```/);
  assert.doesNotMatch(markdown, /```swift/);
});

// ---------------------------------------------------------------------------
// Sample code pages link to their download
// ---------------------------------------------------------------------------

function sampleCodePage(download) {
  return {
    identifier: { url: "doc://com.apple.SwiftUI/documentation/SwiftUI/food-truck", interfaceLanguage: "swift" },
    kind: "article",
    metadata: { title: "Food Truck", role: "sampleCode", platforms: [] },
    abstract: [{ type: "text", text: "Create a single codebase and app target." }],
    primaryContentSections: [],
    topicSections: [],
    seeAlsoSections: [],
    relationshipsSections: [],
    sampleCodeDownload: { action: { identifier: "1796469ec876/FoodTruck.zip", isActive: true, overridingTitle: "Download", type: "reference" }, kind: "sampleDownload" },
    references: { "1796469ec876/FoodTruck.zip": { identifier: "1796469ec876/FoodTruck.zip", type: "download", ...download } },
  };
}

test("a sample code page gives the full URL of its download", () => {
  const parsed = parseDocPage(sampleCodePage({ url: "1796469ec876/FoodTruck.zip" }), "swiftui/food-truck");

  assert.equal(parsed.sampleCodeDownloadUrl, "https://docs-assets.developer.apple.com/published/1796469ec876/FoodTruck.zip");
  assert.match(
    formatDocPageMarkdown(parsed),
    /\*\*Sample code\*\*: \[Download\]\(https:\/\/docs-assets\.developer\.apple\.com\/published\/1796469ec876\/FoodTruck\.zip\)\n/
  );
});

test("a download that is already a full https URL is used as is, and anything else is left out", () => {
  const absolute = parseDocPage(sampleCodePage({ url: "https://developer.apple.com/sample-code/wwdc/FoodTruck.zip" }), "swiftui/food-truck");
  assert.equal(absolute.sampleCodeDownloadUrl, "https://developer.apple.com/sample-code/wwdc/FoodTruck.zip");

  const unsafe = parseDocPage(sampleCodePage({ url: "javascript:alert(1)" }), "swiftui/food-truck");
  assert.equal("sampleCodeDownloadUrl" in unsafe, false);

  const ordinary = parseDocPage({ ...sampleCodePage({}), sampleCodeDownload: undefined }, "swiftui/food-truck");
  assert.equal("sampleCodeDownloadUrl" in ordinary, false);
});

// ---------------------------------------------------------------------------
// Search results: beta and deprecated marks, and descriptions for the top hits
// ---------------------------------------------------------------------------

const FLAGGED_INDEX = {
  swift: [
    { title: "NewThing", path: "/documentation/testkit/newthing", type: "class", beta: true },
    { title: "OldThing", path: "/documentation/testkit/oldthing", type: "class", deprecated: true },
    { title: "PlainThing", path: "/documentation/testkit/plainthing", type: "class" },
  ],
  objc: [],
};

test("search results carry the beta and deprecated marks from the symbol index", () => {
  const results = searchIndexSymbols(mergeFrameworkIndexSymbols(FLAGGED_INDEX), "thing", "testkit");

  assert.deepEqual(
    results.map((r) => [r.title, r.beta, r.deprecated]),
    [
      ["NewThing", true, undefined],
      ["OldThing", undefined, true],
      ["PlainThing", undefined, undefined],
    ]
  );
});

test("formatSearchResultsMarkdown shows a result's beta or deprecated status", () => {
  const results = searchIndexSymbols(mergeFrameworkIndexSymbols(FLAGGED_INDEX), "thing", "testkit");
  const markdown = formatSearchResultsMarkdown(results, "thing", "testkit");

  assert.match(markdown, /## NewThing\n\*\*Status\*\*: Beta\n/);
  assert.match(markdown, /## OldThing\n\*\*Status\*\*: Deprecated\n/);
  assert.doesNotMatch(markdown, /## PlainThing\n\*\*Status\*\*/);
});

test("fillMissingAbstracts looks up descriptions for the leading results that lack one", async () => {
  const result = (title, abstract = "") => ({ title, path: `testkit/${title.toLowerCase()}`, webUrl: "", abstract, kind: "class", role: "class" });
  const results = [result("A"), result("B", "Already described."), result("C"), result("D"), result("E")];
  const asked = [];
  const lookUp = async (path) => {
    asked.push(path);
    if (path === "testkit/c") throw new Error("temporary failure");
    return `About ${path}.`;
  };

  const filled = await fillMissingAbstracts(results, lookUp, 3);

  // Only the first three without a description are looked up; a failed lookup
  // leaves that result as it was rather than failing the search.
  assert.deepEqual(asked.sort(), ["testkit/a", "testkit/c", "testkit/d"]);
  assert.deepEqual(
    filled.map((r) => r.abstract),
    ["About testkit/a.", "Already described.", "", "About testkit/d.", ""]
  );
});
