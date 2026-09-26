/**
 * Live fill preview for clause slots.
 *
 * For a template, resolve each linked `{{ clause("Name") }}` slot to the PLAIN
 * TEXT of its linked clause (keyed by slot name) so the Studio Fill subtab
 * can substitute the clause body into the in-document preview, mirroring
 * what the download/fill path produces. Server-side resolution reuses the
 * fill path's version/variant rules (`resolveClauseSlotTexts`), so the
 * preview text matches the filled document.
 *
 * Unlinked slots (or slots whose target version cannot be resolved) are
 * omitted: the preview simply leaves their marker visible.
 */

import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { discoverClauseSlots } from "@/api/lib/docx/discover-clause-slots";
import { resolveClauseSlotTexts } from "@/api/lib/docx/resolve-clause-slots";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  readStoredTemplateFile,
  STORED_TEMPLATE_FILE_COLUMNS,
} from "@/api/lib/templates/stored-template-file";

const templateSlotPreviewParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

const config = {
  description:
    "Resolve one template's clause slots to the plain text of the clauses " +
    "linked to them, keyed by slot name, using the same version and variant " +
    "rules the fill path applies, so the preview matches the filled " +
    "document. Slots that are unlinked, or whose target version cannot be " +
    "resolved, are left out and keep their marker visible.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  access: "read",
  params: templateSlotPreviewParamsSchema,
} satisfies HandlerConfig;

const getTemplateClausePreview = createSafeRootHandler(
  config,
  async function* ({ safeDb, scopedDb, session, params }) {
    const organizationId = session.activeOrganizationId;
    const { templateId } = params;

    const template = yield* Result.await(
      safeDb((tx) =>
        tx.query.templates.findFirst({
          where: {
            id: { eq: templateId },
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
    const slotTexts = await resolveClauseSlotTexts(
      templateId,
      slots,
      scopedDb,
      organizationId,
    );

    return Result.ok({ slotTexts });
  },
);

export default getTemplateClausePreview;
