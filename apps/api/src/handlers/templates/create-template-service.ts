/**
 * Shared template-creation recipe: discover fields from a DOCX buffer, merge
 * any embedded manifest (optionally overlaid with client field metadata),
 * write the manifest back into the DOCX, upload to S3, and insert the template
 * + first version rows under an advisory lock that enforces the per-org limit.
 *
 * Backs the REST create handler (`create.ts`) and the MCP `create_template`
 * tool so both paths embed the manifest and count fields identically.
 */

import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import { templates, templateVersions } from "@/api/db/schema";
import { discoverTemplate } from "@/api/handlers/docx/discover-template";
import {
  mergeManifestWithDiscovery,
  readManifest,
  writeManifest,
} from "@/api/handlers/docx/template-manifest";
import type { FieldMeta, TemplateManifest } from "@/api/handlers/docx/types";
import { detectTemplateLanguagesFromDocx } from "@/api/handlers/templates/template-languages";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

/** The created template row returned to the caller (drives the detail view). */
export type CreatedTemplate = {
  id: SafeId<"template">;
  name: string;
  fileName: string;
  fieldCount: number;
  sizeBytes: number;
  createdAt: Date;
};

/** Optional client field metadata to overlay onto the discovered fields (from
 *  the configure step). */
export type ClientTemplateManifest = {
  fields: FieldMeta[];
};

type CreateStoredTemplateOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  buffer: Buffer;
  name: string;
  fileName: string;
  categoryId?: SafeId<"templateCategory"> | undefined;
  clientManifest?: ClientTemplateManifest | null | undefined;
  recordAuditEvent: AuditRecorder;
};

const buildS3Key = (
  organizationId: SafeId<"organization">,
  templateId: SafeId<"template">,
) => `${organizationId}/templates/${templateId}.docx`;

export const createStoredTemplate = async function* ({
  safeDb,
  organizationId,
  userId,
  buffer,
  name,
  fileName,
  categoryId,
  clientManifest,
  recordAuditEvent,
}: CreateStoredTemplateOptions): SafeHandlerGenerator<CreatedTemplate> {
  if (categoryId) {
    const category = yield* Result.await(
      safeDb((tx) =>
        tx.query.templateCategories.findFirst({
          where: {
            id: { eq: categoryId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true },
        }),
      ),
    );
    if (!category) {
      return Result.err(
        new HandlerError({ status: 400, message: "Category not found" }),
      );
    }
  }

  // Language detection is best-effort metadata: it guesses the document
  // languages from the text so bilingual templates are tagged from day
  // one; users can correct the result via the update endpoint.
  const [discovered, existingManifest, detectedLanguages] = await Promise.all([
    discoverTemplate(buffer),
    readManifest(buffer),
    detectTemplateLanguagesFromDocx(buffer),
  ]);

  const fields = mergeManifestWithDiscovery(existingManifest, discovered);

  let fieldMetas: FieldMeta[] = fields.map((f) => ({
    path: f.path,
    label: f.label,
    hint: f.hint,
    inputType: f.inputType,
    options: f.options,
    validation: f.validation,
    required: f.required,
    parts: f.parts,
    format: f.format,
    optionsFrom: f.optionsFrom,
    lookup: f.lookup,
    formula: f.formula,
    dateFormat: f.dateFormat,
  }));

  if (clientManifest) {
    const fieldPaths = new Set(fieldMetas.map((f) => f.path));
    const unknown = clientManifest.fields.find((f) => !fieldPaths.has(f.path));
    if (unknown) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            `No field "${unknown.path}" was discovered in the DOCX. ` +
            "Configure only paths that exist as {{markers}}.",
        }),
      );
    }

    const metaByPath = new Map<string, FieldMeta>();
    for (const f of clientManifest.fields) {
      metaByPath.set(f.path, f);
    }
    fieldMetas = fieldMetas.map((f) => {
      const override = metaByPath.get(f.path);
      if (!override) {
        return f;
      }
      return { ...f, ...override };
    });
  }

  const manifest: TemplateManifest = {
    version: existingManifest?.version ?? 1,
    fields: fieldMetas,
  };

  const docxWithManifest = await writeManifest(buffer, manifest);

  // Pre-generate the ID so the S3 key and DB row stay in sync.
  const templateId = createSafeId<"template">();
  const s3Key = buildS3Key(organizationId, templateId);

  await getS3().write(s3Key, new Uint8Array(docxWithManifest));

  const versionId = createSafeId<"templateVersion">();

  // Advisory lock + count + insert in one transaction to
  // prevent TOCTOU on the template limit.
  const txResult = yield* Result.await(
    safeDb(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`,
      );

      const existingCount = await tx.$count(
        templates,
        eq(templates.organizationId, organizationId),
      );

      if (existingCount >= LIMITS.templatesCount) {
        return { ok: false as const };
      }

      const [row] = await tx
        .insert(templates)
        .values({
          id: templateId,
          organizationId,
          categoryId: categoryId ?? null,
          name,
          fileName: sanitizeFilename(fileName),
          s3Key,
          sizeBytes: docxWithManifest.byteLength,
          manifest,
          fieldCount: fields.length,
          currentVersion: 1,
          languages: detectedLanguages,
          createdBy: userId,
        })
        .returning({
          id: templates.id,
          name: templates.name,
          fileName: templates.fileName,
          fieldCount: templates.fieldCount,
          sizeBytes: templates.sizeBytes,
          createdAt: templates.createdAt,
        });

      await tx.insert(templateVersions).values({
        id: versionId,
        organizationId,
        templateId,
        version: 1,
        s3Key,
        manifest,
        fieldCount: fields.length,
        createdBy: userId,
      });

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
        resourceId: templateId,
        workspaceId: null,
        changes: {
          created: {
            old: null,
            new: {
              name,
              categoryId: categoryId ?? null,
              fileName: row?.fileName ?? null,
              fieldCount: fields.length,
              currentVersion: 1,
            },
          },
        },
      });

      return { ok: true as const, row };
    }),
  );

  if (!txResult.ok) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Templates limit reached",
      }),
    );
  }
  if (!txResult.row) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Template insert returned no row",
      }),
    );
  }

  return Result.ok(txResult.row);
};
