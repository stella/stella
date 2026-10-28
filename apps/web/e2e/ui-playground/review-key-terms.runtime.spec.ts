import { expect, test } from "@playwright/test";

import {
  PHRASE_RANGE_CASES,
  PHRASE_REGEX_CASES,
} from "../../src/components/ai-suggestions/review-key-terms.test-fixtures";
import type * as ReviewMatcherFixture from "../fixtures/review-key-terms.fixture";

test("browser WASM review matching preserves the native scalar contract", async ({
  page,
}) => {
  await page.goto("/dev?visual=control-sizes", {
    waitUntil: "domcontentloaded",
  });
  const result = await page.evaluate(async (moduleUrl) => {
    const fixture: typeof ReviewMatcherFixture = await import(moduleUrl);
    return fixture.checkReviewMatchers();
  }, "/e2e/fixtures/review-key-terms.fixture.ts");
  expect(result.phrases).toHaveLength(PHRASE_RANGE_CASES.length);
  for (const phrase of result.phrases) {
    expect(phrase.actual).toEqual(phrase.expected);
    expect(phrase.actual).toEqual(phrase.oracle);
    expect(phrase.reconstructed).toBe(phrase.text);
  }
  expect(result.regexes).toHaveLength(PHRASE_REGEX_CASES.length);
  for (const regex of result.regexes) {
    expect(regex.actual).toEqual(regex.expected);
    expect(regex.replacement).toBe(regex.expectedReplacement);
  }
  expect(result.whitespaceMismatches).toEqual([]);
});
