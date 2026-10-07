import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { ANALYSIS_SYSTEM_PROMPTS, getSystemPrompt } from "./prompt-registry";

const WRITTEN_LANGUAGES = Object.keys(ANALYSIS_SYSTEM_PROMPTS);

// Near misses of every written code, derived from the registry so a new
// language is covered the moment it is added: case, region tags, padding,
// truncation, and the inherited keys a plain object lookup would answer.
const NEAR_MISSES = [
  ...WRITTEN_LANGUAGES.flatMap((language) => [
    language.toUpperCase(),
    `${language}-${language.toUpperCase()}`,
    `${language}_${language.toUpperCase()}`,
    ` ${language}`,
    `${language} `,
    language.slice(0, -1),
    `${language}x`,
  ]),
  ...Object.getOwnPropertyNames(Object.prototype),
];

describe("analysis prompt selection", () => {
  test("answers each written language with its own prompt", () => {
    for (const [language, prompt] of Object.entries(ANALYSIS_SYSTEM_PROMPTS)) {
      expect(getSystemPrompt(language).unwrap()).toBe(prompt);
    }
  });

  test("analysis-prompt-registry-refuses-every-unwritten-language", async () => {
    await assertProperty(
      "analysis-prompt-registry-refuses-every-unwritten-language",
      fc.property(
        fc.oneof(fc.string(), fc.constantFrom(...NEAR_MISSES)),
        (language) => {
          fc.pre(!Object.hasOwn(ANALYSIS_SYSTEM_PROMPTS, language));
          const prompt = getSystemPrompt(language);
          expect(Result.isError(prompt)).toBe(true);
          if (Result.isError(prompt)) {
            expect(prompt.error.language).toBe(language);
          }
        },
      ),
    );
  });
});
