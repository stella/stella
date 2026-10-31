import * as v from "valibot";

import {
  DECISION_HEADNOTE_KEYWORDS,
  type DecisionHeadnotePreview,
  TEXT_ABSENCE_REASONS,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";

import { LIMITS } from "@/api/lib/limits";
import { boundedString } from "@/api/lib/search/response-text-bounds";

type DecisionHeadnoteSchemaByType = {
  readonly [Type in DecisionHeadnotePreview["type"]]: v.GenericSchema<
    unknown,
    Extract<DecisionHeadnotePreview, { readonly type: Type }>
  >;
};

const headnoteTextSchema = v.pipe(
  boundedString(LIMITS.caseLawHeadnoteMaxChars * 4),
  v.minLength(1),
);

const DECISION_HEADNOTE_SCHEMAS = {
  [TEXT_FIELD_TYPE.ABSENT]: v.pipe(
    v.object({
      type: v.literal(TEXT_FIELD_TYPE.ABSENT),
      reason: v.picklist(TEXT_ABSENCE_REASONS),
    }),
    v.readonly(),
  ),
  [TEXT_FIELD_TYPE.PRESENT]: v.pipe(
    v.object({
      type: v.literal(TEXT_FIELD_TYPE.PRESENT),
      text: headnoteTextSchema,
      truncated: v.boolean(),
    }),
    v.readonly(),
  ),
  [DECISION_HEADNOTE_KEYWORDS]: v.pipe(
    v.object({
      type: v.literal(DECISION_HEADNOTE_KEYWORDS),
      // The terms share the prose budget: a row is one row either way.
      items: v.pipe(
        v.array(headnoteTextSchema),
        v.minLength(1),
        v.maxLength(LIMITS.caseLawHeadnoteKeywords),
        v.readonly(),
      ),
      omitted: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
    v.readonly(),
  ),
} as const satisfies DecisionHeadnoteSchemaByType;

// The branches are closed and exhaustively keyed by the shared discriminator,
// so the union's output is `DecisionHeadnotePreview` itself.
export const decisionHeadnotePreviewSchema = v.union([
  DECISION_HEADNOTE_SCHEMAS.absent,
  DECISION_HEADNOTE_SCHEMAS.present,
  DECISION_HEADNOTE_SCHEMAS.keywords,
]);

export const decisionKeywordsPreviewSchema = DECISION_HEADNOTE_SCHEMAS.keywords;
