import test from "node:test";
import assert from "node:assert/strict";

import {
  applyJsonPatch,
  formatDocPageMarkdown,
  formatSearchResultsMarkdown,
  mergeFrameworkIndexSymbols,
  parseDocPage,
  resolveFromIndexSymbols,
  searchIndexSymbols,
  selectLanguageVariant,
} from "../dist/services/apple-docs.js";

// ---------------------------------------------------------------------------
// The symbol index has one tree per language. Most symbols share a path and
// differ only in name (Swift "func draw(CGRect)" is Objective-C "- drawRect:");
// some exist only in the Objective-C tree.
// ---------------------------------------------------------------------------

const INDEX = {
  swift: [
    {
      title: "UIView",
      path: "/documentation/uikit/uiview",
      type: "class",
      children: [
        { title: "func draw(CGRect)", path: "/documentation/uikit/uiview/draw(_:)", type: "method" },
        { title: "var alpha: CGFloat", path: "/documentation/uikit/uiview/alpha", type: "property" },
      ],
    },
  ],
  objc: [
    {
      title: "UIView",
      path: "/documentation/uikit/uiview",
      type: "class",
      children: [
        { title: "- drawRect:", path: "/documentation/uikit/uiview/draw(_:)", type: "method" },
        { title: "alpha", path: "/documentation/uikit/uiview/alpha", type: "property" },
        { title: "+ requestWithRole:", path: "/documentation/uikit/uiscenesessionactivationrequest-c.class/requestwithrole:", type: "method" },
      ],
    },
  ],
};

test("mergeFrameworkIndexSymbols records each symbol's Objective-C name and adds Objective-C-only symbols", () => {
  assert.deepEqual(mergeFrameworkIndexSymbols(INDEX), [
    // Same name in both languages: nothing extra to record.
    { title: "UIView", path: "uikit/uiview", type: "class" },
    { title: "func draw(CGRect)", path: "uikit/uiview/draw(_:)", type: "method", objcTitle: "- drawRect:" },
    { title: "var alpha: CGFloat", path: "uikit/uiview/alpha", type: "property", objcTitle: "alpha" },
    // Not in the Swift tree at all.
    { title: "+ requestWithRole:", path: "uikit/uiscenesessionactivationrequest-c.class/requestwithrole:", type: "method" },
  ]);
});

test("mergeFrameworkIndexSymbols uses the Objective-C tree alone when there is no Swift tree", () => {
  assert.deepEqual(mergeFrameworkIndexSymbols({ swift: [], objc: INDEX.objc }).map((s) => s.title), [
    "UIView",
    "- drawRect:",
    "alpha",
    "+ requestWithRole:",
  ]);
});

test("searchIndexSymbols finds a symbol by its Objective-C name and says which name matched", () => {
  const symbols = mergeFrameworkIndexSymbols(INDEX);

  const byObjcName = searchIndexSymbols(symbols, "drawRect", "uikit");
  assert.deepEqual(byObjcName.map((r) => [r.path, r.title, r.objcTitle]), [
    ["uikit/uiview/draw(_:)", "func draw(CGRect)", "- drawRect:"],
  ]);

  // Found by its Swift name: the Objective-C name is not why it matched, so it is left out.
  const bySwiftName = searchIndexSymbols(symbols, "draw(CGRect)", "uikit");
  assert.deepEqual(bySwiftName.map((r) => [r.path, r.objcTitle]), [["uikit/uiview/draw(_:)", undefined]]);

  // A symbol that exists only in Objective-C.
  assert.deepEqual(searchIndexSymbols(symbols, "requestWithRole", "uikit").map((r) => r.path), [
    "uikit/uiscenesessionactivationrequest-c.class/requestwithrole:",
  ]);
});

test("searchIndexSymbols stays inside the requested framework scope", () => {
  const symbols = mergeFrameworkIndexSymbols(INDEX);

  assert.deepEqual(searchIndexSymbols(symbols, "alpha", "uikit/uiview").map((r) => r.path), ["uikit/uiview/alpha"]);
  assert.deepEqual(searchIndexSymbols(symbols, "alpha", "uikit/uilabel"), []);
});

test("formatSearchResultsMarkdown shows the Objective-C name that a result was found by", () => {
  const markdown = formatSearchResultsMarkdown(
    [
      {
        title: "func draw(CGRect)",
        path: "uikit/uiview/draw(_:)",
        webUrl: "https://developer.apple.com/documentation/uikit/uiview/draw(_:)",
        abstract: "",
        kind: "method",
        role: "method",
        objcTitle: "- drawRect:",
      },
    ],
    "drawRect",
    "uikit"
  );

  assert.match(markdown, /## func draw\(CGRect\)\n\*\*Objective-C name\*\*: `- drawRect:`\n/);
});

test("resolveFromIndexSymbols resolves an Objective-C selector to the page it shares with the Swift method", () => {
  const symbols = mergeFrameworkIndexSymbols(INDEX);

  // There is no page at .../drawrect: — the selector is documented at draw(_:).
  const resolution = resolveFromIndexSymbols("uikit/uiview/drawrect:", symbols);
  assert.equal(resolution.autoResolvePath, "uikit/uiview/draw(_:)");
});

// ---------------------------------------------------------------------------
// A page's Objective-C rendition is a JSON Patch applied to the Swift page.
// ---------------------------------------------------------------------------

test("applyJsonPatch applies replace, add, and remove without changing its input", () => {
  const original = { metadata: { title: "addSubview(_:)", role: "symbol" }, sections: [{ kind: "a" }, { kind: "b" }], "a/b": 1 };
  const snapshot = structuredClone(original);

  const patched = applyJsonPatch(original, [
    { op: "replace", path: "/metadata/title", value: "addSubview:" },
    { op: "replace", path: "/sections/1", value: { kind: "c" } },
    { op: "add", path: "/sections/-", value: { kind: "d" } },
    { op: "add", path: "/topicSections", value: null },
    { op: "remove", path: "/metadata/role" },
    // "~1" is an escaped "/" inside a key, as in /references/doc:~1~1com.apple...
    { op: "replace", path: "/a~1b", value: 2 },
  ]);

  assert.deepEqual(patched, {
    metadata: { title: "addSubview:" },
    sections: [{ kind: "a" }, { kind: "c" }, { kind: "d" }],
    "a/b": 2,
    topicSections: null,
  });
  assert.deepEqual(original, snapshot);
});

function swiftPageWithObjcVariant() {
  return {
    identifier: { url: "doc://com.apple.uikit/documentation/UIKit/UIView/addSubview(_:)", interfaceLanguage: "swift" },
    kind: "symbol",
    metadata: { title: "addSubview(_:)", role: "symbol", roleHeading: "Instance Method", platforms: [] },
    abstract: [{ type: "text", text: "Adds a view to the end of the receiver’s list of subviews." }],
    primaryContentSections: [
      { kind: "declarations", declarations: [{ languages: ["swift"], platforms: ["iOS"], tokens: [{ kind: "text", text: "func addSubview(_ view: UIView)" }] }] },
    ],
    topicSections: [],
    seeAlsoSections: [],
    relationshipsSections: [],
    references: {},
    variantOverrides: [
      {
        traits: [{ interfaceLanguage: "occ" }],
        patch: [
          { op: "replace", path: "/identifier/interfaceLanguage", value: "occ" },
          { op: "replace", path: "/metadata/title", value: "addSubview:" },
          {
            op: "replace",
            path: "/primaryContentSections/0",
            value: { kind: "declarations", declarations: [{ languages: ["occ"], platforms: ["iOS"], tokens: [{ kind: "text", text: "- (void)addSubview:(UIView *)view;" }] }] },
          },
        ],
      },
    ],
  };
}

test("selectLanguageVariant produces the Objective-C rendition of a page that has one", () => {
  const page = swiftPageWithObjcVariant();

  const objc = selectLanguageVariant(page, "objc");
  assert.equal(objc.available, true);
  const parsed = parseDocPage(objc.page, "uikit/uiview/addsubview(_:)");
  assert.equal(parsed.title, "addSubview:");
  assert.equal(parsed.declaration, "- (void)addSubview:(UIView *)view;");
  assert.equal(parsed.declarationLanguage, "objc");
  assert.equal(parsed.path, "uikit/uiview/addsubview(_:)");

  // The cached Swift page must be left as it was.
  assert.equal(page.metadata.title, "addSubview(_:)");
  const swift = selectLanguageVariant(page, "swift");
  assert.equal(swift.available, true);
  assert.equal(parseDocPage(swift.page, "uikit/uiview/addsubview(_:)").declarationLanguage, "swift");
});

test("selectLanguageVariant reports when a page has no Objective-C rendition", () => {
  const page = swiftPageWithObjcVariant();
  delete page.variantOverrides;

  const result = selectLanguageVariant(page, "objc");
  assert.equal(result.available, false);
  assert.equal(result.page, page);
});

test("selectLanguageVariant treats a page that is natively Objective-C as available", () => {
  const page = swiftPageWithObjcVariant();
  delete page.variantOverrides;
  page.identifier.interfaceLanguage = "occ";

  assert.equal(selectLanguageVariant(page, "objc").available, true);
});

test("formatDocPageMarkdown labels the declaration with its language", () => {
  const base = {
    title: "X",
    kind: "symbol",
    role: "symbol",
    abstract: "",
    platforms: [],
    path: "uikit/x",
    webUrl: "https://developer.apple.com/documentation/uikit/x",
    topicSections: [],
    relationships: [],
    seeAlsoSections: [],
    overview: "",
  };

  assert.match(formatDocPageMarkdown({ ...base, declaration: "func x()", declarationLanguage: "swift" }), /## Declaration\n```swift\nfunc x\(\)\n```/);
  assert.match(formatDocPageMarkdown({ ...base, declaration: "- (void)x;", declarationLanguage: "objc" }), /## Declaration\n```objc\n- \(void\)x;\n```/);
  // Web-service objects are declared in neither language ("object App"): no label.
  assert.match(formatDocPageMarkdown({ ...base, declaration: "object App" }), /## Declaration\n```\nobject App\n```/);
});

test("applyJsonPatch refuses paths that would reach an object's prototype", () => {
  const patched = applyJsonPatch({ safe: 1 }, [
    { op: "add", path: "/__proto__/polluted", value: true },
    { op: "add", path: "/constructor/prototype/polluted", value: true },
  ]);

  assert.deepEqual(patched, { safe: 1 });
  assert.equal({}.polluted, undefined);
});
