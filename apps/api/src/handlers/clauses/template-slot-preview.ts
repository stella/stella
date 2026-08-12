/**
 * Live fill preview for clause slots.
 *
 * For a template, resolve each linked `{{@clause:Name}}` slot to the PLAIN
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
import { readS3ArrayBuffer } from "@/api/lib/s3";

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
          columns: { s3Key: true },
        }),
      ),
    );

    if (!template) {
      return Result.err(
        new HandlerError({ status: 404, message: "Template not found" }),
      );
    }

    const arrayBuf = await readS3ArrayBuffer(template.s3Key);
    const slots = await discoverClauseSlots(Buffer.from(arrayBuf));
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
