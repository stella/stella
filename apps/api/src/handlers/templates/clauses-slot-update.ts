import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { updateClauseSlotHandler } from "@/api/lib/template-clause-links";

const updateClauseSlotParamsSchema = t.Object({
  templateId: tSafeId("template"),
  linkId: tSafeId("templateClause"),
});

const updateClauseSlotBodySchema = t.Object({
  slotName: t.Nullable(t.String({ maxLength: 128 })),
});

const config = {
  description:
    "Assign one clause link of a template to a named clause slot, or clear " +
    "the assignment by passing null. The clause, its pinned version, and its " +
    "variant are untouched: only which slot the link fills changes.",
  permissions: { template: ["update"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
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
