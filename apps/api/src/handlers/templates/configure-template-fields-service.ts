/**
 * Apply a field-configuration overlay to an EXISTING template's manifest and
 * re-embed it in the stored DOCX. The document bytes' {{markers}} are never
 * touched: only the manifest field metadata (input type, options, who-fills,
 * date format, lookup, composite parts, dependent select, formula, hint,
 * required) is overlaid by path.
 *
 * Backs the MCP `configure_template_fields` tool. Mirrors save-document's
 * restore-by-path discipline (overlay merged onto the source manifest fields by
 * path) but stays on the same version: no new version, no marker re-discovery,
 * just the manifest re-embedded and stored under a fresh key the current
 * version's rows are repointed to.
 */

import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { templates, templateVersions } from "@/api/db/schema";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { discoverTemplate } from "@/api/lib/docx/discover-template";
import {
  lookupFormatMarkerPaths,
  mergeManifestWithDiscovery,
  readManifest,
  writeManifest,
} from "@/api/lib/docx/template-manifest";
import type { FieldMeta, TemplateManifest } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { deleteS3Keys } from "@/api/lib/files/utils";
import { logger } from "@/api/lib/observability/logger";
import { readS3ArrayBuffer, writeS3ObjectWithRetry } from "@/api/lib/s3";
import {
  applyFieldOverlay,
  fieldOverlayError,
  validateFieldOverlay,
} from "@/api/lib/templates/field-overlay";
import { buildTemplateRevisionS3Key } from "@/api/lib/templates/storage-keys";

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

  // All S3 I/O (read the stored DOCX, re-embed the manifest, store the result)
  // and the row updates happen under the advisory lock, after re-reading s3Key /
  // currentVersion fresh. Reading the buffer and writing the result *outside*
  // the lock let a concurrent save-document commit a new vN+1 (a fresh
  // per-version s3Key) between this read and write, so the manifest would be
  // embedded into the now-stale object while templates.s3Key points elsewhere,
  // diverging the DB manifest from the bytes the row references. Mirrors
  // save-document.ts.
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

      const buffer = Buffer.from(await readS3ArrayBuffer(locked.s3Key));

      // Prefer the manifest embedded in the stored DOCX; fall back to the DB
      // column and finally to a fresh discovery so a manifest-less raw upload
      // can still be configured. The marker bytes are left untouched throughout.
      const embedded = await readManifest(buffer);
      const discovered = await discoverTemplate(buffer);
      const baseManifest =
        embedded ??
        locked.manifest ??
        ({
          version: 1,
          fields: mergeManifestWithDiscovery(null, discovered).map((f) => ({
            path: f.path,
          })),
        } satisfies TemplateManifest);

      // The overlay is checked against the DOCX markers, not against the
      // manifest's current field list: a lookup root the marker scan only saw
      // as a namespace parent (`company` under `{{company.krs}}`) is a valid
      // path to configure even though no manifest entry names it yet.
      const issues = validateFieldOverlay({
        configured: baseManifest.fields,
        discovered,
        overlay: fields,
      });
      if (issues.length > 0) {
        return {
          ok: false as const,
          reason: "invalid-overlay" as const,
          issues,
        };
      }

      const overlaid = applyFieldOverlay(baseManifest, fields);
      // A lookup's format markers are renderings of its one resolved hit, so
      // any manifest entry standing for such a marker stops being a field the
      // moment the lookup that owns it is configured.
      const formatMarkers = lookupFormatMarkerPaths(overlaid.fields);
      const manifest: TemplateManifest = {
        version: overlaid.version,
        fields: overlaid.fields.filter(
          (field) => !formatMarkers.has(field.path),
        ),
      };

      // Re-embed the manifest into the bytes just read; markers and every other
      // part of the DOCX are preserved by writeManifest.
      const updatedDocx = await writeManifest(buffer, manifest);
      const updatedBytes = new Uint8Array(updatedDocx);

      // The result goes to a fresh key rather than over the object the rows
      // still point at: this transaction can still roll back after the write
      // (a later statement, a serialization failure), and an in-place overwrite
      // would leave the stored bytes carrying an overlay the rows never
      // recorded. Writing beside the current object leaves at worst an
      // unreferenced one. Same discipline as save-document.ts / update.ts,
      // which allocate a per-version key.
      const revisionS3Key = buildTemplateRevisionS3Key({
        contents: updatedBytes,
        organizationId,
        templateId,
        version: locked.currentVersion,
      });
      await writeS3ObjectWithRetry({ data: updatedBytes, key: revisionS3Key });

      await tx
        .update(templates)
        .set({
          manifest,
          fieldCount: manifest.fields.length,
          sizeBytes: updatedDocx.byteLength,
          s3Key: revisionS3Key,
          updatedAt: new Date(),
        })
        .where(eq(templates.id, templateId));

      // Keep ONLY the current version row in sync (its manifest and the key
      // holding the bytes that manifest is embedded in) so a later
      // save-document / fill / version download reads the configured fields
      // back; historical versions keep their own key and stay immutable.
      await tx
        .update(templateVersions)
        .set({
          manifest,
          fieldCount: manifest.fields.length,
          s3Key: revisionS3Key,
        })
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
          fieldCount: { old: null, new: manifest.fields.length },
          s3Key: { old: locked.s3Key, new: revisionS3Key },
        },
      });

      return {
        ok: true as const,
        manifest,
        // Reclaimed after the commit, not here: only a committed transaction
        // proves no row still names it. Identical bytes resolve to the same
        // key, in which case there is nothing to reclaim.
        supersededS3Key:
          locked.s3Key === revisionS3Key ? undefined : locked.s3Key,
      };
    }),
  );

  if (!txResult.ok) {
    if (txResult.reason === "not-found") {
      return Result.err(
        new HandlerError({ status: 404, message: "Template not found" }),
      );
    }
    return Result.err(fieldOverlayError(txResult.issues));
  }

  // The superseded object is referenced by no row once the transaction has
  // committed: template deletion discovers keys from templates.s3Key and the
  // template_versions rows only (handlers/templates/delete.ts), so leaving it
  // in place would strand it beyond the reach of every cleanup path. A failed
  // delete is not a failed configuration: the rows are already consistent, so
  // it is reported and the request still succeeds.
  if (txResult.supersededS3Key !== undefined) {
    const reclaimed = await deleteS3Keys([txResult.supersededS3Key]);
    if (Result.isError(reclaimed)) {
      logger.warn("templates.superseded_object_reclaim_failed", {
        "error.type": errorTag(reclaimed.error),
        templateId,
      });
    }
  }

  return Result.ok({ manifest: txResult.manifest });
};
