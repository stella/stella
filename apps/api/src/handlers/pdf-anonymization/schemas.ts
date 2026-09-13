import { t } from "elysia";

import { tSafeId } from "@/api/lib/custom-schema";

export const createPdfAnonymizationRunBodySchema = t.Object({
  entityId: tSafeId("entity"),
  fieldId: tSafeId("field"),
});
