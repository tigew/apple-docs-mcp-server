import { readFileSync } from "node:fs";

/**
 * The package version, read from package.json so it is defined in one place.
 * (package.json sits one level above both src/ and the compiled dist/.)
 */
export const VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;
