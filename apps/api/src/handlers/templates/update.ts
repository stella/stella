import { Result, panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import { templates, templateVersions } from "@/api/db/schema";
import { writeManifest } from "@/api/handlers/docx/template-manifest";
import type { TemplateManifest } from "@/api/handlers/docx/types";
import { isTemplateManifest } from "@/api/handlers/docx/types";
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

const buildVersionS3Key = (
  organizationId: SafeId<"organization">,
  templateId: SafeId<"template">,
  version: number,
) => `${organizationId}/templates/${templateId}/v${version}.docx`;

const updateTemplateBodySchema = t.Object({
  name: t.Optional(tDefaultVarchar),
  categoryId: t.Optional(t.Nullable(tSafeId("templateCategory"))),
  manifest: t.Optional(t.String()),
  tags: t.Optional(
    t.Array(t.String({ minLength: 1, maxLength: 64 }), {
      maxItems: 32,
    }),
  ),
  whenToUse: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
  whenNotToUse: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
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
    updatedAt: Date;
  }> = {
    ...pickDefined(body, ["name", "categoryId"]),
    updatedAt: new Date(),
  };

  if (body.tags !== undefined) {
    updates.tags = [
      ...new Set(body.tags.map((tag) => tag.trim()).filter(Boolean)),
    ];
  }
  if (body.whenToUse !== undefined) {
    updates.whenToUse = body.whenToUse?.trim() || null;
  }
  if (body.whenNotToUse !== undefined) {
    updates.whenNotToUse = body.whenNotToUse?.trim() || null;
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

    // Re-embed the manifest in the DOCX so the S3 file
    // stays in sync with the DB.
    const docxBuffer = await getS3().file(existing.s3Key).arrayBuffer();
    const updatedDocx = await writeManifest(Buffer.from(docxBuffer), manifest);

    updates.manifest = manifest;
    updates.fieldCount = manifest.fields.length;
    updates.sizeBytes = updatedDocx.byteLength;

    const newVersion = existing.currentVersion + 1;
    updates.currentVersion = newVersion;

    // Each version gets its own immutable S3 key so
    // historical snapshots remain downloadable.
    const versionS3Key = buildVersionS3Key(
      organizationId,
      templateId,
      newVersion,
    );
    updates.s3Key = versionS3Key;

    // Write to the new version-specific key (outside
    // the transaction to keep it short).
    await getS3().write(versionS3Key, new Uint8Array(updatedDocx));

    // Advisory lock + version count + update + insert in one
    // transaction to prevent TOCTOU on the version limit.
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
              old: existing.currentVersion,
              new: newVersion,
            },
            s3Key: { old: existing.s3Key, new: versionS3Key },
            fieldCount: { old: null, new: manifest.fields.length },
          },
        });

        return { ok: true as const, row: r };
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

    const row = txResult.row;
    if (!row) {
      panic("Failed to update template");
    }

    return Result.ok(row);
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
