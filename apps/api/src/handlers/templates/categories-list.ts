import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { listTemplateCategoriesHandler } from "./categories";

const config = {
  description:
    "List the organization's template categories with their parents, " +
    "descriptions, and sort order, enough to render the whole tree. The set " +
    "is bounded per organization and returned whole, without a cursor.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
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
