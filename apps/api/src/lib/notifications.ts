import { and, eq, inArray, ne } from "drizzle-orm";
import { Result } from "better-result";
import type { WorkspaceRealtimeEvent } from "@stll/api-contract";
import { user } from "@/api/db/auth-schema";
import { notifications, workspaceMembers, NOTIFICATION_ENTITY_TYPES } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { broadcastUserNotification } from "@/api/lib/sse";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import type { Transaction } from "@/api/db/root";
import { rootDb } from "@/api/db/root";
import { LIMITS } from "@/api/lib/limits";

export const createNotification = async (
  tx: Transaction,
  args: {
    userId: SafeId<"user">;
    kind: string;
    metadata: Record<string, string | number | boolean | null>;
    entityType?: typeof NOTIFICATION_ENTITY_TYPES[number];
    entityId?: string;
    idempotencyKey?: string;
  }
): Promise<WorkspaceRealtimeEvent | null> => {
  const id = createSafeId<"notification">();
  const inserted = await tx
    .insert(notifications)
    .values({
      id,
      userId: args.userId,
      kind: args.kind,
      metadata: args.metadata,
      entityType: args.entityType ?? null,
      entityId: args.entityId ?? null,
      idempotencyKey: args.idempotencyKey ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: notifications.id, createdAt: notifications.createdAt });

  if (inserted.length === 0) {
    return null;
  }

  const insertedRow = inserted[0];
  if (!insertedRow) {
    return null;
  }

  return {
    type: "new-notification" as const,
    data: {
      id: insertedRow.id,
      kind: args.kind,
      metadata: args.metadata,
      isRead: false,
      createdAt: insertedRow.createdAt.toISOString(),
      entityType: args.entityType ?? null,
      entityId: args.entityId ?? null,
    },
  };
};

export type MentionDetectionResult = {
  authorName: string;
  targets: SafeId<"user">[];
};

export const detectMentionTargets = async (
  tx: Transaction,
  text: string,
  authorId: SafeId<"user">,
  workspaceId: SafeId<"workspace">
): Promise<MentionDetectionResult> => {
  const matches = text.match(/@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g);
  if (!matches) {
    return { authorName: "A colleague", targets: [] };
  }
  
  // Deduplicate and limit to mentionTargetsMax
  const matchedEmails = Array.from(new Set(matches.map((m) => m.slice(1).toLowerCase())))
    .slice(0, LIMITS.mentionTargetsMax);

  const authorRows = await tx
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, authorId))
    .limit(1);
  const authorName = authorRows.at(0)?.name ?? "A colleague";

  if (matchedEmails.length === 0) {
    return { authorName, targets: [] };
  }

  // Single query to match all users by email, excluding author
  const targetUsers = await tx
    .select({ id: user.id })
    .from(user)
    .where(and(inArray(user.email, matchedEmails), ne(user.id, authorId)));

  if (targetUsers.length === 0) {
    return { authorName, targets: [] };
  }

  const targetIds = targetUsers.map((u) => u.id);

  // Check workspace memberships in a single query
  const members = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        inArray(workspaceMembers.userId, targetIds)
      )
    );

  const targets = members.map((m) => brandPersistedUserId(m.userId));
  return { authorName, targets };
};

export const createAndBroadcastNotifications = async (
  userIds: SafeId<"user">[],
  args: {
    kind: string;
    metadata: Record<string, string | number | boolean | null>;
    entityType?: typeof NOTIFICATION_ENTITY_TYPES[number];
    entityId?: string;
    idempotencyKey?: string;
  }
): Promise<void> => {
  if (userIds.length === 0) return;

  const uniqueUserIds = Array.from(new Set(userIds));

  const rows = uniqueUserIds.map((userId) => ({
    id: createSafeId<"notification">(),
    userId,
    kind: args.kind,
    metadata: args.metadata,
    entityType: args.entityType ?? null,
    entityId: args.entityId ?? null,
    idempotencyKey: args.idempotencyKey ?? null,
  }));

  // Perform bulk insert on rootDb to bypass caller RLS policies, wrapped in tryPromise
  const insertedResult = await Result.tryPromise(async () => {
    return await rootDb.transaction(async (tx) => {
      return await tx
        .insert(notifications)
        .values(rows)
        .onConflictDoNothing()
        .returning({ id: notifications.id, createdAt: notifications.createdAt });
    });
  });

  if (Result.isError(insertedResult)) {
    return;
  }

  const insertedRows = insertedResult.value;
  const insertedMap = new Map<string, Date>(
    insertedRows.map((r: { id: string; createdAt: Date }) => [r.id, r.createdAt])
  );

  // Broadcast to each user post-commit only if successfully inserted
  for (const row of rows) {
    const createdAt = insertedMap.get(row.id);
    if (createdAt) {
      const event = {
        type: "new-notification" as const,
        data: {
          id: row.id,
          kind: row.kind,
          metadata: row.metadata,
          isRead: false,
          createdAt: createdAt.toISOString(),
          entityType: row.entityType,
          entityId: row.entityId,
        },
      };
      broadcastUserNotification(row.userId, event);
    }
  }
};
