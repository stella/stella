import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects raw canonical and crawler policy metadata", async () => {
  expect(
    await lintSingleRule(
      "no-raw-public-law-seo",
      'const link = { rel: "canonical" };\nconst policy = { name: "robots" };',
    ),
  ).toEqual([1, 2]);
});

test("rejects Open Graph and Twitter metadata literals", async () => {
  expect(
    await lintSingleRule(
      "no-raw-public-law-seo",
      'const title = "og:title";\nconst card = "twitter:card";',
    ),
  ).toEqual([1, 2]);
});

test("rejects interpolated Open Graph metadata", async () => {
  expect(
    await lintSingleRule(
      "no-raw-public-law-seo",
      `const property = \`og:\${field}\`;`,
    ),
  ).toEqual([1]);
});

test("accepts metadata built through the shared head owner", async () => {
  expect(
    await lintSingleRule(
      "no-raw-public-law-seo",
      'const head = createPublicLawHead({ title: "Act", description: "Law" });',
    ),
  ).toEqual([]);
});

test("accepts unrelated metadata names", async () => {
  expect(
    await lintSingleRule(
      "no-raw-public-law-seo",
      'const names = ["description", "canonicalName", "robotics", "title"];',
    ),
  ).toEqual([]);
});
