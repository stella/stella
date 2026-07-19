import { Result, panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { templates, templateVersions } from "@/api/db/schema";
import { writeManifest } from "@/api/handlers/docx/template-manifest";
import type { TemplateManifest } from "@/api/handlers/docx/types";
import { isTemplateManifest } from "@/api/handlers/docx/types";
import { buildTemplateVersionS3Key } from "@/api/handlers/templates/storage-keys";
import {
  MAX_TEMPLATE_LANGUAGES,
  normalizeTemplateLanguages,
} from "@/api/handlers/templates/template-languages";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { pickDefined } from "@/api/lib/pick-defined";
import { getS3 } from "@/api/lib/s3";

const updateTemplateBodySchema = t.Object({
  name: t.Optional(tDefaultVarchar),
  categoryId: t.Optional(t.Nullable(tSafeId("templateCategory"))),
  manifest: t.Optional(t.String()),
  tags: t.Optional(
    t.Array(t.String({ minLength: 1, maxLength: 64 }), {
      maxItems: 32,
    }),
  ),
  whenToUse: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  whenNotToUse: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  // Accepts language tags (canonicalized to ISO 639-1 base codes server-side
  // by `normalizeTemplateLanguages`). Tags cap at 35 chars (RFC 5646 buffer).
  languages: t.Optional(
    t.Array(t.String({ maxLength: 35 }), {
      maxItems: MAX_TEMPLATE_LANGUAGES,
    }),
  ),
});

const updateTemplateParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

type UpdateTemplateBody = Static<typeof updateTemplateBodySchema>;

type UpdateTemplateProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  templateId: SafeId<"template">;
  body: UpdateTemplateBody;
  recordAuditEvent: AuditRecorder;
};

const parseManifest = (json: string): TemplateManifest | null => {
  const parseResult = Result.try((): unknown => JSON.parse(json));
  if (Result.isError(parseResult)) {
    return null;
  }

  const parsed = parseResult.value;
  return isTemplateManifest(parsed) ? parsed : null;
};

const updateTemplateHandler = async function* ({
  safeDb,
  organizationId,
  userId,
  templateId,
  body,
  recordAuditEvent,
}: UpdateTemplateProps) {
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
        },
      }),
    ),
  );

  if (!existing) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template not found" }),
    );
  }

  const categoryId = body.categoryId;
  if (categoryId !== undefined && categoryId !== null) {
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

  const updates: Partial<{
    name: string;
    categoryId: SafeId<"templateCategory"> | null;
    manifest: TemplateManifest;
    fieldCount: number;
    sizeBytes: number;
    s3Key: string;
    currentVersion: number;
    tags: string[];
    whenToUse: string | null;
    whenNotToUse: string | null;
    languages: string[];
    updatedAt: Date;
  }> = {
    ...pickDefined(body, ["name", "categoryId"]),
    updatedAt: new Date(),
  };

  if (body.tags !== undefined) {
    updates.tags = [
      ...new Set(
        body.tags.flatMap((tag) => {
          const trimmed = tag.trim();
          return trimmed.length > 0 ? [trimmed] : [];
        }),
      ),
    ];
  }
  if (body.whenToUse !== undefined) {
    updates.whenToUse = body.whenToUse?.trim() || null;
  }
  if (body.whenNotToUse !== undefined) {
    updates.whenNotToUse = body.whenNotToUse?.trim() || null;
  }
  if (body.languages !== undefined) {
    const normalized = normalizeTemplateLanguages(body.languages);
    if (!normalized.ok) {
      return Result.err(
        new HandlerError({ status: 400, message: normalized.message }),
      );
    }
    updates.languages = normalized.languages;
  }

  if (body.manifest !== undefined) {
    const manifest = parseManifest(body.manifest);
    if (!manifest) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid manifest JSON",
        }),
      );
    }

    // Advisory lock, then re-read s3Key/currentVersion fresh, transform the
    // DOCX, allocate the version, write its S3 object, and commit the row +
    // version insert — all under the lock. Reading the stored DOCX and
    // allocating/writing the new version's S3 object *outside* the lock let
    // two overlapping updates read the same currentVersion, compute the same
    // versionS3Key, and clobber each other's bytes (last write wins,
    // non-transactionally) while the loser's version insert lost to the
    // (templateId, version) unique index. Mirrors save-document.ts /
    // configure-template-fields-service.ts.
    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${templateId}))`,
        );

        // Re-read under the lock: a concurrent update that already committed
        // will have bumped currentVersion and rotated s3Key, so both are read
        // fresh here.
        const [locked] = await tx
          .select({
            currentVersion: templates.currentVersion,
            s3Key: templates.s3Key,
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

        const versionCount = await tx.$count(
          templateVersions,
          eq(templateVersions.templateId, templateId),
        );

        if (versionCount >= LIMITS.templateVersionsPerTemplate) {
          return { ok: false as const, reason: "limit" as const };
        }

        // Re-embed the manifest in the DOCX so the S3 file
        // stays in sync with the DB.
        const docxBuffer = await getS3().file(locked.s3Key).arrayBuffer();
        const updatedDocx = await writeManifest(
          Buffer.from(docxBuffer),
          manifest,
        );

        updates.manifest = manifest;
        updates.fieldCount = manifest.fields.length;
        updates.sizeBytes = updatedDocx.byteLength;

        const newVersion = locked.currentVersion + 1;
        updates.currentVersion = newVersion;

        // Each version gets its own immutable S3 key so
        // historical snapshots remain downloadable.
        const versionS3Key = buildTemplateVersionS3Key(
          organizationId,
          templateId,
          newVersion,
        );
        updates.s3Key = versionS3Key;

        // Under the lock: only concurrent updates of this same template
        // wait, and they must serialize anyway so vN's bytes aren't
        // overwritten before the version row commits.

        await getS3().write(versionS3Key, new Uint8Array(updatedDocx));

        const [r] = await tx
          .update(templates)
          .set(updates)
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
          createdBy: userId,
        });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
          resourceId: templateId,
          workspaceId: null,
          changes: {
            currentVersion: {
              old: locked.currentVersion,
              new: newVersion,
            },
            s3Key: { old: locked.s3Key, new: versionS3Key },
            fieldCount: { old: null, new: manifest.fields.length },
          },
        });

        if (!r) {
          // The update targeted a row the locked re-read just confirmed
          // exists; a missing returning row means it vanished mid-transaction.
          return { ok: false as const, reason: "not-found" as const };
        }
        return { ok: true as const, row: r };
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
          message: "Version limit reached for this template",
        }),
      );
    }

    return Result.ok(txResult.row);
  }

  const updated = yield* Result.await(
    safeDb(async (tx) => {
      const [row] = await tx
        .update(templates)
        .set(updates)
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

      const changes: Record<string, { old: unknown; new: unknown }> = {};
      for (const [key, newValue] of Object.entries(updates)) {
        if (key === "updatedAt") {
          continue;
        }
        changes[key] = { old: null, new: newValue };
      }

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
        resourceId: templateId,
        workspaceId: null,
        changes,
      });

      return row;
    }),
  );

  if (!updated) {
    panic("Failed to update template");
  }

  return Result.ok(updated);
};

const config = {
  permissions: { template: ["update"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  params: updateTemplateParamsSchema,
  body: updateTemplateBodySchema,
} satisfies HandlerConfig;

const updateTemplate = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, params, body, recordAuditEvent }) {
    return yield* updateTemplateHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      templateId: params.templateId,
      body,
      recordAuditEvent,
    });
  },
);

export default updateTemplate;
