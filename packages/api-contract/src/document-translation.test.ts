import { describe, expect, test } from "bun:test";

import {
  DOCUMENT_TRANSLATION_DEEPL_MIME_TYPES,
  DOCUMENT_TRANSLATION_SOURCE_LANGUAGES,
  DOCUMENT_TRANSLATION_TARGET_LANGUAGES,
  documentTranslationSourceForTarget,
  isDocumentTranslationDeepLSupportedMimeType,
  isDocumentTranslationSourceEligible,
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

describe("document translation source eligibility", () => {
  test("accepts every MIME type in the shared DeepL contract", () => {
    expect(
      DOCUMENT_TRANSLATION_DEEPL_MIME_TYPES.every((mimeType) =>
        isDocumentTranslationDeepLSupportedMimeType(mimeType),
      ),
    ).toBeTrue();
  });

  test("rejects unsupported and encrypted files", () => {
    expect(
      isDocumentTranslationSourceEligible({
        encrypted: false,
        mimeType: "application/octet-stream",
      }),
    ).toBeFalse();
    expect(
      isDocumentTranslationSourceEligible({
        encrypted: true,
        mimeType: DOCUMENT_TRANSLATION_DEEPL_MIME_TYPES[0],
      }),
    ).toBeFalse();
  });
});
