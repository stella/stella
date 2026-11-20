import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (
  source: string,
  sourcePath = "apps/api/src/lib/detected-country.ts",
) =>
  await lintSingleRule("no-raw-cloudfront-viewer-header", source, {
    sourcePath,
  });

describe("no-raw-cloudfront-viewer-header", () => {
  test("rejects a viewer header name outside its owners, in any case", async () => {
    expect(
      await lint(
        [
          'const country = request.headers.get("cloudfront-viewer-country");',
          'const city = headers.get("CloudFront-Viewer-City");',
          `const value = headers.get(\`cloudfront-viewer-\${field}\`);`,
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3]);
  });

  test("ignores other headers and prose", async () => {
    expect(
      await lint(
        [
          'const forwarded = headers.get("x-forwarded-for");',
          'const label = "the CloudFront viewer country";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test.each([
    "apps/api/src/lib/client-ip.ts",
    "apps/api/src/lib/auth/viewer-location.ts",
  ])("leaves the owner %s its header names", async (owner) => {
    expect(
      await lint('const country = "cloudfront-viewer-country";', owner),
    ).toEqual([]);
  });
});
