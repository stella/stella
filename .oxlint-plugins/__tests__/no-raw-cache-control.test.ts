import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (
  source: string,
  sourcePath = "apps/api/src/handlers/example.ts",
) => await lintSingleRule("no-raw-cache-control", source, { sourcePath });

describe("no-raw-cache-control", () => {
  test("rejects raw Cache-Control names and directive values", async () => {
    expect(
      await lint(
        [
          'set.headers["cache-control"] = "no-store";',
          'const headers = { "Cache-Control": "public, max-age=300" };',
          `const policy = \`private, max-age=\${ttl}\`;`,
        ].join("\n"),
      ),
    ).toEqual([1, 1, 2, 2, 3]);
  });

  test("ignores ordinary public/private literals and unrelated text", async () => {
    expect(
      await lint(
        [
          'const state = "private";',
          'const audience = "public";',
          'const description = "public matter metadata";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("leaves both canonical policy modules to own their literals", async () => {
    const source = 'const policy = "private, no-store";';
    expect(await lint(source, "apps/api/src/lib/cache-policy.ts")).toEqual([]);
    expect(await lint(source, "apps/api/src/lib/security-headers.ts")).toEqual(
      [],
    );
  });
});
