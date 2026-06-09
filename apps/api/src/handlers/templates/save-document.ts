import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { templates, templateVersions } from "@/api/db/schema";
import { discoverTemplate } from "@/api/handlers/docx/discover-template";
import {
  mergeManifestWithDiscovery,
  readManifest,
  writeManifest,
} from "@/api/handlers/docx/template-manifest";
import type { FieldMeta, TemplateManifest } from "@/api/handlers/docx/types";
import { isTemplateManifest } from "@/api/handlers/docx/types";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS, LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const buildVersionS3Key = (
  organizationId: SafeId<"organization">,
  templateId: SafeId<"template">,
  version: number,
) => `${organizationId}/templates/${templateId}/v${version}.docx`;

const saveDocumentBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
  // Optional edited manifest (the Studio's field settings, conditions,
  // computed). When present it is the base manifest, so the editor's field
  // metadata is persisted without a separate binary re-embed round-trip.
  // t.Unknown() (not t.String()) because Elysia auto-parses JSON-looking
  // multipart fields into objects; the handler validates the shape below.
  manifest: t.Optional(t.Unknown()),
});

const saveDocumentParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

const config = {
  permissions: { template: ["update"] },
  params: saveDocumentParamsSchema,
  body: saveDocumentBodySchema,
} satisfies HandlerConfig;

// Persists a Folio-edited template body as a new immutable version. Folio
// preserves the embedded manifest + {{markers}} on round-trip; we still
// re-discover fields from the edited body and merge with the existing manifest
// so placeholders added/removed in the editor stay in sync with the fields.
const saveTemplateDocument = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, params, body, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const { templateId } = params;
    const { file, manifest: manifestJson } = body;

    // Parse the optional client manifest; ignore it if malformed and fall back
    // to the manifest embedded in the uploaded DOCX. Elysia may hand us either
    // the raw JSON string or an already-parsed object, so handle both.
    let clientManifest: TemplateManifest | undefined;
    if (manifestJson !== undefined) {
      let candidate: unknown = manifestJson;
      if (typeof manifestJson === "string") {
        const parsed = Result.try((): unknown => JSON.parse(manifestJson));
        candidate = Result.isError(parsed) ? undefined : parsed.value;
      }
      if (isTemplateManifest(candidate)) {
        clientManifest = candidate;
      }
    }

    if (file.type !== DOCX_MIME_TYPE) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid file type. Expected a DOCX file.",
        }),
      );
    }

    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.templates.findFirst({
          where: {
            id: { eq: templateId },
            organizationId: { eq: organizationId },
          },
          columns: {
            id: true,
            s3Key: true,
            currentVersion: true,
            manifest: true,
          },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Template not found" }),
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const [discovered, embeddedManifest] = await Promise.all([
      discoverTemplate(buffer),
      readManifest(buffer),
    ]);

    const baseManifest =
      clientManifest ?? embeddedManifest ?? existing.manifest;
    const fields = mergeManifestWithDiscovery(baseManifest, discovered);
    const fieldMetas: FieldMeta[] = fields.map((f) => ({
      path: f.path,
      label: f.label,
      inputType: f.inputType,
      options: f.options,
      validation: f.validation,
      required: f.required,
    }));

    const manifest: TemplateManifest = {
      version: baseManifest?.version ?? 1,
      fields: fieldMetas,
      conditions: baseManifest?.conditions ?? [],
      computed: baseManifest?.computed ?? [],
    };

    // Re-embed the merged manifest so the stored DOCX stays in sync with the DB.
    const updatedDocx = await writeManifest(buffer, manifest);

    const newVersion = existing.currentVersion + 1;
    const versionS3Key = buildVersionS3Key(
      organizationId,
      templateId,
      newVersion,
    );

    // Write to the version-specific key outside the transaction to keep it short.
    await getS3().write(versionS3Key, new Uint8Array(updatedDocx));

    // Advisory lock + version count + update + insert in one transaction to
    // prevent TOCTOU on the per-template version limit.
    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${templateId}))`,
        );

        const versionCount = await tx.$count(
          templateVersions,
          eq(templateVersions.templateId, templateId),
        );

        if (versionCount >= LIMITS.templateVersionsPerTemplate) {
          return { ok: false as const };
        }

        const [row] = await tx
          .update(templates)
          .set({
            manifest,
            fieldCount: manifest.fields.length,
            sizeBytes: updatedDocx.byteLength,
            s3Key: versionS3Key,
            currentVersion: newVersion,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(templates.id, templateId),
              eq(templates.organizationId, organizationId),
            ),
          )
          .returning({
            id: templates.id,
            name: templates.name,
            fieldCount: templates.fieldCount,
            updatedAt: templates.updatedAt,
          });

        await tx.insert(templateVersions).values({
          id: createSafeId<"templateVersion">(),
          organizationId,
          templateId,
          version: newVersion,
          s3Key: versionS3Key,
          manifest,
          fieldCount: manifest.fields.length,
          createdBy: user.id,
        });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
          resourceId: templateId,
          workspaceId: null,
          changes: {
            currentVersion: { old: existing.currentVersion, new: newVersion },
            s3Key: { old: existing.s3Key, new: versionS3Key },
            fieldCount: { old: null, new: manifest.fields.length },
          },
        });

        return { ok: true as const, row };
      }),
    );

    if (!txResult.ok) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Version limit reached for this template",
        }),
      );
    }

    return Result.ok(txResult.row);
  },
);

export default saveTemplateDocument;
