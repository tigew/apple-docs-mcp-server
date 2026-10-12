import test from "node:test";
import assert from "node:assert/strict";

import { assertAllowedUrl } from "../dist/services/safe-fetch.js";
import { normalizeSwiftBookPath, parseAtomFeed } from "../dist/services/swift-docs.js";
import { validateWwdcRef, parseWwdcSessionHtml } from "../dist/services/wwdc.js";
import {
  validateGuidelineNumber,
  parseGuidelinesIndex,
  parseGuidelineSection,
} from "../dist/services/appstore-guidelines.js";
import { resolveHelpUrl, parseHelpArticle, parseHelpIndex } from "../dist/services/appstore-connect-help.js";
import { validateForumTag, parseForumListing } from "../dist/services/forums.js";
import { renderBlockText } from "../dist/services/html-render.js";
import { validateSupportId, validateLocale, parseSupportArticle } from "../dist/services/support-kb.js";
import { validateResearchSlug, extractNextData } from "../dist/services/ml-research.js";
import {
  validateNewsId,
  validateMarketingSlug,
  parseNewsIndex,
  parseNewsPost,
} from "../dist/services/developer-news.js";
import { validateQaId, parseTechnicalQa } from "../dist/services/technical-qa.js";
import { load } from "cheerio";

// ---------------------------------------------------------------------------
// safe-fetch — SSRF host allowlist
// ---------------------------------------------------------------------------

test("assertAllowedUrl enforces HTTPS and the host allowlist", () => {
  assert.doesNotThrow(() => assertAllowedUrl("https://docs.swift.org/x.json", ["docs.swift.org"]));
  assert.throws(() => assertAllowedUrl("http://docs.swift.org/x", ["docs.swift.org"]), /non-HTTPS/);
  assert.throws(() => assertAllowedUrl("https://evil.com/x", ["docs.swift.org"]), /disallowed host/);
  // A look-alike host that merely contains the allowed name must be rejected.
  assert.throws(
    () => assertAllowedUrl("https://docs.swift.org.evil.com/x", ["docs.swift.org"]),
    /disallowed host/
  );
});

// ---------------------------------------------------------------------------
// Swift book
// ---------------------------------------------------------------------------

test("normalizeSwiftBookPath qualifies chapter slugs and rejects other origins/traversal", () => {
  assert.equal(normalizeSwiftBookPath("thebasics"), "the-swift-programming-language/thebasics");
  assert.equal(
    normalizeSwiftBookPath("the-swift-programming-language"),
    "the-swift-programming-language"
  );
  assert.equal(
    normalizeSwiftBookPath("https://docs.swift.org/swift-book/documentation/the-swift-programming-language/generics"),
    "the-swift-programming-language/generics"
  );
  assert.throws(() => normalizeSwiftBookPath("../secret"), /traversal|unexpected/);
  assert.throws(() => normalizeSwiftBookPath("https://developer.apple.com/x"), /only docs\.swift\.org/);
});

test("parseAtomFeed extracts entries newest-fields and flattens HTML summaries", () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <title>What's new in Swift: June 2026 Edition</title>
      <updated>2026-07-21T09:16:28-04:00</updated>
      <link rel="alternate" href="https://www.swift.org/blog/whats-new"/>
      <summary type="html">&lt;p&gt;Swift &lt;b&gt;6.4&lt;/b&gt; brings   many things.&lt;/p&gt;</summary>
    </entry>
  </feed>`;
  const entries = parseAtomFeed(xml, "swift.org blog", 10);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "What's new in Swift: June 2026 Edition");
  assert.equal(entries[0].link, "https://www.swift.org/blog/whats-new");
  assert.equal(entries[0].source, "swift.org blog");
  assert.match(entries[0].summary, /Swift 6\.4 brings many things\./);
});

// ---------------------------------------------------------------------------
// WWDC
// ---------------------------------------------------------------------------

test("validateWwdcRef enforces year and session shapes", () => {
  assert.deepEqual(validateWwdcRef("2024", "10176"), { year: "2024", id: "10176" });
  assert.throws(() => validateWwdcRef("24", "10176"), /Invalid WWDC year/);
  assert.throws(() => validateWwdcRef("2024", "10a"), /Invalid WWDC session/);
});

test("parseWwdcSessionHtml extracts title, transcript, chapters, and samples", () => {
  const html = `<html><head><title>My Session - WWDC24 - Videos - Apple Developer</title></head><body>
    <li class="supplement details"><div class="badge-available-on-wrapper"><h1>Meet Foo</h1></div><p>Foo is great.</p></li>
    <ul class="chapter-list">
      <li class="chapter-item"><a class="jump-to-time" data-start-time="90">Intro</a></li>
      <li class="chapter-item"><a class="jump-to-time" data-start-time="3661">Deep dive</a></li>
    </ul>
    <div id="transcript-content">
      <span class="sentence"><span data-start="7.0">Hello there.</span></span>
      <span class="sentence"><span data-start="11.0">Welcome.</span></span>
    </div>
    <li class="supplement sample-code"><ul><li class="sample-code-main-container">
      <p>1:26 - <a class="jump-to-time-sample" data-start-time="86">Using Foo</a></p>
      <pre class="code-source"><code><span class="syntax-keyword">let</span> x = 1</code></pre>
    </li></ul></li>
  </body></html>`;
  const s = parseWwdcSessionHtml(html, "2024", "10176");
  assert.equal(s.title, "Meet Foo");
  assert.equal(s.description, "Foo is great.");
  assert.equal(s.transcript, "Hello there. Welcome.");
  assert.equal(s.chapters.length, 2);
  assert.equal(s.chapters[0].time, "1:30");
  // Timestamps >= 1 hour carry an hours component.
  assert.equal(s.chapters[1].time, "1:01:01");
  assert.equal(s.sampleCode.length, 1);
  assert.equal(s.sampleCode[0].title, "Using Foo");
  assert.equal(s.sampleCode[0].code, "let x = 1");
});

// ---------------------------------------------------------------------------
// App Store Review Guidelines
// ---------------------------------------------------------------------------

const GUIDELINES_HTML = `<div id="content-container">
  <h3 data-sidenav id="safety"><span id="1"></span>1. Safety</h3>
  <p>Safety intro paragraph.</p>
  <ul>
    <li data-sidenav="2.3 Accurate Metadata" id="accurate-metadata"><span id="2.3"></span><strong>2.3 Accurate Metadata</strong>
      <p>Customers should know what they're getting.</p>
      <ul><li data-nr id="2.3.1"><strong>2.3.1</strong>
        <ul class="no-bullet"><li><strong>(a)</strong> Don't include hidden features.</li></ul>
      </li></ul>
    </li>
  </ul>
  <h3 data-sidenav id="performance"><span id="2"></span>2. Performance</h3>
</div>`;

test("validateGuidelineNumber rejects non-numeric section input", () => {
  assert.equal(validateGuidelineNumber("2.3.1"), "2.3.1");
  assert.throws(() => validateGuidelineNumber('2"]/script'), /Invalid guideline number/);
});

test("parseGuidelinesIndex lists titled levels 1-2 (not bare sub-points)", () => {
  const idx = parseGuidelinesIndex(GUIDELINES_HTML);
  const numbers = idx.map((e) => e.number);
  assert.deepEqual(numbers, ["1", "2", "2.3"]);
  assert.equal(idx.find((e) => e.number === "2.3").title, "2.3 Accurate Metadata");
});

test("parseGuidelineSection resolves span-borne and li-borne numeric ids", () => {
  const top = parseGuidelineSection(GUIDELINES_HTML, "1");
  assert.equal(top.title, "1. Safety");
  assert.match(top.text, /Safety intro paragraph/);

  const sub = parseGuidelineSection(GUIDELINES_HTML, "2.3.1");
  assert.match(sub.text, /Don't include hidden features/);

  assert.equal(parseGuidelineSection(GUIDELINES_HTML, "9.9"), null);
});

// ---------------------------------------------------------------------------
// App Store Connect Help
// ---------------------------------------------------------------------------

test("resolveHelpUrl allows only the ASC help tree and testflight", () => {
  assert.equal(resolveHelpUrl("testflight"), "https://developer.apple.com/testflight/");
  assert.equal(
    resolveHelpUrl("help/app-store-connect/get-started/overview"),
    "https://developer.apple.com/help/app-store-connect/get-started/overview/"
  );
  assert.throws(() => resolveHelpUrl("help/other/thing"), /must be under/);
  assert.throws(() => resolveHelpUrl("https://evil.com/help/app-store-connect/x"), /only developer\.apple\.com/);
});

test("parseHelpArticle scopes to main-content and ignores nav chrome", () => {
  const html = `<html><body>
    <nav><ul><li>Add and edit users</li><li>Manage subscriptions</li></ul></nav>
    <main id="main"><div class="main-content">
      <h1>TestFlight Overview</h1>
      <div class="platforms"><span class="platforms-badge">iOS</span><span class="platforms-badge">macOS</span></div>
      <p>TestFlight lets you distribute beta builds.</p>
      <h2>Get started</h2>
      <ul><li>Upload a build.</li></ul>
      <a href="/testflight/">Learn more.</a>
    </div></main>
  </body></html>`;
  const a = parseHelpArticle(html, "https://developer.apple.com/x/");
  assert.equal(a.title, "TestFlight Overview");
  assert.deepEqual(a.platforms, ["iOS", "macOS"]);
  assert.ok(a.blocks.some((b) => b.type === "h2" && b.text === "Get started"));
  assert.ok(a.blocks.some((b) => b.text === "Upload a build."));
  // Nav labels must not leak into the article body.
  assert.ok(!a.blocks.some((b) => b.text.includes("Add and edit users")));
  assert.equal(a.links[0].href, "https://developer.apple.com/testflight/");
});

test("parseHelpIndex enumerates section/article deep links", () => {
  const html = `<body>
    <a href="/help/app-store-connect/">Home</a>
    <a href="/help/app-store-connect/get-started/overview">Overview</a>
    <a href="/help/app-store-connect/manage-builds/upload">Upload a build</a>
    <a href="/help/app-store-connect/get-started/overview">Overview dup</a>
  </body>`;
  const idx = parseHelpIndex(html);
  assert.equal(idx.length, 2);
  assert.equal(idx[0].section, "get-started");
  assert.equal(idx[0].path, "help/app-store-connect/get-started/overview");
});

// ---------------------------------------------------------------------------
// Forums
// ---------------------------------------------------------------------------

test("validateForumTag rejects unsafe tag input", () => {
  assert.equal(validateForumTag("App-Store-Connect"), "app-store-connect");
  assert.throws(() => validateForumTag("swift ui"), /Invalid forum tag/);
  assert.throws(() => validateForumTag("../etc"), /Invalid forum tag/);
});

test("parseForumListing extracts thread ids, titles, and dedupes", () => {
  const html = `<body>
    <div class="topic-overview-posts">
      <a class="post-title no-underline" href="/forums/thread/839001"><span>Wrong number recharge</span></a>
      <div class="topic-overview-posts-timestamp">15m</div>
    </div>
    <div class="topic-overview-posts">
      <a class="post-title" href="/forums/thread/838964"><span>CarPlay Dashboard nav</span></a>
    </div>
    <a class="post-title" href="/forums/thread/839001">Wrong number recharge dup</a>
  </body>`;
  const threads = parseForumListing(html);
  assert.equal(threads.length, 2);
  assert.equal(threads[0].id, "839001");
  assert.equal(threads[0].title, "Wrong number recharge");
  assert.equal(threads[0].url, "https://developer.apple.com/forums/thread/839001");
  assert.equal(threads[0].timestamp, "15m");
});

// ---------------------------------------------------------------------------
// html-render (shared)
// ---------------------------------------------------------------------------

test("renderBlockText skips style/script and renders tables as markdown", () => {
  const $ = load(`<div id="root">
    <style>.x{color:red}</style>
    <h2>Heading</h2>
    <p>Some prose.</p>
    <script>alert(1)</script>
    <ul><li>One</li><li>Two</li></ul>
    <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
  </div>`);
  const text = renderBlockText($, $("#root"));
  assert.ok(!text.includes("color:red"), "CSS must not leak");
  assert.ok(!text.includes("alert"), "JS must not leak");
  assert.match(text, /## Heading/);
  assert.match(text, /- One/);
  assert.match(text, /\| A \| B \|/);
  assert.match(text, /\| --- \| --- \|/);
  assert.match(text, /\| 1 \| 2 \|/);
});

// ---------------------------------------------------------------------------
// support.apple.com KB
// ---------------------------------------------------------------------------

test("validateSupportId/validateLocale accept valid forms and reject junk", () => {
  assert.equal(validateSupportId("108351"), "108351");
  assert.equal(validateSupportId("ht201260"), "HT201260");
  assert.throws(() => validateSupportId("108351x"), /Invalid support article id/);
  assert.equal(validateLocale(undefined), "en-us");
  assert.equal(validateLocale("DE-DE"), "de-de");
  assert.throws(() => validateLocale("english"), /Invalid locale/);
});

test("parseSupportArticle returns null for a soft-404 and content for a real page", () => {
  const soft404 = `<html><head><title>Page Not Found - Official Apple Support</title>
    <link rel="canonical" href="https://support.apple.com/404"/></head><body><div id="sections"></div></body></html>`;
  assert.equal(parseSupportArticle(soft404, "108351x", "en-us", "u"), null);

  const real = `<html><head><title>Use headphones - Apple Support</title>
    <link rel="canonical" href="https://support.apple.com/en-us/108351"/></head><body>
    <div id="sections"><h1 class="gb-header">Use high-impedance headphones</h1>
    <p class="subheader gb-subheader">Connect them directly.</p>
    <p class="gb-paragraph">Compatible with recent Macs.</p></div></body></html>`;
  const a = parseSupportArticle(real, "108351", "en-us", "u");
  assert.equal(a.title, "Use high-impedance headphones");
  assert.equal(a.summary, "Connect them directly.");
  assert.match(a.body, /Compatible with recent Macs/);
});

// ---------------------------------------------------------------------------
// machinelearning.apple.com
// ---------------------------------------------------------------------------

test("validateResearchSlug normalizes and rejects bad slugs", () => {
  assert.equal(validateResearchSlug("research/environment-free"), "environment-free");
  assert.equal(validateResearchSlug("Environment-Free/"), "environment-free");
  assert.throws(() => validateResearchSlug("bad slug!"), /Invalid research slug/);
});

test("extractNextData parses the __NEXT_DATA__ island", () => {
  const html = `<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"posts":[{"slug":"x"}]}}}</script></body></html>`;
  const data = extractNextData(html);
  assert.equal(data.props.pageProps.posts[0].slug, "x");
  assert.throws(() => extractNextData("<html></html>"), /__NEXT_DATA__/);
});

// ---------------------------------------------------------------------------
// developer.apple.com news + marketing
// ---------------------------------------------------------------------------

test("validateNewsId and validateMarketingSlug guard input", () => {
  assert.equal(validateNewsId("TLUR8UVI"), "tlur8uvi");
  assert.throws(() => validateNewsId("bad id!"), /Invalid news id/);
  assert.equal(validateMarketingSlug("https://developer.apple.com/apple-intelligence/"), "apple-intelligence");
  // Trees owned by dedicated tools must be rejected by the marketing reader.
  assert.throws(() => validateMarketingSlug("documentation/swiftui"), /dedicated tool/);
  assert.throws(() => validateMarketingSlug("videos/play"), /dedicated tool/);
});

test("parseNewsIndex and parseNewsPost extract news cards", () => {
  const html = `<body>
    <article id="article-tlur8uvi" class="article">
      <a class="article-title" href="/news/?id=tlur8uvi"><h2>Age rating update</h2></a>
      <p class="lighter article-date">July 9, 2026</p>
      <span class="article-text"><p>New questions were added.</p></span>
    </article>
  </body>`;
  const list = parseNewsIndex(html, 10);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "tlur8uvi");
  assert.equal(list[0].title, "Age rating update");
  assert.equal(list[0].date, "July 9, 2026");

  const post = parseNewsPost(html, "tlur8uvi");
  assert.equal(post.title, "Age rating update");
  assert.match(post.body, /New questions were added/);
});

// ---------------------------------------------------------------------------
// legacy Technical Q&A
// ---------------------------------------------------------------------------

test("validateQaId normalizes id forms", () => {
  assert.equal(validateQaId("QA1361/_index.html"), "qa1361");
  assert.equal(validateQaId("qa1500"), "qa1500");
  assert.throws(() => validateQaId("1361"), /Invalid Technical Q&A id/);
});

test("parseTechnicalQa extracts question/code and rejects a page with no doc number", () => {
  const html = `<html><body>
    <h1 id="pageTitle">Detecting the Debugger</h1>
    <div class="dtsDocNumber">Technical Q&amp;A QA1361</div>
    <article id="contents">
      <h2>Q: How do I detect the debugger?</h2>
      <div class="importantbox">This document is no longer being updated.</div>
      <p>A: How do I detect the debugger?</p>
      <p>Use sysctl to inspect the process flags.</p>
      <p class="codesample clear"><strong class="caption_number">Listing 1</strong> Are you being debugged?</p>
      <div class="codesample clear"><table><tr><td><pre>static bool AmIBeingDebugged(void) { return false; }</pre></td></tr></table></div>
    </article>
  </body></html>`;
  const qa = parseTechnicalQa(html, "qa1361", "u");
  assert.equal(qa.docNumber, "Technical Q&A QA1361");
  assert.equal(qa.title, "Detecting the Debugger");
  assert.match(qa.question, /How do I detect the debugger/);
  const code = qa.blocks.find((b) => b.type === "code");
  assert.match(code.text, /AmIBeingDebugged/);
  assert.equal(code.caption, "Listing 1 Are you being debugged?");
  assert.ok(qa.blocks.some((b) => b.type === "text" && /Use sysctl/.test(b.text)));
  // The "no longer updated" boilerplate must be dropped.
  assert.ok(!qa.blocks.some((b) => b.text.includes("no longer being updated")));
  // The question must not be duplicated as a heading block or an "A:" echo.
  assert.ok(!qa.blocks.some((b) => b.type === "heading" && /detect the debugger/i.test(b.text)));
  assert.ok(!qa.blocks.some((b) => /^A:\s*How do I detect/i.test(b.text)));

  assert.equal(parseTechnicalQa("<html><body>404</body></html>", "qa9999", "u"), null);
});
