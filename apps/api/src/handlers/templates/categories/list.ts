import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { listTemplateCategoriesHandler } from "../categories";

const config = {
  description:
    "List the organization's template categories with their parents, " +
    "descriptions, and sort order, enough to render the whole tree. The set " +
    "is bounded per organization and returned whole, without a cursor.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  access: "read",
} satisfies HandlerConfig;

const listTemplateCategories = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await listTemplateCategoriesHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
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

export default listTemplateCategories;
