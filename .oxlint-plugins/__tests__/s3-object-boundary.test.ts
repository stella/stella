import { expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

test("validator identity follows aliases and leaves presence and digest checks intact", async () => {
  const rejected = [
    'const source = { ETag: "a" }; const copy = { ETag: "b" }; void (source.ETag === copy.ETag);',
    'const source = { etag: "a" }; void (source["etag"] !== "b");',
    'const source = { ETag: "a" }; const first = source.ETag; const second = first; void (second === "b");',
    'const source = { ETag: "a" }; const { ETag: renamed } = source; void (renamed === "b");',
    'const source = { ETag: "a" }; let renamed; renamed = source.ETag; void (renamed === "b");',
    'const source = { ETag: "a" }; const value = source.ETag ?? ""; void (value === "b");',
    'const source = { ETag: "a" }; const value = condition ? source.ETag : ""; void (value === "b");',
    'const source = { ETag: "a" }; void (source.ETag.replaceAll("a", "") === "b");',
    'void (headers.get("ETag") === "b");',
    'const source = { ETag: "a" }; void (String(source.ETag) === "b");',
    'const source = { ContentMD5: "a" }; void (source.ContentMD5 === "b");',
    'const source = { ETag: "a" }; const renamed = source.ETag + ""; void (renamed === "b");',
    'function verify({ ETag: renamed }) { return renamed === "b"; }',
  ];
  const accepted = [
    'const source = { ETag: "a" }; void (source.ETag === null);',
    'const source = { ETag: "a" }; void (source.ETag !== undefined);',
    'const source = { ETag: "a" }; void (source.ETag !== "");',
    'const source = { ETag: "a" }; headers.set("If-Match", source.ETag);',
    "void (sourceSha256 === copySha256);",
    'void (languageTag === "en");',
    'const source = { unrelated: "a" }; const { unrelated: renamed } = source; void (renamed === "b");',
  ];
  const lines = [...rejected, ...accepted].map((source) => `{ ${source} }`);
  expect(
    await lintSingleRule("no-etag-content-identity", lines.join("\n"), {
      plugin: "s3-object-boundary",
    }),
  ).toEqual(rejected.map((_, index) => index + 1));
});
