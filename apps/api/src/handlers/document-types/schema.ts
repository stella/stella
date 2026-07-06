import { t } from "elysia";

import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

// `key` is never accepted from the client: it is derived from the label on
// create and immutable thereafter, so playbook scopes that reference it never
// orphan. Only `label` (and, via reorder, `sortOrder`) are user-editable.

export const documentTypeParamsSchema = t.Object({
  documentTypeId: tSafeId("documentType"),
});

export const createDocumentTypeBodySchema = t.Object({
  label: t.String({ minLength: 1, maxLength: 256 }),
});

export const updateDocumentTypeBodySchema = t.Object({
  label: t.String({ minLength: 1, maxLength: 256 }),
});

export const reorderDocumentTypesBodySchema = t.Object({
  orderedIds: t.Array(tSafeId("documentType"), {
    maxItems: LIMITS.documentTypesCount,
  }),
});
