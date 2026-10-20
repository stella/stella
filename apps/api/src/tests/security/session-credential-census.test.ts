import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// Only the API server can accept a credential, so the census covers its package.
const apiRoot = path.resolve(import.meta.dir, "../../..");

// Sessions are cookie credentials. A session token sent as a bearer would
// bypass the cookie rotation every client follows; programmatic clients use
// OAuth, API keys or their own device credentials instead.
const SESSION_BEARER_PLUGIN =
  /import\s*\{[^}]*\bbearer\b[^}]*\}\s*from\s*["']better-auth\/plugins["']/u;

const sourceFiles = () =>
  [
    ...new Glob("{src,scripts}/**/*.{ts,tsx,mts}").scanSync({
      cwd: apiRoot,
    }),
  ].filter((file) => !file.includes("/node_modules/"));

describe("session credential census", () => {
  test("no module accepts a session token as a bearer", () => {
    const offenders = sourceFiles().filter((file) =>
      SESSION_BEARER_PLUGIN.test(
        readFileSync(path.join(apiRoot, file), "utf-8"),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
