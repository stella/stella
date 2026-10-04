import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  createTemplateCategoryBodySchema,
  createTemplateCategoryHandler,
} from "../categories";

const config = {
  description:
    "Create a category in the organization's template category tree, " +
    "optionally under a parent category.",
  permissions: { template: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  body: createTemplateCategoryBodySchema,
} satisfies HandlerConfig;

const createTemplateCategory = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, body, recordAuditEvent }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await createTemplateCategoryHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
            body,
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

export default createTemplateCategory;
