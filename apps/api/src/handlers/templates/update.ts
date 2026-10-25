import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import type { SafeDb } from "@/api/db/safe-db";
import { templates } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  defaultVarcharSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { pickDefined } from "@/api/lib/pick-defined";
import {
  MAX_TEMPLATE_LANGUAGES,
  normalizeTemplateLanguages,
} from "@/api/lib/templates/template-languages";
import type { TemplateMetadataUpdate } from "@/api/lib/templates/write-template";

const updateTemplateBodySchema = v.object({
  name: v.exactOptional(defaultVarcharSchema),
  categoryId: v.exactOptional(v.nullable(resourceIdSchema("templateCategory"))),
  tags: v.exactOptional(
    v.pipe(
      v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
      v.maxLength(32),
    ),
  ),
  whenToUse: v.exactOptional(
    v.nullable(v.pipe(v.string(), v.maxLength(10_000))),
  ),
  whenNotToUse: v.exactOptional(
    v.nullable(v.pipe(v.string(), v.maxLength(10_000))),
  ),
  languages: v.exactOptional(
    v.pipe(
      v.array(v.pipe(v.string(), v.maxLength(35))),
      v.maxLength(MAX_TEMPLATE_LANGUAGES),
    ),
  ),
});

const updateTemplateParamsSchema = v.object({
  templateId: resourceIdSchema("template"),
});

type UpdateTemplateBody = v.InferOutput<typeof updateTemplateBodySchema>;

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
  contract: "replace",
  precondition: {
    type: "deferred",
    baselineId: "apps/api/src/handlers/templates/update.ts",
  },
  description:
    "Change a template's record: name, category, tags, languages, whenToUse " +
    "and whenNotToUse guidance. Only the fields you pass are written. The " +
    "fields a template asks for live in its document, so change those by " +
    "storing a new body with templates.document.update or by calling " +
    "configure_template_fields.",
  permissions: { template: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
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
