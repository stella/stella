import { and, eq, isNull, like } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import type { EntityKind, FieldContent } from "@/api/db/schema-validators";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";

export type EntityFieldSnapshot = {
  propertyId: SafeId<"property">;
  content: FieldContent;
};

export type EntitySnapshot = {
  id: SafeId<"entity">;
  kind: EntityKind;
  name: string;
  parentId: SafeId<"entity"> | null;
  readOnly?: boolean;
  currentVersion: {
    fields: EntityFieldSnapshot[];
  } | null;
};

export type CopiedEntity = {
  sourceId: SafeId<"entity">;
  entityId: SafeId<"entity">;
  kind: EntityKind;
  name: string;
  parentId: SafeId<"entity"> | null;
};

/** File field info needed for PDF derivative enqueueing. */
export type CopiedFileField = {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  mimeType: string;
  encrypted: boolean;
};

/** Escape regex metacharacters. */
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const trailingSuffixRe = /_\d+$/u;

type ResolveEntityNameProps = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  parentId: SafeId<"entity"> | null;
  name: string;
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
export const resolveEntityName = async ({
  tx,
  workspaceId,
  parentId,
  name,
}: ResolveEntityNameProps): Promise<string> => {
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

  // If no conflict with the original name, keep it unchanged
  const siblingNames = new Set(siblings.map((s) => s.name));
  if (!siblingNames.has(name)) {
    return name;
  }

  const suffixRe = new RegExp(
    `^${escapeRegex(base)}(?:_(\\d+))?${escapeRegex(ext)}$`,
    "u",
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

export const getFolderSubtree = (
  allEntities: EntitySnapshot[],
  rootId: SafeId<"entity">,
): EntitySnapshot[] | null => {
  const childrenByParentId = new Map<SafeId<"entity">, EntitySnapshot[]>();

  for (const entity of allEntities) {
    if (!entity.parentId) {
      continue;
    }

    const children = childrenByParentId.get(entity.parentId);
    if (children) {
      children.push(entity);
      continue;
    }

    childrenByParentId.set(entity.parentId, [entity]);
  }

  const root = allEntities.find((entity) => entity.id === rootId);
  if (!root) {
    return null;
  }

  const subtree: EntitySnapshot[] = [];
  const queue = [root];

  for (const entity of queue) {
    subtree.push(entity);
    for (const child of childrenByParentId.get(entity.id) ?? []) {
      queue.push(child);
    }
  }

  return subtree;
};

type CopyEntitiesErrorResult = {
  ok: false;
  status: 400 | 404 | 500;
  message: string;
};

type CopyEntitiesSuccessResult = {
  ok: true;
  entityId: SafeId<"entity">;
  entityIds: SafeId<"entity">[];
  copiedEntities: CopiedEntity[];
  /** File fields that may need PDF derivative generation. */
  fileFields: CopiedFileField[];
};

export type CopyEntitiesResult =
  | CopyEntitiesErrorResult
  | CopyEntitiesSuccessResult;

type CopyEntitiesProps = {
  tx: Transaction;
  targetWorkspaceId: SafeId<"workspace">;
  targetParentId: SafeId<"entity"> | null;
  userId: SafeId<"user">;
  /**
   * Recorder for the target workspace audit rows. Caller is
   * responsible for binding it to `targetWorkspaceId` (via
   * `ctx.createAuditRecorder({ workspaceId: targetWorkspaceId })`
   * for cross-workspace copies, or just `ctx.recordAuditEvent`
   * when target equals the handler's workspace).
   */
  recordAuditEvent: AuditRecorder;
  sourceEntityId: SafeId<"entity">;
  sourceEntities: EntitySnapshot[];
  /** Source workspace ID for audit log (cross-workspace only). */
  sourceWorkspaceId?: SafeId<"workspace">;
};

/**
 * Copy entities to a target workspace. Used by both duplicate
 * (same workspace) and copy-to-workspace (cross-workspace).
 */
export const copyEntities = async ({
  tx,
  targetWorkspaceId,
  targetParentId,
  userId,
  recordAuditEvent,
  sourceEntityId,
  sourceEntities,
  sourceWorkspaceId,
}: CopyEntitiesProps): Promise<CopyEntitiesResult> => {
  const entityCount = await tx.$count(
    entities,
    eq(entities.workspaceId, targetWorkspaceId),
  );

  if (entityCount + sourceEntities.length > LIMITS.entitiesCount) {
    return {
      ok: false,
      status: 400,
      message: "Entities limit reached",
    };
  }

  // Validate target parent for cross-workspace copy only.
  // Same-workspace (duplicate) already validated the parent via the source entity fetch.
  if (sourceWorkspaceId && targetParentId) {
    const parent = await tx.query.entities.findFirst({
      where: {
        id: { eq: targetParentId },
        workspaceId: { eq: targetWorkspaceId },
      },
      columns: { kind: true },
    });

    if (!parent) {
      return {
        ok: false,
        status: 400,
        message: "Target parent folder not found",
      };
    }

    if (parent.kind !== "folder") {
      return {
        ok: false,
        status: 400,
        message: "Target parent must be a folder",
      };
    }
  }

  const idMap = new Map<SafeId<"entity">, SafeId<"entity">>();
  const copiedEntities: CopiedEntity[] = [];
  const copiedEntityIds: SafeId<"entity">[] = [];
  const fileFields: CopiedFileField[] = [];

  for (const source of sourceEntities) {
    if (!source.currentVersion) {
      return {
        ok: false,
        status: 400,
        message: "Entity has no current version",
      };
    }

    const newEntityId = createSafeId<"entity">();
    const newVersionId = createSafeId<"entityVersion">();
    const mappedParentId = source.parentId
      ? idMap.get(source.parentId)
      : undefined;

    // For root entity: use targetParentId (caller provides the correct value)
    // For children: use mapped parent from idMap
    const newParentId =
      source.id === sourceEntityId ? targetParentId : mappedParentId;

    const copyName =
      source.id === sourceEntityId
        ? await resolveEntityName({
            tx,
            workspaceId: targetWorkspaceId,
            parentId: newParentId ?? null,
            name: source.name,
          })
        : source.name;

    if (source.id !== sourceEntityId && newParentId === undefined) {
      return {
        ok: false,
        status: 500,
        message: "Copy parent was not created",
      };
    }

    const entityStamp =
      source.kind === "document"
        ? await allocateEntityStamp(tx, targetWorkspaceId)
        : null;

    await tx.insert(entities).values({
      id: newEntityId,
      workspaceId: targetWorkspaceId,
      kind: source.kind,
      parentId: newParentId ?? null,
      name: copyName,
      createdBy: userId,
      docSequence: entityStamp?.docSequence ?? null,
    });

    await tx.insert(entityVersions).values({
      id: newVersionId,
      workspaceId: targetWorkspaceId,
      entityId: newEntityId,
      versionNumber: 1,
      stamp: entityStamp?.stamp ?? null,
      verificationCode: entityStamp?.verificationCode ?? null,
    });

    await tx
      .update(entities)
      .set({ currentVersionId: newVersionId })
      .where(eq(entities.id, newEntityId));

    const sourceFields = source.currentVersion.fields;
    if (sourceFields.length > 0) {
      const fieldInserts = sourceFields.map((field) => {
        const fieldId = createSafeId<"field">();

        // Track file fields for PDF derivative enqueueing
        if (field.content.type === "file") {
          fileFields.push({
            entityId: newEntityId,
            fieldId,
            mimeType: field.content.mimeType,
            encrypted: field.content.encrypted,
          });
        }

        return {
          id: fieldId,
          workspaceId: targetWorkspaceId,
          propertyId: field.propertyId,
          entityVersionId: newVersionId,
          content: field.content,
        };
      });

      await tx.insert(fields).values(fieldInserts);
    }

    idMap.set(source.id, newEntityId);
    copiedEntityIds.push(newEntityId);
    copiedEntities.push({
      sourceId: source.id,
      entityId: newEntityId,
      kind: source.kind,
      name: copyName,
      parentId: newParentId ?? null,
    });
  }

  await tx
    .update(workspaces)
    .set({ lastActivityAt: new Date() })
    .where(eq(workspaces.id, targetWorkspaceId));

  await recordAuditEvent(
    tx,
    copiedEntities.map((entity) => ({
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
      resourceId: entity.entityId,
      changes: {
        created: {
          old: {
            sourceEntityId: entity.sourceId,
            ...(sourceWorkspaceId ? { sourceWorkspaceId } : {}),
          },
          new: {
            kind: entity.kind,
            name: entity.name,
            parentId: entity.parentId,
          },
        },
      },
    })),
  );

  const rootEntityId = idMap.get(sourceEntityId);
  if (!rootEntityId) {
    return {
      ok: false,
      status: 500,
      message: "Copy root was not created",
    };
  }

  return {
    ok: true,
    entityId: rootEntityId,
    entityIds: copiedEntityIds,
    copiedEntities,
    fileFields,
  };
};
