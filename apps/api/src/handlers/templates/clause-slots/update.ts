import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { updateClauseSlotHandler } from "@/api/lib/template-clause-links";

const updateClauseSlotParamsSchema = v.object({
  templateId: resourceIdSchema("template"),
  linkId: resourceIdSchema("templateClause"),
});

const updateClauseSlotBodySchema = v.object({
  slotName: v.nullable(v.pipe(v.string(), v.maxLength(128))),
});

const config = {
  contract: "patch",
  description:
    "Assign one clause link of a template to a named clause slot, or clear " +
    "the assignment by passing null. The clause, its pinned version, and its " +
    "variant are untouched: only which slot the link fills changes.",
  permissions: { template: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  params: updateClauseSlotParamsSchema,
  body: updateClauseSlotBodySchema,
} satisfies HandlerConfig;

const updateTemplateClauseSlot = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params, body, recordAuditEvent }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await updateClauseSlotHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
            templateId: params.templateId,
            linkId: params.linkId,
            slotName: body.slotName,
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

export default updateTemplateClauseSlot;
