/**
 * Apply a field configuration to an EXISTING template.
 *
 * The DOCX is the template, so this writes the configuration into the stored
 * document's markers and republishes those bytes; the manifest it records is
 * read back from them. Storage only: the reading, merging and rewriting live
 * in `lib/templates/configure-template-document.ts`, which the authoring eval
 * drives without a database.
 *
 * Backs the MCP `configure_template_fields` tool. Stays on the current version
 * (a configuration is not a new draft of the body) and republishes it under a
 * new key.
 */

import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type { FieldMeta, TemplateManifest } from "@/api/lib/docx/types";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import type { FieldConfigurationIssue } from "@/api/lib/templates/configure-field-input";
import { configureTemplateDocument } from "@/api/lib/templates/configure-template-document";
import { writeStoredTemplate } from "@/api/lib/templates/write-template";

type ConfigureTemplateFieldsOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  /** One entry per field path, in the order the caller sent them. */
  fields: FieldMeta[];
  recordAuditEvent: AuditRecorder;
};

/** The manifest the rewritten document declares, so the caller can echo the
 *  updated field list back to the agent without a second read, plus the
 *  entries that could not be applied. The call succeeds with a non-empty
 *  `issues` list: only a template-level failure (not found, permission, an
 *  unreadable body) fails the whole request. */
export type ConfiguredTemplate = {
  manifest: TemplateManifest;
  issues: FieldConfigurationIssue[];
};

export const configureTemplateFields = async function* ({
  safeDb,
  organizationId,
  templateId,
  fields,
  recordAuditEvent,
}: ConfigureTemplateFieldsOptions): SafeHandlerGenerator<ConfiguredTemplate> {
  let rejected: FieldConfigurationIssue[] = [];
  const written = yield* Result.await(
    Result.gen(() =>
      writeStoredTemplate({
        safeDb,
        organizationId,
        templateId,
        mode: { type: "current-version" },
        recordAuditEvent,
        async prepare({ s3Key }) {
          const configured = await configureTemplateDocument({
            buffer: Buffer.from(await readS3ArrayBuffer(s3Key)),
            entries: fields,
          });
          // `prepare` re-runs when a concurrent write moves the template's
          // pointer, so the issue list is replaced, never appended to.
          rejected = configured.issues;
          return Result.ok({
            manifest: configured.manifest,
            bytes: new Uint8Array(configured.buffer),
          });
        },
      }),
    ),
  );

  return Result.ok({ manifest: written.manifest, issues: rejected });
};
