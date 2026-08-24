import { t } from "elysia";

import { tSafeId } from "@/api/lib/custom-schema";
import {
  DOCUMENT_TRANSLATION_COMMENT_POLICIES,
  DOCUMENT_TRANSLATION_ENGINES,
  DOCUMENT_TRANSLATION_OUTPUTS,
  type DocumentTranslationCommentPolicy,
} from "@/api/lib/document-translation/contract";

const languageCode = t.String({ minLength: 2, maxLength: 16 });

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

export const createDocumentTranslationRunBodySchema = t.Object({
  entityId: tSafeId("entity"),
  fieldId: tSafeId("field"),
  output: t.UnionEnum(DOCUMENT_TRANSLATION_OUTPUTS),
  engine: t.UnionEnum(DOCUMENT_TRANSLATION_ENGINES),
  commentPolicy: optionalCommentPolicySchema,
  sourceLang: t.Optional(languageCode),
  targetLang: languageCode,
});
