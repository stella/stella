import * as v from "valibot";

import { DOCUMENT_TRANSLATION_TARGET_LANGUAGES } from "@stll/api-contract/document-translation";

import { resourceIdSchema } from "@/api/lib/custom-schema";
import {
  DOCUMENT_TRANSLATION_COMMENT_POLICIES,
  DOCUMENT_TRANSLATION_ENGINE,
  DOCUMENT_TRANSLATION_OUTPUT,
  type DocumentTranslationCommentPolicy,
} from "@/api/lib/document-translation/contract";

const targetLanguageCode = v.picklist([
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

const optionalCommentPolicySchema = v.optional(
  v.union([
    v.literal(COMMENT_POLICY_SCHEMA_VALUES[0]),
    v.literal(COMMENT_POLICY_SCHEMA_VALUES[1]),
    v.literal(COMMENT_POLICY_SCHEMA_VALUES[2]),
  ]),
);

const commonRunProperties = {
  entityId: resourceIdSchema("entity"),
  fieldId: resourceIdSchema("field"),
  commentPolicy: optionalCommentPolicySchema,
  targetLang: targetLanguageCode,
};

export const prepareDocumentTranslationBodySchema = v.object({
  entityId: resourceIdSchema("entity"),
  fieldId: resourceIdSchema("field"),
});

export const createDocumentTranslationRunBodySchema = v.union([
  v.strictObject({
    ...commonRunProperties,
    engine: v.literal(DOCUMENT_TRANSLATION_ENGINE.DEEPL),
    output: v.literal(DOCUMENT_TRANSLATION_OUTPUT.TRANSLATED),
  }),
  v.strictObject({
    ...commonRunProperties,
    engine: v.literal(DOCUMENT_TRANSLATION_ENGINE.AI),
    output: v.union([
      v.literal(DOCUMENT_TRANSLATION_OUTPUT.TRANSLATED),
      v.literal(DOCUMENT_TRANSLATION_OUTPUT.BILINGUAL),
    ]),
    entityVersionId: resourceIdSchema("entityVersion"),
  }),
]);
