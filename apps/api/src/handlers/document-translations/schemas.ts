import { t } from "elysia";

import {
  DOCUMENT_TRANSLATION_SOURCE_LANGUAGES,
  DOCUMENT_TRANSLATION_TARGET_LANGUAGES,
} from "@stll/api-contract/document-translation";

import { tSafeId } from "@/api/lib/custom-schema";
import {
  DOCUMENT_TRANSLATION_COMMENT_POLICIES,
  DOCUMENT_TRANSLATION_ENGINE,
  DOCUMENT_TRANSLATION_OUTPUT,
  type DocumentTranslationCommentPolicy,
} from "@/api/lib/document-translation/contract";

const languageCode = t.String({ minLength: 2, maxLength: 16 });
const sourceLanguageCode = t.UnionEnum([
  DOCUMENT_TRANSLATION_SOURCE_LANGUAGES[0].code,
  ...DOCUMENT_TRANSLATION_SOURCE_LANGUAGES.slice(1).map(({ code }) => code),
]);
const targetLanguageCode = t.UnionEnum([
  DOCUMENT_TRANSLATION_TARGET_LANGUAGES[0].code,
  ...DOCUMENT_TRANSLATION_TARGET_LANGUAGES.slice(1).map(({ code }) => code),
]);

const COMMENT_POLICY_SCHEMA_VALUES = [
  DOCUMENT_TRANSLATION_COMMENT_POLICIES[0],
  DOCUMENT_TRANSLATION_COMMENT_POLICIES[1],
  DOCUMENT_TRANSLATION_COMMENT_POLICIES[2],
] as const satisfies readonly DocumentTranslationCommentPolicy[];

type MissingCommentPolicySchemaValue = Exclude<
  DocumentTranslationCommentPolicy,
  (typeof COMMENT_POLICY_SCHEMA_VALUES)[number]
>;

true satisfies MissingCommentPolicySchemaValue extends never ? true : never;

// Keep the literal union: Elysia coerces an absent Optional(UnionEnum) field
// to the enum's first member instead of leaving it undefined.
const optionalCommentPolicySchema = t.Optional(
  t.Union([
    t.Literal(COMMENT_POLICY_SCHEMA_VALUES[0]),
    t.Literal(COMMENT_POLICY_SCHEMA_VALUES[1]),
    t.Literal(COMMENT_POLICY_SCHEMA_VALUES[2]),
  ]),
);

const commonRunProperties = {
  entityId: tSafeId("entity"),
  fieldId: tSafeId("field"),
  commentPolicy: optionalCommentPolicySchema,
  targetLang: targetLanguageCode,
};

export const prepareDocumentTranslationBodySchema = t.Object({
  entityId: tSafeId("entity"),
  fieldId: tSafeId("field"),
});

export const createDocumentTranslationRunBodySchema = t.Union([
  t.Object({
    ...commonRunProperties,
    engine: t.Literal(DOCUMENT_TRANSLATION_ENGINE.DEEPL),
    output: t.Literal(DOCUMENT_TRANSLATION_OUTPUT.TRANSLATED),
    sourceLang: t.Optional(languageCode),
  }),
  t.Object({
    ...commonRunProperties,
    engine: t.Literal(DOCUMENT_TRANSLATION_ENGINE.AI),
    output: t.Union([
      t.Literal(DOCUMENT_TRANSLATION_OUTPUT.TRANSLATED),
      t.Literal(DOCUMENT_TRANSLATION_OUTPUT.BILINGUAL),
    ]),
    sourceLang: sourceLanguageCode,
    entityVersionId: tSafeId("entityVersion"),
  }),
]);
