import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import { t } from "elysia";

import {
  TEXT_ABSENCE_REASONS,
  TEXT_FIELD_TYPE,
  type DecisionHeadnotePreview,
} from "@stll/api-contract/case-law-text-field";

import { LIMITS } from "@/api/lib/limits";

type DecisionHeadnoteSchemaByType = {
  readonly [Type in DecisionHeadnotePreview["type"]]: TSchema & {
    static: Extract<DecisionHeadnotePreview, { readonly type: Type }>;
  };
};

const DECISION_HEADNOTE_SCHEMAS = {
  [TEXT_FIELD_TYPE.ABSENT]: t.Object(
    {
      type: t.Literal(TEXT_FIELD_TYPE.ABSENT),
      reason: t.UnionEnum(TEXT_ABSENCE_REASONS),
    },
    { additionalProperties: false },
  ),
  [TEXT_FIELD_TYPE.PRESENT]: t.Object(
    {
      type: t.Literal(TEXT_FIELD_TYPE.PRESENT),
      text: t.String({ maxLength: LIMITS.caseLawHeadnoteMaxChars }),
      truncated: t.Boolean(),
    },
    { additionalProperties: false },
  ),
} as const satisfies DecisionHeadnoteSchemaByType;

const decisionHeadnoteRuntimeSchema = t.Union([
  DECISION_HEADNOTE_SCHEMAS.absent,
  DECISION_HEADNOTE_SCHEMAS.present,
]);

// SAFETY: the runtime branches are closed and exhaustively keyed by the shared
// discriminator; Unsafe preserves their union instead of TypeBox's
// intersection-like inference for object unions.
export const decisionHeadnotePreviewSchema =
  Type.Unsafe<DecisionHeadnotePreview>(decisionHeadnoteRuntimeSchema);
