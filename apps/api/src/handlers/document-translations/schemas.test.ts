import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { createDocumentTranslationRunBodySchema } from "@/api/handlers/document-translations/schemas";
import { DOCUMENT_TRANSLATION_COMMENT_POLICIES } from "@/api/lib/document-translation/contract";

const ENTITY_ID = "00000000-0000-4000-8000-000000000001";
const FIELD_ID = "00000000-0000-4000-8000-000000000002";
const ENTITY_VERSION_ID = "00000000-0000-4000-8000-000000000003";

const common = {
  entityId: ENTITY_ID,
  fieldId: FIELD_ID,
  output: "translated",
  targetLang: "DE",
} as const;

describe("document translation run request boundary", () => {
  test("accepts DeepL provider auto-detection without a prepared version", () => {
    expect(
      Value.Check(createDocumentTranslationRunBodySchema, {
        ...common,
        engine: "deepl",
      }),
    ).toBeTrue();
  });

  test("accepts target-only AI translation with a prepared version", () => {
    expect(
      Value.Check(createDocumentTranslationRunBodySchema, {
        ...common,
        engine: "ai",
        entityVersionId: ENTITY_VERSION_ID,
      }),
    ).toBeTrue();
    expect(
      Value.Check(createDocumentTranslationRunBodySchema, {
        ...common,
        engine: "ai",
      }),
    ).toBeFalse();
  });

  test("does not accept a client-supplied source language", () => {
    expect(
      Value.Check(createDocumentTranslationRunBodySchema, {
        ...common,
        engine: "ai",
        sourceLang: "EN-GB",
        entityVersionId: ENTITY_VERSION_ID,
      }),
    ).toBeFalse();
    expect(
      Value.Check(createDocumentTranslationRunBodySchema, {
        ...common,
        engine: "deepl",
        sourceLang: "EN",
      }),
    ).toBeFalse();
  });

  test("leaves comment policy optional and accepts every declared policy", () => {
    const request = {
      ...common,
      engine: "ai",
      entityVersionId: ENTITY_VERSION_ID,
    } as const;
    expect(Value.Check(createDocumentTranslationRunBodySchema, request)).toBe(
      true,
    );
    for (const commentPolicy of DOCUMENT_TRANSLATION_COMMENT_POLICIES) {
      expect(
        Value.Check(createDocumentTranslationRunBodySchema, {
          ...request,
          commentPolicy,
        }),
      ).toBe(true);
    }
    expect(
      Value.Check(createDocumentTranslationRunBodySchema, {
        ...request,
        commentPolicy: "unknown",
      }),
    ).toBe(false);
  });
});
