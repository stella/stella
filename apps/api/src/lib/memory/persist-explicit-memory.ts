import { panic } from "better-result";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { aiMemories } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

type ExplicitMemoryInsert = Pick<
  typeof aiMemories.$inferInsert,
  | "organizationId"
  | "scope"
  | "userId"
  | "workspaceId"
  | "kind"
  | "content"
  | "dedupKey"
  | "language"
  | "sourceDataWorkspaceIds"
  | "source"
  | "status"
  | "pinned"
  | "createdBy"
>;

type PersistExplicitMemoryOptions = {
  metadataOnConflict?:
    | {
        language?: string | null | undefined;
        pinned?: boolean | undefined;
      }
    | undefined;
  recordAuditEvent: AuditRecorder;
  tx: Transaction;
  values: ExplicitMemoryInsert;
};

export type PersistExplicitMemoryResult = {
  id: SafeId<"aiMemory">;
  type: "created" | "existing" | "reactivated";
};

/**
 * Insert an explicit user/tool memory under the database's exact-dedup
 * constraint. Active duplicates are idempotent. An explicit duplicate of an
 * inactive row reactivates it; background extraction deliberately does not use
 * this helper, so dismissed suggestions remain tombstones.
 */
export const persistExplicitMemory = async ({
  metadataOnConflict,
  recordAuditEvent,
  tx,
  values,
}: PersistExplicitMemoryOptions): Promise<PersistExplicitMemoryResult> => {
  const [inserted] = await tx
    .insert(aiMemories)
    .values(values)
    .onConflictDoNothing({
      target: [aiMemories.organizationId, aiMemories.dedupKey],
    })
    .returning({ id: aiMemories.id });

  if (inserted) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.AI_MEMORY,
      resourceId: inserted.id,
      workspaceId: values.workspaceId ?? null,
      changes: {
        created: {
          old: null,
          new: { scope: values.scope, kind: values.kind },
        },
      },
    });
    return { id: inserted.id, type: "created" };
  }

  const [existing] = await tx
    .select({
      id: aiMemories.id,
      language: aiMemories.language,
      pinned: aiMemories.pinned,
      status: aiMemories.status,
    })
    .from(aiMemories)
    .where(
      and(
        eq(aiMemories.organizationId, values.organizationId),
        eq(aiMemories.dedupKey, values.dedupKey),
      ),
    )
    .limit(1);
  if (!existing) {
    panic("Memory dedup conflict row disappeared");
  }
  const nextLanguage =
    metadataOnConflict?.language !== undefined &&
    metadataOnConflict.language !== existing.language
      ? metadataOnConflict.language
      : undefined;
  const nextPinned =
    metadataOnConflict?.pinned !== undefined &&
    metadataOnConflict.pinned !== existing.pinned
      ? metadataOnConflict.pinned
      : undefined;
  const metadataSet: { language?: string | null; pinned?: boolean } = {
    ...(nextLanguage !== undefined ? { language: nextLanguage } : {}),
    ...(nextPinned !== undefined ? { pinned: nextPinned } : {}),
  };
  const metadataChanges = {
    ...(metadataSet.language !== undefined
      ? {
          language: {
            old: existing.language,
            new: metadataSet.language,
          },
        }
      : {}),
    ...(metadataSet.pinned !== undefined
      ? { pinned: { old: existing.pinned, new: metadataSet.pinned } }
      : {}),
  };

  if (existing.status === "active") {
    if (Object.keys(metadataSet).length === 0) {
      return { id: existing.id, type: "existing" };
    }
    await tx
      .update(aiMemories)
      .set(metadataSet)
      .where(eq(aiMemories.id, existing.id));
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.AI_MEMORY,
      resourceId: existing.id,
      workspaceId: values.workspaceId ?? null,
      changes: metadataChanges,
    });
    return { id: existing.id, type: "existing" };
  }

  await tx
    .update(aiMemories)
    .set({
      status: "active",
      archivedAt: null,
      lastUsedAt: new Date(),
      ...metadataSet,
    })
    .where(eq(aiMemories.id, existing.id));
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.AI_MEMORY,
    resourceId: existing.id,
    workspaceId: values.workspaceId ?? null,
    changes: {
      status: { old: existing.status, new: "active" },
      ...metadataChanges,
    },
  });
  return { id: existing.id, type: "reactivated" };
};
