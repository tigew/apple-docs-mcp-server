/**
 * Constants for the Apple Developer Documentation MCP Server
 */

export const APPLE_DOCS_BASE_URL = "https://developer.apple.com/tutorials/data";
export const APPLE_DOCS_WEB_BASE = "https://developer.apple.com/documentation";
export const CHARACTER_LIMIT = 25000;
export const REQUEST_TIMEOUT_MS = 15000;

/** Well-known Apple framework identifiers that map to their JSON paths */
export const KNOWN_FRAMEWORKS: Record<string, string> = {
  // Swift language
  swift: "swift",
  // Apple UI frameworks
  swiftui: "swiftui",
  uikit: "uikit",
  appkit: "appkit",
  // Foundation
  foundation: "foundation",
  // Combine & Observation
  combine: "combine",
  observation: "observation",
  // Data / persistence
  coredata: "coredata",
  swiftdata: "swiftdata",
  cloudkit: "cloudkit",
  // Media
  avfoundation: "avfoundation",
  arkit: "arkit",
  realitykit: "realitykit",
  scenekit: "scenekit",
  spritekit: "spritekit",
  // ML / Vision
  coreml: "coreml",
  vision: "vision",
  naturallanguage: "naturallanguage",
  createml: "createml",
  // Maps / Location
  mapkit: "mapkit",
  corelocation: "corelocation",
  // Health / Fitness
  healthkit: "healthkit",
  coremotion: "coremotion",
  workoutkit: "workoutkit",
  // Connectivity
  corebluetooth: "corebluetooth",
  networkextension: "networkextension",
  network: "network",
  // System
  security: "security",
  cryptokit: "cryptokit",
  storekit: "storekit",
  pushkit: "pushkit",
  usernotifications: "usernotifications",
  // Concurrency
  swift_concurrency: "swift#Concurrency",
  synchronization: "synchronization",
  distributed: "distributed",
  // watchOS
  watchkit: "watchkit",
  // tvOS
  tvuikit: "tvuikit",
  // visionOS
  visionos: "visionos",
  // Widgets
  widgetkit: "widgetkit",
  // App Intents
  appintents: "appintents",
};
