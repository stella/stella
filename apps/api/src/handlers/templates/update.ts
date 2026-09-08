import { Result, panic } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { templates } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { pickDefined } from "@/api/lib/pick-defined";
import {
  MAX_TEMPLATE_LANGUAGES,
  normalizeTemplateLanguages,
} from "@/api/lib/templates/template-languages";
import type { TemplateMetadataUpdate } from "@/api/lib/templates/write-template";

const updateTemplateBodySchema = t.Object({
  name: t.Optional(tDefaultVarchar),
  categoryId: t.Optional(t.Nullable(tSafeId("templateCategory"))),
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
  templateId: SafeId<"template">;
  body: UpdateTemplateBody;
  recordAuditEvent: AuditRecorder;
};

const updateTemplateHandler = async function* ({
  safeDb,
  organizationId,
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

  const updates: TemplateMetadataUpdate & { updatedAt: Date } = {
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
  description:
    "Change a template's record: name, category, tags, languages, whenToUse " +
    "and whenNotToUse guidance. Only the fields you pass are written. The " +
    "fields a template asks for live in its document, so change those by " +
    "storing a new body with templates.save-document or by calling " +
    "configure_template_fields.",
  permissions: { template: ["update"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  params: updateTemplateParamsSchema,
  body: updateTemplateBodySchema,
} satisfies HandlerConfig;

const updateTemplate = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    return yield* updateTemplateHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
      body,
      recordAuditEvent,
    });
  },
);

export default updateTemplate;
