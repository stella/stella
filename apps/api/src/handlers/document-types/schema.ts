import * as v from "valibot";

import { resourceIdSchema } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

// `key` is never accepted from the client: it is derived from the label on
// create and immutable thereafter, so playbook scopes that reference it never
// orphan. Only `label` (and, via reorder, `sortOrder`) are user-editable.

export const documentTypeParamsSchema = v.object({
  documentTypeId: resourceIdSchema("documentType"),
});

export const createDocumentTypeBodySchema = v.object({
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});

export const updateDocumentTypeBodySchema = v.object({
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});

export const reorderDocumentTypesBodySchema = v.object({
  orderedIds: v.pipe(
    v.array(resourceIdSchema("documentType")),
    v.maxLength(LIMITS.documentTypesCount),
  ),
});
