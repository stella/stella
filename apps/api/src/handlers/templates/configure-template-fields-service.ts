/**
 * Apply a field-configuration overlay to an EXISTING template's manifest and
 * re-embed it in the stored DOCX. The document bytes' {{markers}} are never
 * touched: only the manifest field metadata (input type, options, who-fills,
 * date format, lookup, composite parts, dependent select, formula, hint,
 * required) is overlaid by path.
 *
 * Backs the MCP `configure_template_fields` tool. Mirrors save-document's
 * restore-by-path discipline (overlay merged onto the source manifest fields by
 * path) but stays in place: no new version, no marker re-discovery, just the
 * manifest re-embedded into the same stored object.
 */

import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import { templates, templateVersions } from "@/api/db/schema";
import { discoverTemplate } from "@/api/handlers/docx/discover-template";
import {
  mergeManifestWithDiscovery,
  readManifest,
  writeManifest,
} from "@/api/handlers/docx/template-manifest";
import type { FieldMeta, TemplateManifest } from "@/api/handlers/docx/types";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";

type ConfigureTemplateFieldsOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  /** FieldMeta overlay, keyed by path; merged onto the matching manifest field. */
  fields: FieldMeta[];
  recordAuditEvent: AuditRecorder;
};

/** The manifest after the overlay is applied, so the caller can echo the
 *  updated field list back to the agent without a second read. */
export type ConfiguredTemplate = {
  manifest: TemplateManifest;
};

export const configureTemplateFields = async function* ({
  safeDb,
  organizationId,
  templateId,
  fields,
  recordAuditEvent,
}: ConfigureTemplateFieldsOptions): SafeHandlerGenerator<ConfiguredTemplate> {
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
          manifest: true,
          currentVersion: true,
        },
      }),
    ),
  );

  if (!existing) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template not found" }),
    );
  }

  const buffer = Buffer.from(await getS3().file(existing.s3Key).arrayBuffer());

  // Prefer the manifest embedded in the stored DOCX; fall back to the DB column
  // and finally to a fresh discovery so a manifest-less raw upload can still be
  // configured. The marker bytes are left untouched throughout.
  const embedded = await readManifest(buffer);
  const baseManifest = embedded ?? existing.manifest ?? null;

  const baseFields: FieldMeta[] =
    baseManifest?.fields ??
    mergeManifestWithDiscovery(null, await discoverTemplate(buffer)).map(
      (f) => ({ path: f.path }),
    );

  const fieldPaths = new Set(baseFields.map((f) => f.path));
  const unknownPath = fields.find((f) => !fieldPaths.has(f.path));
  if (unknownPath) {
    return Result.err(
      new HandlerError({
        status: 400,
        message:
          `No field "${unknownPath.path}" in this template. ` +
          "Configure only paths that exist as {{markers}} (call " +
          "describe_template to list them).",
      }),
    );
  }

  const overlayByPath = new Map(fields.map((f) => [f.path, f]));
  const mergedFields: FieldMeta[] = [];
  for (const f of baseFields) {
    const override = overlayByPath.get(f.path);
    mergedFields.push(override ? { ...f, ...override } : f);
  }

  const manifest: TemplateManifest = {
    version: baseManifest?.version ?? 1,
    fields: mergedFields,
    conditions: baseManifest?.conditions ?? [],
  };

  // Re-embed the manifest into the same object; markers and every other part
  // of the DOCX are preserved by writeManifest.
  const updatedDocx = await writeManifest(buffer, manifest);
  await getS3().write(existing.s3Key, new Uint8Array(updatedDocx));

  yield* Result.await(
    safeDb(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${templateId}))`,
      );

      await tx
        .update(templates)
        .set({
          manifest,
          fieldCount: mergedFields.length,
          sizeBytes: updatedDocx.byteLength,
          updatedAt: new Date(),
        })
        .where(eq(templates.id, templateId));

      // Keep ONLY the current version row's manifest in sync so a later
      // save-document / fill reads the configured fields back; historical
      // versions stay immutable.
      await tx
        .update(templateVersions)
        .set({ manifest, fieldCount: mergedFields.length })
        .where(
          and(
            eq(templateVersions.templateId, templateId),
            eq(templateVersions.version, existing.currentVersion),
          ),
        );

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
        resourceId: templateId,
        workspaceId: null,
        changes: {
          fieldCount: { old: null, new: mergedFields.length },
        },
      });
    }),
  );

  return Result.ok({ manifest });
};
