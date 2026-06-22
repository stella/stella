import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb, ScopedDb } from "@/api/db";
import { listTemplateClausesHandler } from "@/api/handlers/clauses/template-links";
import { discoverClauseSlots } from "@/api/handlers/docx/discover-clause-slots";
import { discoverTemplate } from "@/api/handlers/docx/discover-template";
import { readManifest } from "@/api/handlers/docx/template-manifest";
import { buildTemplateCheckFindings } from "@/api/handlers/templates/check-template";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";

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
        columns: { s3Key: true },
      }),
    ),
  );

  if (!template) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template not found" }),
    );
  }

  const buffer = Buffer.from(await getS3().file(template.s3Key).arrayBuffer());

  const [discovered, manifest, clauseSlots] = await Promise.all([
    discoverTemplate(buffer),
    readManifest(buffer),
    discoverClauseSlots(buffer),
  ]);

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
  });

  return Result.ok({ findings });
};

const config = {
  permissions: { workspace: ["read"] },
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
