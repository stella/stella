import { afterEach, expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import {
  cachedVocabularyIndexCount,
  fitGroqPrompt,
  forgetOrganizationVocabularyIndexes,
  rememberVocabularyIndex,
} from "@/api/lib/dictation/organization-vocabulary";
import { buildVocabularyIndex } from "@/api/lib/dictation/vocabulary-index";

afterEach(() => {
  forgetOrganizationVocabularyIndexes();
});

test("organizations without words leave nothing in the cache", () => {
  for (let organization = 0; organization < 50; organization += 1) {
    rememberVocabularyIndex(createSafeId<"organization">(), {
      version: "0:",
      index: buildVocabularyIndex([]),
    });
  }
  expect(cachedVocabularyIndexCount()).toBe(0);
});

test("a list emptied since it was cached drops its index", () => {
  const organizationId = createSafeId<"organization">();
  rememberVocabularyIndex(organizationId, {
    version: "1:2026-11-20T00:00:00.000Z",
    index: buildVocabularyIndex(["Novák"]),
  });
  expect(cachedVocabularyIndexCount()).toBe(1);
  rememberVocabularyIndex(organizationId, {
    version: "0:",
    index: buildVocabularyIndex([]),
  });
  expect(cachedVocabularyIndexCount()).toBe(0);
});

const promptTokens = (terms: readonly string[]) =>
  Math.ceil(Array.from(terms.join(", ")).length / 3);

test("organization words fill only the Groq prompt's token budget", () => {
  const own = ["Novák"];
  const organization = Array.from(
    { length: 100 },
    (_, index) => `Advokátní kancelář číslo ${index} s ručením omezeným`,
  );
  const fitted = fitGroqPrompt(own, [...own, ...organization]);
  expect(fitted[0]).toBe("Novák");
  expect(fitted.length).toBeGreaterThan(1);
  expect(fitted.length).toBeLessThan(organization.length);
  expect(promptTokens(fitted)).toBeLessThanOrEqual(200);
});

test("the request's own words are kept as they came", () => {
  const own = Array.from({ length: 80 }, (_, index) => `slovo-${index}-navíc`);
  const fitted = fitGroqPrompt(own, [...own, "Deloitte"]);
  expect(fitted).toEqual(own);
});

test("short organization words all fit", () => {
  expect(fitGroqPrompt([], ["KPMG", "Novák", "EY"])).toEqual([
    "KPMG",
    "Novák",
    "EY",
  ]);
});
