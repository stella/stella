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

import type { SafeDb } from "@/api/db/safe-db";
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
        },
      }),
    ),
  );

  if (!existing) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template not found" }),
    );
  }

  // All S3 I/O (read the stored DOCX, re-embed the manifest, write it back) and
  // the row updates happen under the advisory lock, after re-reading s3Key /
  // currentVersion fresh. Reading the buffer and writing it back *outside* the
  // lock let a concurrent save-document commit a new vN+1 (a fresh per-version
  // s3Key) between this read and write, so the manifest would be embedded into
  // the now-stale object while templates.s3Key points elsewhere, diverging the
  // DB manifest from the bytes the row references. Mirrors save-document.ts.
  const txResult = yield* Result.await(
    safeDb(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${templateId}))`,
      );

      // Re-read under the lock: a concurrent save that already committed will
      // have bumped currentVersion and rotated s3Key, so both are read fresh.
      const [locked] = await tx
        .select({
          s3Key: templates.s3Key,
          manifest: templates.manifest,
          currentVersion: templates.currentVersion,
        })
        .from(templates)
        .where(
          and(
            eq(templates.id, templateId),
            eq(templates.organizationId, organizationId),
          ),
        );
      if (!locked) {
        return { ok: false as const, reason: "not-found" as const };
      }

      const buffer = Buffer.from(
        await getS3().file(locked.s3Key).arrayBuffer(),
      );

      // Prefer the manifest embedded in the stored DOCX; fall back to the DB
      // column and finally to a fresh discovery so a manifest-less raw upload
      // can still be configured. The marker bytes are left untouched throughout.
      const embedded = await readManifest(buffer);
      const baseManifest = embedded ?? locked.manifest ?? null;

      const baseFields: FieldMeta[] =
        baseManifest?.fields ??
        mergeManifestWithDiscovery(null, await discoverTemplate(buffer)).map(
          (f) => ({ path: f.path }),
        );

      const fieldPaths = new Set(baseFields.map((f) => f.path));
      const unknownPath = fields.find((f) => !fieldPaths.has(f.path));
      if (unknownPath) {
        return {
          ok: false as const,
          reason: "unknown-path" as const,
          path: unknownPath.path,
        };
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
      };

      // Re-embed the manifest into the locked object; markers and every other
      // part of the DOCX are preserved by writeManifest.
      const updatedDocx = await writeManifest(buffer, manifest);
      await getS3().write(locked.s3Key, new Uint8Array(updatedDocx));

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
            eq(templateVersions.version, locked.currentVersion),
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

      return { ok: true as const, manifest };
    }),
  );

  if (!txResult.ok) {
    if (txResult.reason === "not-found") {
      return Result.err(
        new HandlerError({ status: 404, message: "Template not found" }),
      );
    }
    return Result.err(
      new HandlerError({
        status: 400,
        message:
          `No field "${txResult.path}" in this template. ` +
          "Configure only paths that exist as {{markers}} (call " +
          "describe_template to list them).",
      }),
    );
  }

  return Result.ok({ manifest: txResult.manifest });
};
