import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects validator equality through members headers and helper normalization", async () => {
  expect(
    await lintSingleRule(
      "no-etag-content-identity",
      'source.ETag === copy.ETag;\nheaders.get("ETag") !== expected;\nString(source.ContentMD5) == contentHash;',
      { plugin: "s3-object-boundary" },
    ),
  ).toEqual([1, 2, 3]);
});

test("rejects local destructured and assigned validator aliases", async () => {
  expect(
    await lintSingleRule(
      "no-etag-content-identity",
      "const { ETag: first } = source;\nconst second = first;\nsecond === digest;\nlet assigned; assigned = source.ETag;\nassigned !== digest;",
      { plugin: "s3-object-boundary" },
    ),
  ).toEqual([3, 5]);
});

test("accepts validator presence checks preconditions and content digests", async () => {
  expect(
    await lintSingleRule(
      "no-etag-content-identity",
      'source.ETag === null;\nsource.ETag !== undefined;\nsource.ETag !== "";\nheaders.set("If-Match", source.ETag);\nsourceSha256 === copySha256;',
      { plugin: "s3-object-boundary" },
    ),
  ).toEqual([]);
});

test("keeps same named unrelated labels outside validator heuristics", async () => {
  expect(
    await lintSingleRule(
      "no-etag-content-identity",
      'languageTag === "en";\nconst { label: renamed } = source;\nrenamed === "title";',
      { plugin: "s3-object-boundary" },
    ),
  ).toEqual([]);
});
