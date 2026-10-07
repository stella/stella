import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { CS_SYSTEM_PROMPT } from "./cs";
import { DE_SYSTEM_PROMPT } from "./de";
import { EN_SYSTEM_PROMPT } from "./en";
import { PL_SYSTEM_PROMPT } from "./pl";
import { getSystemPrompt } from "./prompt-registry";
import { SK_SYSTEM_PROMPT } from "./sk";

const WRITTEN = {
  cs: CS_SYSTEM_PROMPT,
  de: DE_SYSTEM_PROMPT,
  en: EN_SYSTEM_PROMPT,
  pl: PL_SYSTEM_PROMPT,
  sk: SK_SYSTEM_PROMPT,
};

describe("analysis prompt selection", () => {
  test("answers each written language with its own prompt", () => {
    for (const [language, prompt] of Object.entries(WRITTEN)) {
      expect(getSystemPrompt(language).unwrap()).toBe(prompt);
    }
  });

  test("analysis-prompt-registry-refuses-every-unwritten-language", async () => {
    await assertProperty(
      "analysis-prompt-registry-refuses-every-unwritten-language",
      fc.property(
        fc.oneof(
          fc.string(),
          // Inherited object keys and near misses of the written codes.
          fc.constantFrom(
            "constructor",
            "__proto__",
            "toString",
            "hasOwnProperty",
            "CS",
            "cs-CZ",
            "ces",
            "fr",
          ),
        ),
        (language) => {
          fc.pre(!Object.hasOwn(WRITTEN, language));
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
