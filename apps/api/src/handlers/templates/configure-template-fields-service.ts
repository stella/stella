/**
 * Apply a field-configuration overlay to an EXISTING template's manifest and
 * re-embed it in the stored DOCX. The document bytes' {{markers}} are never
 * touched: only the manifest field metadata (input type, options, who-fills,
 * date format, lookup, composite parts, dependent select, formula, hint,
 * required) is overlaid by path.
 *
 * Backs the MCP `save_template` configuration action. Mirrors save-document's
 * restore-by-path discipline (overlay merged onto the source manifest fields by
 * path) but stays on the same version: it re-embeds the manifest in the
 * current document bytes and republishes that version under a new key.
 */

import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { discoverTemplate } from "@/api/lib/docx/discover-template";
import {
  lookupFormatMarkerPaths,
  mergeManifestWithDiscovery,
  readManifest,
  writeManifest,
} from "@/api/lib/docx/template-manifest";
import type { FieldMeta, TemplateManifest } from "@/api/lib/docx/types";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import {
  applyFieldOverlay,
  fieldOverlayError,
  validateFieldOverlay,
} from "@/api/lib/templates/field-overlay";
import { writeStoredTemplate } from "@/api/lib/templates/write-template";

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
  const written = yield* Result.await(
    Result.gen(() =>
      writeStoredTemplate({
        safeDb,
        organizationId,
        templateId,
        mode: { type: "current-version" },
        recordAuditEvent,
        async prepare({ s3Key, manifest: currentManifest }) {
          const buffer = Buffer.from(await readS3ArrayBuffer(s3Key));
          const embedded = await readManifest(buffer);
          const discovered = await discoverTemplate(buffer);
          const baseManifest =
            embedded ??
            currentManifest ??
            ({
              version: 1,
              fields: mergeManifestWithDiscovery(null, discovered).map(
                (field) => ({
                  path: field.path,
                }),
              ),
            } satisfies TemplateManifest);
          const issues = validateFieldOverlay({
            configured: baseManifest.fields,
            discovered,
            overlay: fields,
          });
          if (issues.length > 0) {
            return Result.err(fieldOverlayError(issues));
          }

          const overlaid = applyFieldOverlay(baseManifest, fields);
          const formatMarkers = lookupFormatMarkerPaths(overlaid.fields);
          const manifest: TemplateManifest = {
            version: overlaid.version,
            fields: overlaid.fields.filter(
              (field) => !formatMarkers.has(field.path),
            ),
          };
          const updatedDocx = await writeManifest(buffer, manifest);
          return Result.ok({ manifest, bytes: new Uint8Array(updatedDocx) });
        },
      }),
    ),
  );

  return Result.ok({ manifest: written.manifest });
};
