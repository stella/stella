import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { buildTemplateCheckFindings } from "@/api/handlers/templates/check-template";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { deriveManifest } from "@/api/lib/docx/derived-manifest";
import { discoverClauseSlots } from "@/api/lib/docx/discover-clause-slots";
import { discoverTemplate } from "@/api/lib/docx/discover-template";
import { extractDocxDocument } from "@/api/lib/docx/extract-text";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { listTemplateClausesHandler } from "@/api/lib/template-clause-links";
import {
  readStoredTemplateFile,
  STORED_TEMPLATE_FILE_COLUMNS,
} from "@/api/lib/templates/stored-template-file";

const checkTemplateParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

type CheckTemplateProps = {
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
};

const checkTemplateHandler = async function* ({
  safeDb,
  scopedDb,
  organizationId,
  templateId,
}: CheckTemplateProps) {
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

  const [discovered, clauseSlots, extracted] = await Promise.all([
    discoverTemplate(file),
    discoverClauseSlots(file),
    extractDocxDocument(file),
  ]);
  const manifest = deriveManifest(discovered);

  const linksResult = yield* Result.await(
    Result.tryPromise({
      try: async () =>
        await listTemplateClausesHandler({
          scopedDb,
          organizationId,
          templateId,
        }),
      catch: (cause) =>
        new HandlerError({
          status: 500,
          message: "Failed to load linked clauses",
          cause,
        }),
    }),
  );

  // Ownership was already verified above; a 404 here means the template was
  // deleted mid-request, so report it as such.
  if (!("links" in linksResult)) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template not found" }),
    );
  }

  const findings = buildTemplateCheckFindings({
    discovered,
    manifest,
    clauseSlots,
    clauseLinks: linksResult.links,
    paragraphs: extracted.paragraphs.map((p) => p.text),
  });

  return Result.ok({ findings });
};

const config = {
  description:
    "Run the authoring checks over one stored template and return their " +
    "findings: broken marker structure and invalid markers, markers with no " +
    "manifest field and manifest fields with no marker, clause slots with no " +
    "linked clause and links with no slot, fields missing a label or input " +
    "type, selects with no options, and formulas or conditions referring to " +
    "unknown paths. Read-only: it reports, it never repairs.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  access: "read",
  params: checkTemplateParamsSchema,
} satisfies HandlerConfig;

const checkTemplate = createSafeRootHandler(
  config,
  async function* ({ safeDb, scopedDb, session, params }) {
    return yield* checkTemplateHandler({
      safeDb,
      scopedDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
    });
  },
);

export default checkTemplate;
