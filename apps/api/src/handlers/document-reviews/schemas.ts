import { t } from "elysia";
import type { Static } from "elysia";

import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const documentReviewRefSchema = t.Object({
  entityId: tSafeId("entity"),
  fileFieldId: tSafeId("field"),
});

export type DocumentReviewRef = Static<typeof documentReviewRefSchema>;

export const compareReferencesBodySchema = t.Object({
  target: documentReviewRefSchema,
  references: t.Array(documentReviewRefSchema, {
    minItems: 1,
    maxItems: LIMITS.documentReviewReferencesMax,
  }),
});
