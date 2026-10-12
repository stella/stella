import { t } from "elysia";

import {
  READER_ANSWER_QUESTION_MAX_LENGTH,
  READER_ANSWER_QUOTE_MAX_LENGTH,
} from "@stll/api-contract/reader-answers";

import {
  tPaginationCursor,
  tPaginationLimit,
  tSafeId,
} from "@/api/lib/custom-schema";

const modelOptions = {
  modelId: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
};
const locale = t.String({
  minLength: 2,
  maxLength: 35,
  pattern: "^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$",
});
const question = t.String({
  minLength: 1,
  maxLength: READER_ANSWER_QUESTION_MAX_LENGTH,
});
const createFields = {
  ...modelOptions,
  decisionId: tSafeId("caseLawDecision"),
  locale,
  anchor: t.Object({
    paragraphId: t.String({ minLength: 1, maxLength: 64 }),
    quote: t.String({
      minLength: 1,
      maxLength: READER_ANSWER_QUOTE_MAX_LENGTH,
    }),
    startOffset: t.Integer({ minimum: 0 }),
    endOffset: t.Integer({ minimum: 1 }),
  }),
};

export const createAnswerBodySchema = t.Union([
  t.Object(
    { ...createFields, kind: t.Literal("ask"), question },
    { additionalProperties: false },
  ),
  t.Object(
    { ...createFields, kind: t.Literal("explain") },
    { additionalProperties: false },
  ),
]);
export const followUpBodySchema = t.Object(
  { ...modelOptions, locale, question },
  { additionalProperties: false },
);
export const regenerateBodySchema = t.Object(
  { ...modelOptions, locale },
  { additionalProperties: false },
);
export const answerParamsSchema = t.Object({
  answerId: tSafeId("legalReaderAnswer"),
});
export const answerVisibilityBodySchema = t.Object({
  visibility: t.Union([t.Literal("private"), t.Literal("shared")]),
});
export const listAnswersQuerySchema = t.Object({
  decisionId: tSafeId("caseLawDecision"),
  cursor: t.Optional(tPaginationCursor()),
  limit: t.Optional(tPaginationLimit(50)),
});
