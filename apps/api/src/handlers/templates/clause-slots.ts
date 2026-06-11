/**
 * List the clause slots a template fills, each with its resolved `ClauseBody`,
 * so the fill form can show the clauses that will be inserted and offer a
 * per-fill AI adjustment before they are merged into the document. Mirrors the
 * slot discovery + resolution that {@link fillByIdHandler} runs server-side.
 */

import { Result } from "better-result";
import { t } from "elysia";

import { discoverClauseSlots } from "@/api/handlers/docx/discover-clause-slots";
import { resolveClauseSlotBodies } from "@/api/handlers/docx/resolve-clause-slots";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";

const clauseSlotsParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

const config = {
  permissions: { workspace: ["read"] },
  params: clauseSlotsParamsSchema,
} satisfies HandlerConfig;

const getTemplateClauseSlots = createSafeRootHandler(
  config,
  async function* ({ safeDb, scopedDb, session, params }) {
    const organizationId = session.activeOrganizationId;

    const template = yield* Result.await(
      safeDb((tx) =>
        tx.query.templates.findFirst({
          where: {
            id: { eq: params.templateId },
            organizationId: { eq: organizationId },
          },
          columns: { s3Key: true },
        }),
      ),
    );

    if (!template) {
      return Result.err(
        new HandlerError({ status: 404, message: "Template not found" }),
      );
    }

    const arrayBuf = await getS3().file(template.s3Key).arrayBuffer();
    const slots = await discoverClauseSlots(Buffer.from(arrayBuf));
    if (slots.length === 0) {
      return Result.ok({ slots: [] });
    }

    const bodies = await resolveClauseSlotBodies(
      params.templateId,
      slots,
      scopedDb,
      organizationId,
    );

    // Only slots that resolve to a linked clause are returned; unlinked slots
    // fill as unmatched placeholders and aren't editable here.
    const resolved = slots.flatMap((slot) => {
      const body = bodies[slot.patchKey];
      return body ? [{ patchKey: slot.patchKey, name: slot.name, body }] : [];
    });

    return Result.ok({ slots: resolved });
  },
);

export default getTemplateClauseSlots;
