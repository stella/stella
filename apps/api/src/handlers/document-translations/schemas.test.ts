import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { createDocumentTranslationRunBodySchema } from "@/api/handlers/document-translations/schemas";
import { DOCUMENT_TRANSLATION_COMMENT_POLICIES } from "@/api/lib/document-translation/contract";

const BASE_REQUEST = {
  entityId: "00000000-0000-4000-8000-000000000001",
  fieldId: "00000000-0000-4000-8000-000000000002",
  output: "translated",
  engine: "ai",
  targetLang: "de",
} as const;

describe("document translation request boundary", () => {
  test("leaves comment policy optional and accepts every declared policy", () => {
    expect(
      Value.Check(createDocumentTranslationRunBodySchema, BASE_REQUEST),
    ).toBe(true);
    for (const commentPolicy of DOCUMENT_TRANSLATION_COMMENT_POLICIES) {
      expect(
        Value.Check(createDocumentTranslationRunBodySchema, {
          ...BASE_REQUEST,
          commentPolicy,
        }),
      ).toBe(true);
    }
    expect(
      Value.Check(createDocumentTranslationRunBodySchema, {
        ...BASE_REQUEST,
        commentPolicy: "unknown",
      }),
    ).toBe(false);
  });
});
