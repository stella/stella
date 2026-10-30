import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";
import { HTTP_REQUEST_BODY_MAX_BYTES } from "@stll/api-contract/limits";
import { READER_ANSWER_QUESTION_MAX_LENGTH } from "@stll/api-contract/reader-answers";

import {
  paginationCursorSchema,
  paginationLimitSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";

const modelOptions = {
  modelId: v.exactOptional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  ),
};
const locale = v.pipe(
  v.string(),
  v.minLength(2),
  v.maxLength(35),
  v.regex(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/u),
);
const question = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(READER_ANSWER_QUESTION_MAX_LENGTH),
);
const createFields = {
  ...modelOptions,
  decisionId: resourceIdSchema("caseLawDecision"),
  locale: v.exactOptional(locale),
  // Each quote code unit and span consumes at least one JSON wire byte, so
  // these transport-derived bounds admit every selection the server can read.
  // Every span must also match its paragraph before anything is stored.
  anchor: v.strictObject({
    spans: v.pipe(
      v.array(
        v.strictObject({
          paragraphId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
          quote: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(HTTP_REQUEST_BODY_MAX_BYTES),
          ),
          startOffset: v.pipe(v.number(), v.integer(), v.minValue(0)),
          endOffset: v.pipe(v.number(), v.integer(), v.minValue(1)),
        }),
      ),
      v.minLength(1),
      v.maxLength(HTTP_REQUEST_BODY_MAX_BYTES),
    ),
  }),
};

export const createAnswerBodySchema = v.union([
  v.strictObject({ ...createFields, kind: v.literal("ask"), question }),
  v.strictObject({ ...createFields, kind: v.literal("explain") }),
]);
export const followUpBodySchema = v.strictObject({
  ...modelOptions,
  locale: v.exactOptional(locale),
  question,
});
export const regenerateBodySchema = v.strictObject({
  ...modelOptions,
  locale: v.exactOptional(locale),
});
export const answerParamsSchema = v.object({
  answerId: resourceIdSchema("legalReaderAnswer"),
});
export const answerVisibilityBodySchema = v.object({
  visibility: v.picklist(["private", "shared"]),
});
export const listAnswersQuerySchema = v.object({
  decisionId: resourceIdSchema("caseLawDecision"),
  cursor: v.exactOptional(paginationCursorSchema()),
  limit: v.exactOptional(numberFromString(paginationLimitSchema(50))),
});
