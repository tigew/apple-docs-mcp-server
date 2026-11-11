import test from "node:test";
import assert from "node:assert/strict";

import { formatDocPageMarkdown, normalizePath, parseDocPage } from "../dist/services/apple-docs.js";
import { buildWebUrl, docJsonUrl } from "../dist/services/docs/paths.js";

// Fixtures mirror developer.apple.com/tutorials/data/tutorials/*.json.

const paragraph = (text) => ({ type: "paragraph", inlineContent: [{ type: "text", text }] });

test("tutorial paths map to the tutorials tree, not the documentation tree", () => {
  assert.equal(normalizePath("https://developer.apple.com/tutorials/SwiftUI/Creating-and-Combining-Views"), "tutorials/swiftui/creating-and-combining-views");
  assert.equal(docJsonUrl("tutorials/swiftui"), "https://developer.apple.com/tutorials/data/tutorials/swiftui.json");
  assert.equal(buildWebUrl("tutorials/swiftui/creating-and-combining-views"), "https://developer.apple.com/tutorials/swiftui/creating-and-combining-views");
  // Ordinary documentation is unaffected.
  assert.equal(docJsonUrl("swiftui/view"), "https://developer.apple.com/tutorials/data/documentation/swiftui/view.json");
});

function overviewPage() {
  const tutorial = (slug, extra) => ({
    identifier: `doc://com.apple.SwiftUI/tutorials/SwiftUI/${slug}`,
    kind: "project",
    role: "project",
    type: "topic",
    url: `/tutorials/swiftui/${slug}`,
    ...extra,
  });
  return {
    identifier: { url: "doc://com.apple.SwiftUI/tutorials/SwiftUI", interfaceLanguage: "swift" },
    kind: "overview",
    metadata: { category: "SwiftUI", estimatedTime: "4hr 25min", role: "overview", title: "Introducing SwiftUI" },
    hierarchy: { paths: [], reference: "doc://com.apple.SwiftUI/tutorials/SwiftUI" },
    sections: [
      { kind: "hero", title: "Introducing SwiftUI", content: [paragraph("SwiftUI is a modern way to declare user interfaces.")] },
      {
        kind: "volume",
        name: null,
        chapters: [
          {
            name: "SwiftUI essentials",
            content: [paragraph("Learn how to compose rich views out of simple ones.")],
            tutorials: [
              "doc://com.apple.SwiftUI/tutorials/SwiftUI/creating-and-combining-views",
              "doc://com.apple.SwiftUI/tutorials/SwiftUI/building-lists-and-navigation",
            ],
          },
        ],
      },
      {
        kind: "volume",
        name: "Framework integration",
        content: [paragraph("Use SwiftUI with other frameworks.")],
        chapters: [{ name: "Interfacing with UIKit", content: [], tutorials: ["doc://com.apple.SwiftUI/tutorials/SwiftUI/interfacing-with-uikit"] }],
      },
    ],
    references: {
      "doc://com.apple.SwiftUI/tutorials/SwiftUI/creating-and-combining-views": tutorial("creating-and-combining-views", { title: "Creating and combining views", abstract: [], estimatedTime: "40min" }),
      "doc://com.apple.SwiftUI/tutorials/SwiftUI/building-lists-and-navigation": tutorial("building-lists-and-navigation", {
        title: "Building lists and navigation",
        abstract: [{ type: "text", text: "Show a list of landmarks." }],
        estimatedTime: "35min",
      }),
      "doc://com.apple.SwiftUI/tutorials/SwiftUI/interfacing-with-uikit": tutorial("interfacing-with-uikit", { title: "Interfacing with UIKit", abstract: [] }),
    },
  };
}

test("a tutorial collection lists its chapters and the tutorials in each, with paths to fetch them", () => {
  const parsed = parseDocPage(overviewPage(), "tutorials/swiftui");

  assert.equal(parsed.title, "Introducing SwiftUI");
  assert.equal(parsed.roleHeading, "Tutorials");
  assert.equal(parsed.path, "tutorials/swiftui");
  assert.equal(parsed.webUrl, "https://developer.apple.com/tutorials/swiftui");
  assert.equal(parsed.abstract, "SwiftUI is a modern way to declare user interfaces.");
  assert.equal(
    parsed.overview,
    [
      "**Estimated time**: 4hr 25min",
      "",
      "### SwiftUI essentials",
      "",
      "Learn how to compose rich views out of simple ones.",
      "",
      "- **Creating and combining views** (path: `tutorials/swiftui/creating-and-combining-views`) — 40min",
      "- **Building lists and navigation** (path: `tutorials/swiftui/building-lists-and-navigation`) — Show a list of landmarks. · 35min",
      "",
      "## Framework integration",
      "",
      "Use SwiftUI with other frameworks.",
      "",
      "### Interfacing with UIKit",
      "",
      "- **Interfacing with UIKit** (path: `tutorials/swiftui/interfacing-with-uikit`)",
    ].join("\n")
  );
});

function projectPage() {
  const file = (identifier, content, highlights) => ({ identifier, type: "file", fileName: "ContentView.swift", fileType: "swift", syntax: "swift", content, highlights });
  const original = ["import SwiftUI", "", "struct ContentView: View {", "    var body: some View {", "        Text(\"Hello, world!\")", "            .padding()", "    }", "}", "", "#Preview {", "    ContentView()", "}"];
  const changed = [...original];
  changed[4] = "        Text(\"Hello SwiftUI!\")";
  return {
    identifier: { url: "doc://com.apple.SwiftUI/tutorials/SwiftUI/creating-and-combining-views", interfaceLanguage: "swift" },
    kind: "project",
    metadata: { category: "SwiftUI", role: "project", title: "Creating and combining views" },
    hierarchy: { modules: [], reference: "doc://com.apple.SwiftUI/tutorials/SwiftUI" },
    sections: [
      { kind: "hero", title: "Creating and combining views", chapter: "SwiftUI essentials", estimatedTimeInMinutes: 40, content: [paragraph("This tutorial guides you through building Landmarks.")] },
      {
        kind: "tasks",
        tasks: [
          {
            anchor: "Create-a-new-project",
            title: "Create a new project",
            contentSection: [{ kind: "contentAndMedia", content: [paragraph("Create a new Xcode project that uses SwiftUI.")] }],
            stepsSection: [
              { type: "step", content: [paragraph("Open Xcode and choose File > New > Project.")], caption: [], code: null },
              { type: "step", content: [paragraph("Select ContentView.swift.")], caption: [paragraph("By default, SwiftUI view files declare a structure and a preview.")], code: "010105.swift" },
              { type: "step", content: [paragraph("Change the greeting.")], caption: [], code: "010106.swift" },
            ],
          },
        ],
      },
      {
        kind: "assessments",
        assessments: [
          {
            title: [paragraph("Where do you declare a custom view’s layout?")],
            choices: [
              { content: [paragraph("In the view’s initializer.")], isCorrect: false, justification: [paragraph("Use the body property instead.")] },
              { content: [paragraph("In the body property.")], isCorrect: true, justification: [paragraph("Custom views implement body.")] },
            ],
          },
        ],
      },
      {
        kind: "callToAction",
        title: "Building lists and navigation",
        action: { identifier: "doc://com.apple.SwiftUI/tutorials/SwiftUI/building-lists-and-navigation", type: "reference" },
      },
    ],
    references: {
      "010105.swift": file("010105.swift", original, []),
      "010106.swift": file("010106.swift", changed, [{ line: 5 }]),
      "doc://com.apple.SwiftUI/tutorials/SwiftUI/building-lists-and-navigation": {
        identifier: "doc://com.apple.SwiftUI/tutorials/SwiftUI/building-lists-and-navigation",
        title: "Building lists and navigation",
        url: "/tutorials/swiftui/building-lists-and-navigation",
        type: "topic",
      },
    },
  };
}

test("a tutorial is rendered as its sections, numbered steps, code, and review questions", () => {
  const parsed = parseDocPage(projectPage(), "tutorials/swiftui/creating-and-combining-views");

  assert.equal(parsed.roleHeading, "Tutorial");
  assert.equal(parsed.abstract, "This tutorial guides you through building Landmarks.");
  assert.equal(
    parsed.overview,
    [
      "**Chapter**: SwiftUI essentials · **Estimated time**: 40 min",
      "",
      "## Create a new project",
      "",
      "Create a new Xcode project that uses SwiftUI.",
      "",
      "**Step 1.** Open Xcode and choose File > New > Project.",
      "",
      "**Step 2.** Select ContentView.swift.",
      "",
      // First time the file appears: shown whole.
      "`ContentView.swift`",
      "```swift",
      "import SwiftUI",
      "",
      "struct ContentView: View {",
      "    var body: some View {",
      "        Text(\"Hello, world!\")",
      "            .padding()",
      "    }",
      "}",
      "",
      "#Preview {",
      "    ContentView()",
      "}",
      "```",
      "",
      "By default, SwiftUI view files declare a structure and a preview.",
      "",
      "**Step 3.** Change the greeting.",
      "",
      // Seen before: only the changed line, with two lines either side.
      "`ContentView.swift` — changed line 5",
      "```swift",
      "struct ContentView: View {",
      "    var body: some View {",
      "        Text(\"Hello SwiftUI!\")",
      "            .padding()",
      "    }",
      "```",
      "",
      "## Check Your Understanding",
      "",
      "**Question 1.** Where do you declare a custom view’s layout?",
      "",
      "- In the view’s initializer. — Use the body property instead.",
      "- **In the body property. (correct)** — Custom views implement body.",
      "",
      "**Next**: Building lists and navigation (path: `tutorials/swiftui/building-lists-and-navigation`)",
    ].join("\n")
  );
});

test("a changed-lines excerpt merges nearby changes and marks the gaps between distant ones", () => {
  const page = projectPage();
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  page.references["010105.swift"].content = lines;
  page.references["010106.swift"].content = lines;
  page.references["010106.swift"].highlights = [{ line: 3 }, { line: 4 }, { line: 20 }];

  const { overview } = parseDocPage(page, "tutorials/swiftui/creating-and-combining-views");

  assert.match(overview, /`ContentView\.swift` — changed lines 3–4, 20\n```swift\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6\n…\nline 18\nline 19\nline 20\nline 21\nline 22\n```/);
});

test("a tutorial article renders its body", () => {
  const parsed = parseDocPage(
    {
      identifier: { url: "doc://com.apple.DevelopInSwift/tutorials/Develop-in-Swift/Welcome", interfaceLanguage: "swift" },
      kind: "article",
      metadata: { role: "article", title: "Welcome to Develop in Swift Tutorials" },
      sections: [
        { kind: "hero", title: "Welcome", estimatedTimeInMinutes: 5, content: [paragraph("Go from idea to app.")] },
        { kind: "articleBody", content: [{ kind: "fullWidth", content: [{ type: "heading", level: 2, text: "Go from idea to app" }, paragraph("Use the tutorials to build apps.")] }] },
      ],
      references: {},
    },
    "tutorials/develop-in-swift/welcome"
  );

  assert.equal(parsed.roleHeading, "Tutorial Article");
  assert.equal(parsed.overview, "**Estimated time**: 5 min\n\n## Go from idea to app\n\nUse the tutorials to build apps.");
});

test("a tutorial page formats with its role and no empty sections", () => {
  const markdown = formatDocPageMarkdown(parseDocPage(overviewPage(), "tutorials/swiftui"));

  assert.match(markdown, /^# Introducing SwiftUI\n\*\*Tutorials\*\*\n\*\*URL\*\*: https:\/\/developer\.apple\.com\/tutorials\/swiftui\n/);
  assert.match(markdown, /## Documentation\n\*\*Estimated time\*\*: 4hr 25min/);
});

test("a tutorial's breadcrumb leaves out Apple's internal volume placeholder", () => {
  const page = projectPage();
  page.hierarchy = {
    paths: [["doc://com.apple.SwiftUI/tutorials/SwiftUI", "doc://com.apple.SwiftUI/tutorials/SwiftUI/$volume", "doc://com.apple.SwiftUI/tutorials/SwiftUI/SwiftUI-essentials"]],
  };
  page.references["doc://com.apple.SwiftUI/tutorials/SwiftUI"] = { identifier: "doc://com.apple.SwiftUI/tutorials/SwiftUI", type: "topic", title: "Introducing SwiftUI" };
  page.references["doc://com.apple.SwiftUI/tutorials/SwiftUI/SwiftUI-essentials"] = { identifier: "x", type: "topic", title: "SwiftUI essentials" };

  const parsed = parseDocPage(page, "tutorials/swiftui/creating-and-combining-views");

  assert.deepEqual(parsed.breadcrumb, ["Introducing SwiftUI", "SwiftUI essentials"]);
});
