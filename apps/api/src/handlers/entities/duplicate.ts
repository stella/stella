import { Result } from "better-result";
import { and, eq, isNull, like } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb, Transaction } from "@/api/db";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
  writeAuditLog,
} from "@/api/lib/audit-log";
import type { AuditContext } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import { processExtraction } from "@/api/lib/search/process-extraction";

const duplicateEntityBodySchema = t.Object({
  entityId: tSafeId("entity"),
});

type DuplicateEntityHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  auditContext: AuditContext;
  body: Static<typeof duplicateEntityBodySchema>;
};

/** Escape regex metacharacters. */
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const trailingSuffixRe = /_\d+$/;

type ResolveEntityNameProps = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  parentId: SafeId<"entity"> | null;
  name: string | null;
};

/**
 * Generate a unique entity name by appending `_N` suffix.
 * Splits on the last dot to preserve file extensions:
 *   "Report.pdf" → "Report_1.pdf", "Report_2.pdf", …
 *   "My Folder"  → "My Folder_1", "My Folder_2", …
 * Strips any existing `_N` suffix before computing the
 * next number so re-duplicating "Report_1" still increments
 * from the highest sibling, not from the stripped base.
 */
const resolveEntityName = async ({
  tx,
  workspaceId,
  parentId,
  name,
}: ResolveEntityNameProps) => {
  if (!name) {
    return name;
  }

  const lastDot = name.lastIndexOf(".");
  const hasExt = lastDot > 0;
  const rawBase = hasExt ? name.slice(0, lastDot) : name;
  const ext = hasExt ? name.slice(lastDot) : "";

  // Strip trailing _N to get the root name
  const base = rawBase.replace(trailingSuffixRe, "");

  const pattern = `${escapeLike(base)}%${escapeLike(ext)}`;
  const parentCondition = parentId
    ? eq(entities.parentId, parentId)
    : isNull(entities.parentId);

  const siblings = await tx
    .select({ name: entities.name })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        parentCondition,
        like(entities.name, pattern),
      ),
    );

  const suffixRe = new RegExp(
    `^${escapeRegex(base)}(?:_(\\d+))?${escapeRegex(ext)}$`,
  );

  let maxN = 0;
  for (const sibling of siblings) {
    if (!sibling.name) {
      continue;
    }
    const match = suffixRe.exec(sibling.name);
    if (!match) {
      continue;
    }
    const n = match[1] ? Number.parseInt(match[1], 10) : 0;
    if (n > maxN) {
      maxN = n;
    }
  }

  return `${base}_${maxN + 1}${ext}`;
};

/** Extract fileName from the first file-type field. */
const extractFileName = (
  sourceFields: { content: FieldContent }[],
): string | null => {
  for (const field of sourceFields) {
    if (field.content.type === "file") {
      return field.content.fileName;
    }
  }
  return null;
};

const duplicateEntityHandler = async function* ({
  safeDb,
  workspaceId,
  userId,
  auditContext,
  body: { entityId: sourceEntityId },
}: DuplicateEntityHandlerProps) {
  const source = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findFirst({
        where: { id: { eq: sourceEntityId }, workspaceId: { eq: workspaceId } },
        columns: {
          id: true,
          kind: true,
          name: true,
          parentId: true,
        },
        with: {
          currentVersion: {
            columns: { id: true },
            with: {
              fields: {
                columns: {
                  propertyId: true,
                  content: true,
                },
              },
            },
          },
        },
      }),
    ),
  );

  if (!source) {
    return Result.err(
      new HandlerError({ status: 404, message: "Entity not found" }),
    );
  }

  if (source.kind === "folder") {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Folder duplication is not supported",
      }),
    );
  }

  if (!source.currentVersion) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Entity has no current version",
      }),
    );
  }

  const sourceFields = source.currentVersion.fields;

  // When entity.name is null (file uploads), derive the
  // display name from the file field's fileName
  const effectiveName = source.name ?? extractFileName(sourceFields);

  const txResult = yield* Result.await(
    safeDb(async (tx) => {
      const entityCount = await tx.$count(
        entities,
        eq(entities.workspaceId, workspaceId),
      );

      if (entityCount >= LIMITS.entitiesCount) {
        return {
          ok: false as const,
          status: 400 as const,
          message: "Entities limit reached",
        };
      }

      const newEntityId = createSafeId<"entity">();
      const newVersionId = createSafeId<"entityVersion">();

      const duplicateName = await resolveEntityName({
        tx,
        workspaceId,
        parentId: source.parentId,
        name: effectiveName,
      });

      const entityStamp =
        source.kind === "document"
          ? await allocateEntityStamp(tx, workspaceId)
          : null;

      await tx.insert(entities).values({
        id: newEntityId,
        workspaceId,
        kind: source.kind,
        parentId: source.parentId,
        name: duplicateName,
        createdBy: userId,
        docSequence: entityStamp?.docSequence ?? null,
      });

      await tx.insert(entityVersions).values({
        id: newVersionId,
        workspaceId,
        entityId: newEntityId,
        versionNumber: 1,
        stamp: entityStamp?.stamp ?? null,
        verificationCode: entityStamp?.verificationCode ?? null,
      });

      await tx
        .update(entities)
        .set({ currentVersionId: newVersionId })
        .where(eq(entities.id, newEntityId));

      // Copy all fields from source version (reuses S3 file
      // references; no data is physically duplicated)
      if (sourceFields.length > 0) {
        await tx.insert(fields).values(
          sourceFields.map((field) => ({
            workspaceId,
            propertyId: field.propertyId,
            entityVersionId: newVersionId,
            content: field.content,
          })),
        );
      }

      await tx
        .update(workspaces)
        .set({ lastActivityAt: new Date() })
        .where(eq(workspaces.id, workspaceId));

      await writeAuditLog(
        {
          ...auditContext,
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: newEntityId,
          changes: {
            created: {
              old: { sourceEntityId },
              new: {
                kind: source.kind,
                name: duplicateName,
                parentId: source.parentId,
              },
            },
          },
        },
        tx,
      );

      return { ok: true as const, entityId: newEntityId };
    }),
  );

  if (!txResult.ok) {
    return Result.err(
      new HandlerError({ status: txResult.status, message: txResult.message }),
    );
  }

  processExtraction(txResult.entityId).catch(captureError);

  return Result.ok({ entityId: txResult.entityId });
};

const config = {
  permissions: { entity: ["create"] },
  body: duplicateEntityBodySchema,
} satisfies HandlerConfig;

const duplicateEntity = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, user, request, body }) {
    return yield* duplicateEntityHandler({
      safeDb,
      workspaceId,
      userId: user.id,
      auditContext: createAuditContext({
        organizationId: session.activeOrganizationId,
        workspaceId,
        userId: user.id,
        request,
      }),
      body,
    });
  },
);

export default duplicateEntity;
