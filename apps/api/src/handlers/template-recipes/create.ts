import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  createTemplateRecipeBodySchema,
  createTemplateRecipeHandler,
} from "./recipes";

const config = {
  description:
    "Create a template recipe, a named reusable block of pre-configured " +
    "template fields, from a name, an optional description, and a definition " +
    "object that is structurally validated before it is stored. Refused once " +
    "the organization holds its maximum number of recipes.",
  permissions: { template: ["create"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  body: createTemplateRecipeBodySchema,
} satisfies HandlerConfig;

const createTemplateRecipe = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, user, body, recordAuditEvent }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await createTemplateRecipeHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
            userId: user.id,
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

export default createTemplateRecipe;
