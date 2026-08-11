import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { deleteTemplateCategoryHandler } from "./categories";

const deleteTemplateCategoryParamsSchema = t.Object({
  categoryId: tSafeId("templateCategory"),
});

const config = {
  description:
    "Delete one category from the organization's template category tree. No " +
    "template is deleted: templates filed under the category become " +
    "uncategorized, and its child categories are promoted to its own parent.",
  permissions: { template: ["delete"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  params: deleteTemplateCategoryParamsSchema,
} satisfies HandlerConfig;

const deleteTemplateCategory = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params, recordAuditEvent }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await deleteTemplateCategoryHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
            categoryId: params.categoryId,
            recordAuditEvent,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Internal server error",
            cause,
          }),
      }),
    );
    return Result.ok(result);
  },
);

export default deleteTemplateCategory;
