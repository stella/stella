/**
 * Apply a field configuration to an EXISTING template's manifest and
 * re-embed it in the stored DOCX. The document bytes' {{markers}} are never
 * touched: only the manifest field metadata (input type, options, who-fills,
 * date format, lookup, composite parts, dependent select, formula, hint,
 * required) is overlaid by path.
 *
 * Backs the MCP `configure_template_fields` tool. Mirrors save-document's
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
import type { FieldOverlayIssue } from "@/api/lib/templates/field-overlay";
import {
  applyFieldOverlay,
  partitionFieldOverlay,
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
 *  updated field list back to the agent without a second read, plus the
 *  entries that could not be applied. The call succeeds with a non-empty
 *  `issues` list: only a template-level failure (not found, permission, an
 *  unreadable manifest) fails the whole request. */
export type ConfiguredTemplate = {
  manifest: TemplateManifest;
  issues: FieldOverlayIssue[];
};

export const configureTemplateFields = async function* ({
  safeDb,
  organizationId,
  templateId,
  fields,
  recordAuditEvent,
}: ConfigureTemplateFieldsOptions): SafeHandlerGenerator<ConfiguredTemplate> {
  let rejected: FieldOverlayIssue[] = [];
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
          // Best effort: an entry the document cannot carry is reported on
          // its own rather than sinking the entries beside it.
          const partitioned = partitionFieldOverlay({
            configured: baseManifest.fields,
            discovered,
            overlay: fields,
          });
          // `prepare` re-runs when a concurrent write moves the template's
          // pointer, so the issue list is replaced, never appended to.
          rejected = partitioned.issues;

          const overlaid = applyFieldOverlay(baseManifest, partitioned.applied);
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

  return Result.ok({ manifest: written.manifest, issues: rejected });
};
