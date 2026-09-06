/**
 * Shared template-creation recipe: discover fields from a DOCX buffer, merge
 * any embedded manifest (optionally overlaid with client field metadata),
 * write the manifest back into the DOCX, upload to S3, and insert the template
 * + first version rows under an advisory lock that enforces the per-org limit.
 * A caller may instead supply a pre-built `manifest` to embed verbatim
 * (skipping discovery + merge), used by built-in report clones that must fill
 * identically to their source.
 *
 * Backs the REST create handler (`create.ts`) and the MCP `create_template`
 * tool so both paths embed the manifest and count fields identically.
 */

import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  AUTHORED_TEMPLATE_ORIGIN,
  templates,
  templateVersions,
} from "@/api/db/schema";
import type { TemplateKind, TemplateOrigin } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { discoverTemplate } from "@/api/lib/docx/discover-template";
import { readManifest, writeManifest } from "@/api/lib/docx/template-manifest";
import type { FieldMeta, TemplateManifest } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { getS3, writeS3ObjectWithRetry } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import {
  resolveTemplateFieldOverlay,
  fieldOverlayError,
  validateFieldOverlay,
} from "@/api/lib/templates/field-overlay";
import { buildTemplateS3Key } from "@/api/lib/templates/storage-keys";
import { detectTemplateLanguagesFromDocx } from "@/api/lib/templates/template-languages";

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

export type CreateStoredTemplateOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  buffer: Buffer;
  name: string;
  fileName: string;
  categoryId?: SafeId<"templateCategory"> | undefined;
  clientManifest?: ClientTemplateManifest | null | undefined;
  /** Pre-built manifest embedded verbatim, skipping discovery + merge. Used by
   *  built-in report clones: their manifests carry per-item AI fields under an
   *  array path (e.g. `contracts.summary`) that the discovery merge folds into
   *  the array root and drops, and a clone must fill identically to the
   *  built-in. Mutually exclusive with `clientManifest` (an overlay onto
   *  discovered fields), which is ignored when this is set. */
  manifest?: TemplateManifest | undefined;
  /** Template kind; defaults to `document`. Report templates (cloned from a
   *  built-in report layout) set `report` so the report picker can filter. */
  kind?: TemplateKind | undefined;
  /** Provenance of the first version; defaults to `authored`. A pack origin
   *  is also an identity: a second copy of the same pack template in the
   *  organization is refused with a 409 under the same lock as the insert. */
  origin?: TemplateOrigin | undefined;
  recordAuditEvent: AuditRecorder;
};

export const createStoredTemplate = async function* ({
  safeDb,
  organizationId,
  userId,
  buffer,
  name,
  fileName,
  categoryId,
  clientManifest,
  manifest,
  kind = "document",
  origin = AUTHORED_TEMPLATE_ORIGIN,
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
  const detectedLanguages = await detectTemplateLanguagesFromDocx(buffer);

  // A caller-supplied manifest is authoritative: it is embedded verbatim and
  // discovery/merge is skipped entirely, so nested per-item fields survive.
  // Otherwise the manifest is built from discovery, optionally overlaid with
  // the client field configuration.
  let resolvedManifest: TemplateManifest;
  if (manifest) {
    resolvedManifest = manifest;
  } else {
    const [discovered, existingManifest] = await Promise.all([
      discoverTemplate(buffer),
      readManifest(buffer),
    ]);

    // The overlay is folded into the manifest BEFORE the merge: whether a
    // dotted path is a field or a lookup's rendered output is decided by the
    // configuration, so a lookup the caller declares in this same request must
    // be visible to the merge that classifies those paths.
    if (clientManifest) {
      const issues = validateFieldOverlay({
        configured: arrayOrEmpty(existingManifest?.fields),
        discovered,
        overlay: clientManifest.fields,
      });
      if (issues.length > 0) {
        return Result.err(fieldOverlayError(issues));
      }
    }

    resolvedManifest = resolveTemplateFieldOverlay({
      discovered,
      manifest: existingManifest,
      overlay: clientManifest?.fields,
    });
  }

  const fieldCount = resolvedManifest.fields.length;
  const docxWithManifest = await writeManifest(buffer, resolvedManifest);

  // Pre-generate the ID so the S3 key and DB row stay in sync.
  const templateId = createSafeId<"template">();
  const s3Key = buildTemplateS3Key(organizationId, templateId);

  await writeS3ObjectWithRetry({
    data: new Uint8Array(docxWithManifest),
    key: s3Key,
  });

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
        return { ok: false as const, reason: "limit" as const };
      }

      if (origin.type === "bundled-pack") {
        const installed = await tx
          .select({ id: templates.id })
          .from(templates)
          .where(
            and(
              eq(templates.organizationId, organizationId),
              eq(templates.originType, "bundled-pack"),
              eq(sql`${templates.origin}->>'packId'`, origin.packId),
              eq(sql`${templates.origin}->>'slug'`, origin.slug),
            ),
          )
          .limit(1);
        if (installed.length > 0) {
          return { ok: false as const, reason: "duplicate_origin" as const };
        }
      }

      const [row] = await tx
        .insert(templates)
        .values({
          id: templateId,
          organizationId,
          categoryId: categoryId ?? null,
          name,
          kind,
          fileName: sanitizeFilename(fileName),
          s3Key,
          sizeBytes: docxWithManifest.byteLength,
          manifest: resolvedManifest,
          fieldCount,
          currentVersion: 1,
          languages: detectedLanguages,
          originType: origin.type,
          origin,
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
        manifest: resolvedManifest,
        fieldCount,
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
              fieldCount,
              currentVersion: 1,
              origin,
            },
          },
        },
      });

      return { ok: true as const, row };
    }),
  );

  // The DOCX is uploaded before the locked count/insert, so a rejected create
  // (limit reached, or a lost race for the last slot) leaves an unreferenced
  // object behind. Best-effort delete it so failed creates don't accrue S3 junk.
  if (!txResult.ok) {
    getS3().delete(s3Key).catch(captureError);
    return Result.err(
      txResult.reason === "duplicate_origin"
        ? new HandlerError({
            status: 409,
            message: "This pack template is already installed",
          })
        : new HandlerError({
            status: 400,
            message: "Templates limit reached",
          }),
    );
  }
  if (!txResult.row) {
    getS3().delete(s3Key).catch(captureError);
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Template insert returned no row",
      }),
    );
  }

  return Result.ok(txResult.row);
};
