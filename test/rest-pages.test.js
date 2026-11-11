import test from "node:test";
import assert from "node:assert/strict";

import { extractOverview, formatDocPageMarkdown, parseDocPage } from "../dist/services/apple-docs.js";

// Fixtures mirror the render JSON Apple serves for web-service documentation
// (App Store Connect API, App Store Server API) and property-list keys.

const text = (value) => [{ type: "paragraph", inlineContent: [{ type: "text", text: value }] }];

function page(overrides) {
  return {
    identifier: { url: "doc://com.apple.appstoreconnectapi/documentation/AppStoreConnectAPI/GET-v1-apps", interfaceLanguage: "data" },
    kind: "symbol",
    metadata: { title: "List apps", role: "symbol", roleHeading: "Web Service Endpoint", symbolKind: "httpRequest", platforms: [] },
    abstract: [{ type: "text", text: "Find and list apps." }],
    primaryContentSections: [],
    topicSections: [],
    seeAlsoSections: [],
    relationshipsSections: [],
    references: {
      "doc://com.apple.appstoreconnectapi/documentation/AppStoreConnectAPI/AppsResponse": {
        identifier: "doc://com.apple.appstoreconnectapi/documentation/AppStoreConnectAPI/AppsResponse",
        type: "topic",
        title: "AppsResponse",
        url: "/documentation/appstoreconnectapi/appsresponse",
      },
      "doc://com.apple.appstoreconnectapi/documentation/AppStoreConnectAPI/creating-alternative-distribution-packages": {
        identifier: "doc://com.apple.appstoreconnectapi/documentation/AppStoreConnectAPI/creating-alternative-distribution-packages",
        type: "topic",
        title: "Creating alternative distribution packages",
        url: "/documentation/appstoreconnectapi/creating-alternative-distribution-packages",
      },
    },
    ...overrides,
  };
}

const typeRef = (name) => [
  {
    kind: "typeIdentifier",
    identifier: `doc://com.apple.appstoreconnectapi/documentation/AppStoreConnectAPI/${name}`,
    preciseIdentifier: `data:app_store_connect_api:${name}`,
    text: name,
  },
];

test("parseDocPage reads each REST endpoint's method and full URL", () => {
  const parsed = parseDocPage(
    page({
      primaryContentSections: [
        {
          kind: "restEndpoint",
          title: "URL",
          tokens: [
            { kind: "method", text: "GET" },
            { kind: "text", text: " " },
            { kind: "baseURL", text: "https://api.storekit.apple.com/" },
            { kind: "path", text: "inApps/v1/transactions/" },
            { kind: "parameter", text: "{transactionId}" },
          ],
        },
        {
          kind: "restEndpoint",
          title: "Sandbox URL",
          tokens: [
            { kind: "method", text: "GET" },
            { kind: "text", text: " " },
            { kind: "baseURL", text: "https://api.storekit-sandbox.apple.com/" },
            { kind: "path", text: "inApps/v1/transactions/" },
            { kind: "parameter", text: "{transactionId}" },
          ],
        },
      ],
    }),
    "appstoreserverapi/get-transaction-info"
  );

  assert.deepEqual(parsed.restEndpoints, [
    { title: "URL", method: "GET", url: "https://api.storekit.apple.com/inApps/v1/transactions/{transactionId}" },
    { title: "Sandbox URL", method: "GET", url: "https://api.storekit-sandbox.apple.com/inApps/v1/transactions/{transactionId}" },
  ]);
});

test("parseDocPage groups REST parameters by source with type, requirement, and constraints", () => {
  const parsed = parseDocPage(
    page({
      primaryContentSections: [
        {
          kind: "restParameters",
          source: "path",
          title: "Path Parameters",
          items: [{ attributes: [], content: text("An opaque resource ID."), name: "id", required: true, type: [{ kind: "text", text: "string" }] }],
        },
        {
          kind: "restParameters",
          source: "query",
          title: "Query Parameters",
          items: [
            {
              attributes: [{ kind: "maximum", value: "200" }],
              content: text("Number of resources to return."),
              name: "limit",
              required: false,
              type: [{ kind: "text", text: "integer" }],
            },
            {
              attributes: [{ kind: "allowedValues", values: ["name", "bundleId", "sku"] }],
              content: text("Fields to return."),
              name: "fields[apps]",
              required: false,
              type: [{ kind: "text", text: "[string]" }],
            },
            {
              attributes: [],
              content: text(""),
              deprecated: true,
              name: "filter[old]",
              required: false,
              type: [{ kind: "text", text: "[string]" }],
            },
          ],
        },
      ],
    }),
    "appstoreconnectapi/get-v1-apps"
  );

  assert.deepEqual(parsed.restParameters, [
    {
      title: "Path Parameters",
      source: "path",
      items: [{ name: "id", type: "string", required: true, description: "An opaque resource ID." }],
    },
    {
      title: "Query Parameters",
      source: "query",
      items: [
        { name: "limit", type: "integer", required: false, description: "Number of resources to return.", constraints: ["Maximum: 200"] },
        { name: "fields[apps]", type: "[string]", required: false, description: "Fields to return.", allowedValues: ["name", "bundleId", "sku"] },
        { name: "filter[old]", type: "[string]", required: false, description: "", deprecated: true },
      ],
    },
  ]);
});

test("parseDocPage reads the request body and response codes with fetchable type paths", () => {
  const parsed = parseDocPage(
    page({
      primaryContentSections: [
        {
          kind: "restBody",
          title: "HTTP Body",
          mimeType: "application/json",
          bodyContentType: typeRef("BetaGroupCreateRequest"),
          content: text(""),
          parameters: [],
        },
        {
          kind: "restResponses",
          title: "Response Codes",
          items: [
            { content: text(""), mimeType: "application/json", reason: "OK", status: 200, type: typeRef("AppsResponse") },
            { content: text("An error occurred with your request."), mimeType: "application/json", reason: "Bad Request", status: 400, type: typeRef("ErrorResponse") },
          ],
        },
      ],
    }),
    "appstoreconnectapi/post-v1-betagroups"
  );

  // Not in `references`, so the path is derived from the doc:// identifier itself.
  assert.deepEqual(parsed.restBody, {
    title: "HTTP Body",
    mimeType: "application/json",
    type: "BetaGroupCreateRequest",
    typePath: "appstoreconnectapi/betagroupcreaterequest",
    description: "",
  });
  assert.deepEqual(parsed.restResponses, [
    // Resolved through `references`.
    { status: 200, reason: "OK", mimeType: "application/json", type: "AppsResponse", typePath: "appstoreconnectapi/appsresponse", description: "" },
    {
      status: 400,
      reason: "Bad Request",
      mimeType: "application/json",
      type: "ErrorResponse",
      typePath: "appstoreconnectapi/errorresponse",
      description: "An error occurred with your request.",
    },
  ]);
});

test("parseDocPage reads an object's properties and an enumeration's possible values", () => {
  const parsed = parseDocPage(
    page({
      metadata: { title: "App", role: "symbol", roleHeading: "Object", symbolKind: "dictionary", platforms: [] },
      primaryContentSections: [
        {
          kind: "properties",
          title: "Properties",
          items: [
            { attributes: [], content: text("The resource’s attributes."), name: "attributes", required: false, type: typeRef("App/Attributes-data.dictionary").map((t) => ({ ...t, text: "App.Attributes" })) },
            { attributes: [], content: text("The opaque resource ID."), name: "id", required: true, type: [{ kind: "text", text: "string" }] },
            {
              attributes: [{ kind: "allowedValues", values: ["DOES_NOT_USE_THIRD_PARTY_CONTENT", "USES_THIRD_PARTY_CONTENT"] }],
              content: text(""),
              name: "contentRightsDeclaration",
              required: false,
              type: [{ kind: "text", text: "string" }],
            },
          ],
        },
        {
          kind: "possibleValues",
          title: "Possible Values",
          values: [
            { content: text("A string that represents iOS."), name: "IOS" },
            { content: text("A string that represents macOS."), name: "MAC_OS" },
          ],
        },
      ],
    }),
    "appstoreconnectapi/app"
  );

  assert.deepEqual(parsed.properties, {
    title: "Properties",
    items: [
      { name: "attributes", type: "App.Attributes", typePath: "appstoreconnectapi/app/attributes-data.dictionary", required: false, description: "The resource’s attributes." },
      { name: "id", type: "string", required: true, description: "The opaque resource ID." },
      {
        name: "contentRightsDeclaration",
        type: "string",
        required: false,
        description: "",
        allowedValues: ["DOES_NOT_USE_THIRD_PARTY_CONTENT", "USES_THIRD_PARTY_CONTENT"],
      },
    ],
  });
  assert.deepEqual(parsed.possibleValues, {
    title: "Possible Values",
    items: [
      { name: "IOS", description: "A string that represents iOS." },
      { name: "MAC_OS", description: "A string that represents macOS." },
    ],
  });
});

test("parseDocPage reads property-list key details and the pages that mention a symbol", () => {
  const parsed = parseDocPage(
    page({
      metadata: { title: "NSCameraUsageDescription", role: "symbol", roleHeading: "Property List Key", symbolKind: "typealias", platforms: [] },
      primaryContentSections: [
        {
          kind: "details",
          title: "Details",
          details: {
            ideTitle: "Privacy - Camera Usage Description",
            name: "NSCameraUsageDescription",
            platforms: [],
            titleStyle: "symbol",
            value: [{ arrayMode: false, baseType: "string" }, { arrayMode: true, baseType: "dictionary" }],
          },
        },
        {
          kind: "mentions",
          mentions: [
            "doc://com.apple.appstoreconnectapi/documentation/AppStoreConnectAPI/creating-alternative-distribution-packages",
            "doc://com.apple.appstoreconnectapi/documentation/AppStoreConnectAPI/Not-In-References",
          ],
        },
      ],
    }),
    "bundleresources/information-property-list/nscamerausagedescription"
  );

  assert.deepEqual(parsed.details, {
    name: "NSCameraUsageDescription",
    ideTitle: "Privacy - Camera Usage Description",
    valueTypes: ["string", "[dictionary]"],
  });
  assert.deepEqual(parsed.mentionedIn, [
    { title: "Creating alternative distribution packages", path: "appstoreconnectapi/creating-alternative-distribution-packages" },
    { title: "not-in-references", path: "appstoreconnectapi/not-in-references" },
  ]);
});

test("parseDocPage leaves the REST fields off pages that have none", () => {
  const parsed = parseDocPage(page({ primaryContentSections: [{ kind: "content", content: text("Plain article.") }] }), "swiftui/view");

  for (const key of ["restEndpoints", "restParameters", "restBody", "restResponses", "properties", "possibleValues", "details", "mentionedIn"]) {
    assert.equal(key in parsed, false, key);
  }
});

test("formatDocPageMarkdown renders endpoint, parameters, body, and responses ahead of the prose", () => {
  const markdown = formatDocPageMarkdown({
    title: "List apps",
    kind: "symbol",
    role: "symbol",
    roleHeading: "Web Service Endpoint",
    abstract: "Find and list apps.",
    platforms: [],
    path: "appstoreconnectapi/get-v1-apps",
    webUrl: "https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps",
    topicSections: [],
    relationships: [],
    seeAlsoSections: [],
    overview: "### Example Request and Response",
    restEndpoints: [{ title: "URL", method: "GET", url: "https://api.appstoreconnect.apple.com/v1/apps" }],
    restParameters: [
      {
        title: "Query Parameters",
        source: "query",
        items: [
          { name: "limit", type: "integer", required: false, description: "Number of resources to return.", constraints: ["Maximum: 200"] },
          { name: "id", type: "string", required: true, description: "An opaque resource ID." },
          { name: "filter[old]", type: "[string]", required: false, description: "", deprecated: true },
        ],
      },
    ],
    restBody: { title: "HTTP Body", mimeType: "application/json", type: "AppUpdateRequest", typePath: "appstoreconnectapi/appupdaterequest", description: "The changes to apply." },
    restResponses: [
      { status: 200, reason: "OK", mimeType: "application/json", type: "AppsResponse", typePath: "appstoreconnectapi/appsresponse", description: "" },
      { status: 400, reason: "Bad Request", mimeType: "application/json", type: "ErrorResponse", typePath: "appstoreconnectapi/errorresponse", description: "An error occurred with your request." },
    ],
  });

  assert.match(markdown, /## Endpoint\n- \*\*URL\*\*: `GET https:\/\/api\.appstoreconnect\.apple\.com\/v1\/apps`\n/);
  assert.match(markdown, /## Query Parameters\n- \*\*`limit`\*\* `integer` \(optional\) — Number of resources to return\. Maximum: 200\.\n- \*\*`id`\*\* `string` \(required\) — An opaque resource ID\.\n- \*\*`filter\[old\]`\*\* `\[string\]` \(optional, deprecated\)\n/);
  assert.match(markdown, /## HTTP Body\n`AppUpdateRequest` \(path: `appstoreconnectapi\/appupdaterequest`\), application\/json\n\nThe changes to apply\.\n/);
  assert.match(markdown, /## Response Codes\n- \*\*200 OK\*\* — `AppsResponse` \(path: `appstoreconnectapi\/appsresponse`\), application\/json\n- \*\*400 Bad Request\*\* — `ErrorResponse` \(path: `appstoreconnectapi\/errorresponse`\), application\/json — An error occurred with your request\.\n/);
  // Reference data comes before the (often very long) prose, so truncation costs examples, not the API shape.
  assert.ok(markdown.indexOf("## Response Codes") < markdown.indexOf("## Documentation"));
});

test("formatDocPageMarkdown renders properties, possible values, details, and mentions", () => {
  const markdown = formatDocPageMarkdown({
    title: "App",
    kind: "symbol",
    role: "symbol",
    roleHeading: "Object",
    abstract: "",
    platforms: [],
    path: "appstoreconnectapi/app",
    webUrl: "https://developer.apple.com/documentation/appstoreconnectapi/app",
    topicSections: [],
    relationships: [],
    seeAlsoSections: [],
    overview: "",
    properties: {
      title: "Properties",
      items: [
        { name: "attributes", type: "App.Attributes", typePath: "appstoreconnectapi/app/attributes-data.dictionary", required: false, description: "The resource’s attributes." },
        { name: "platform", type: "string", required: false, description: "", allowedValues: ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11", "v12"] },
      ],
    },
    possibleValues: { title: "Possible Values", items: [{ name: "IOS", description: "A string that represents iOS." }] },
    details: { name: "NSCameraUsageDescription", ideTitle: "Privacy - Camera Usage Description", valueTypes: ["string"] },
    mentionedIn: [{ title: "Creating alternative distribution packages", path: "appstoreconnectapi/creating-alternative-distribution-packages" }],
  });

  assert.match(markdown, /## Properties\n- \*\*`attributes`\*\* `App\.Attributes` \(path: `appstoreconnectapi\/app\/attributes-data\.dictionary`\) \(optional\) — The resource’s attributes\.\n/);
  // Long allowed-value lists are capped at ten in markdown; JSON keeps them all.
  assert.match(markdown, /- \*\*`platform`\*\* `string` \(optional\) — Allowed values: `v1`, `v2`, `v3`, `v4`, `v5`, `v6`, `v7`, `v8`, `v9`, `v10` \(\+2 more\)\.\n/);
  assert.match(markdown, /## Possible Values\n- \*\*`IOS`\*\* — A string that represents iOS\.\n/);
  assert.match(markdown, /## Details\n- \*\*Name\*\*: `NSCameraUsageDescription`\n- \*\*Xcode name\*\*: Privacy - Camera Usage Description\n- \*\*Type\*\*: string\n/);
  assert.match(markdown, /## Mentioned In\n- \*\*Creating alternative distribution packages\*\* \(path: `appstoreconnectapi\/creating-alternative-distribution-packages`\)\n/);
});

test("extractOverview renders each tab of a tab navigator under its title", () => {
  const overview = extractOverview([
    {
      kind: "content",
      content: [
        { type: "heading", level: 3, text: "Example Request and Response", anchor: "Example-Request-and-Response" },
        {
          type: "tabNavigator",
          tabs: [
            { title: "Request", content: [{ type: "codeListing", syntax: null, code: ["GET /v1/apps?limit=2"] }] },
            { title: "Response", content: [{ type: "codeListing", syntax: "json", code: ["{", '  "data": []', "}"] }] },
          ],
        },
      ],
    },
  ]);

  assert.equal(
    overview,
    '### Example Request and Response\n\n**Request**\n\n```\nGET /v1/apps?limit=2\n```\n\n**Response**\n\n```json\n{\n  "data": []\n}\n```'
  );
});
