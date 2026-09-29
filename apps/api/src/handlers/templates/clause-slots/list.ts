/**
 * List the clause slots a template fills, each with its resolved `ClauseBody`,
 * so the fill form can show the clauses that will be inserted and offer a
 * per-fill AI adjustment before they are merged into the document. Mirrors the
 * slot discovery + resolution that `fillByIdLogic`
 * (`lib/templates/fill-by-id-logic.ts`) runs server-side.
 */

import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { discoverClauseSlots } from "@/api/lib/docx/discover-clause-slots";
import { resolveClauseSlotBodies } from "@/api/lib/docx/resolve-clause-slots";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  readStoredTemplateFile,
  STORED_TEMPLATE_FILE_COLUMNS,
} from "@/api/lib/templates/stored-template-file";

const clauseSlotsParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

const config = {
  description:
    "List the clause slots of one template together with the resolved body " +
    "of the clause linked to each, using the same resolution the fill path " +
    "runs, so a fill form can show what will be inserted and adjust it for " +
    "that fill. Slots with no linked clause are left out; those fill as " +
    "unmatched placeholders.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  access: "read",
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
          columns: { ...STORED_TEMPLATE_FILE_COLUMNS, fileName: true },
        }),
      ),
    );

    if (!template) {
      return Result.err(
        new HandlerError({ status: 404, message: "Template not found" }),
      );
    }

    const file = yield* Result.await(
      readStoredTemplateFile({
        safeDb,
        organizationId,
        row: template,
        fileName: template.fileName,
      }),
    );
    const slots = await discoverClauseSlots(file);
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
