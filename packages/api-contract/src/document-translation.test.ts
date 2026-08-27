import { describe, expect, test } from "bun:test";

import {
  DOCUMENT_TRANSLATION_SOURCE_LANGUAGES,
  DOCUMENT_TRANSLATION_TARGET_LANGUAGES,
  documentTranslationSourceForTarget,
} from "./document-translation";

describe("document translation language contract", () => {
  test("maps every target variant to one supported source language", () => {
    const sourceCodes = new Set(
      DOCUMENT_TRANSLATION_SOURCE_LANGUAGES.map(({ code }) => code),
    );

    expect(
      DOCUMENT_TRANSLATION_TARGET_LANGUAGES.every(({ code }) =>
        sourceCodes.has(documentTranslationSourceForTarget(code)),
      ),
    ).toBeTrue();
  });

  test("keeps source and detector codes unique", () => {
    const sourceCodes = DOCUMENT_TRANSLATION_SOURCE_LANGUAGES.map(
      ({ code }) => code,
    );
    const detectorCodes = DOCUMENT_TRANSLATION_SOURCE_LANGUAGES.map(
      ({ detectorCode }) => detectorCode,
    );

    expect(new Set(sourceCodes).size).toBe(sourceCodes.length);
    expect(new Set(detectorCodes).size).toBe(detectorCodes.length);
  });
});
