import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { templates, templateVersions } from "@/api/db/schema";
import { discoverTemplate } from "@/api/handlers/docx/discover-template";
import {
  mergeManifestWithDiscovery,
  readManifest,
  writeManifest,
} from "@/api/handlers/docx/template-manifest";
import type {
  FieldMeta,
  NamedCondition,
  TemplateManifest,
} from "@/api/handlers/docx/types";
import { isFieldMeta, isNamedCondition } from "@/api/handlers/docx/types";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS, LIMITS } from "@/api/lib/limits";
import { s3 } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { isRecord } from "@/api/lib/type-guards";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const createTemplateBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
  name: tDefaultVarchar,
  categoryId: t.Optional(tNanoid),
  // Elysia auto-parses JSON strings from FormData, so the
  // manifest may arrive as a string or an already-parsed
  // object depending on transport. Accept any and validate
  // in the handler.
  manifest: t.Optional(t.Any()),
});

type CreateTemplateProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: {
    file: File;
    name: string;
    categoryId?: string;
    manifest?: unknown;
  };
};

const buildS3Key = (organizationId: string, templateId: string) =>
  `${organizationId}/templates/${templateId}.docx`;

/** Accept a string (JSON body) or already-parsed object
 *  (FormData auto-parsed by Elysia). */
type ClientTemplateManifest = {
  fields: FieldMeta[];
  conditions?: NamedCondition[] | undefined;
};

const parseClientManifest = (value: unknown): ClientTemplateManifest | null => {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const fields = parsed.fields;
  if (!Array.isArray(fields) || !fields.every(isFieldMeta)) {
    return null;
  }
  const conditions = parsed.conditions;
  if (
    conditions !== undefined &&
    (!Array.isArray(conditions) || !conditions.every(isNamedCondition))
  ) {
    return null;
  }
  return {
    fields,
    conditions,
  };
};

const createTemplateHandler = async function* ({
  safeDb,
  organizationId,
  userId,
  body: { file, name, categoryId, manifest: manifestJson },
}: CreateTemplateProps) {
  if (file.type !== DOCX_MIME_TYPE) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invalid file type. Expected a DOCX file.",
      }),
    );
  }

  if (categoryId) {
    const category = yield* Result.await(
      safeDb((tx) =>
        tx.query.templateCategories.findFirst({
          where: { id: categoryId, organizationId: { eq: organizationId } },
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

  const buffer = Buffer.from(await file.arrayBuffer());

  const [discovered, existingManifest] = await Promise.all([
    discoverTemplate(buffer),
    readManifest(buffer),
  ]);

  const fields = mergeManifestWithDiscovery(existingManifest, discovered);

  // If the client supplied field metadata (from the configure
  // step), overlay it onto the discovered fields.
  let fieldMetas: FieldMeta[] = fields.map((f) => ({
    path: f.path,
    label: f.label,
    inputType: f.inputType,
    options: f.options,
    validation: f.validation,
    required: f.required,
  }));

  const clientManifest =
    manifestJson !== null && manifestJson !== undefined
      ? parseClientManifest(manifestJson)
      : null;

  if (clientManifest) {
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
    conditions:
      clientManifest?.conditions ?? existingManifest?.conditions ?? [],
  };

  const docxWithManifest = await writeManifest(buffer, manifest);

  // Pre-generate the ID so the S3 key and DB row stay in sync.
  const templateId = crypto.randomUUID();
  const s3Key = buildS3Key(organizationId, templateId);

  await s3.write(s3Key, new Uint8Array(docxWithManifest));

  const versionId = crypto.randomUUID();

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
          fileName: sanitizeFilename(file.name),
          s3Key,
          sizeBytes: docxWithManifest.byteLength,
          manifest,
          fieldCount: fields.length,
          currentVersion: 1,
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

  return Result.ok(txResult.row);
};

const config = {
  permissions: { template: ["create"] },
  body: createTemplateBodySchema,
} satisfies HandlerConfig;

const createTemplate = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body }) {
    return yield* createTemplateHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      body,
    });
  },
);

export default createTemplate;
