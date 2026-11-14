import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";

import {
  updateTemplateCategoryBodySchema,
  updateTemplateCategoryHandler,
} from "../categories";

const updateTemplateCategoryParamsSchema = v.object({
  categoryId: resourceIdSchema("templateCategory"),
});

const config = {
  contract: "patch",
  description:
    "Rename or re-describe one template category, move it under a different " +
    "parent (or to the root by passing null), or change its sort order. Only " +
    "the fields you pass are written, and a move that would make the tree " +
    "circular is refused.",
  permissions: { template: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  params: updateTemplateCategoryParamsSchema,
  body: updateTemplateCategoryBodySchema,
} satisfies HandlerConfig;

const updateTemplateCategory = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params, body, recordAuditEvent }) {
    const result = yield* Result.await(
      updateTemplateCategoryHandler({
        scopedDb,
        organizationId: session.activeOrganizationId,
        categoryId: params.categoryId,
        body,
        recordAuditEvent,
      }),
    );
    return Result.ok(result);
  },
);

export default updateTemplateCategory;
