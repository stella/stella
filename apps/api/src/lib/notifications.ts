import { and, eq, or } from "drizzle-orm";
import { user } from "@/api/db/auth-schema";
import { notifications, workspaceMembers } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { broadcastUserNotification } from "@/api/lib/sse";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import type { Transaction } from "@/api/db/root";
import { rootDb } from "@/api/db/root";

export const createNotification = async (
  tx: Transaction,
  args: {
    userId: SafeId<"user">;
    title: string;
    message: string;
    entityType?: string;
    entityId?: string;
    idempotencyKey?: string;
  }
): Promise<SafeId<"notification"> | null> => {
  const id = createSafeId<"notification">();
  const inserted = await tx
    .insert(notifications)
    .values({
      id,
      userId: args.userId,
      title: args.title,
      message: args.message,
      entityType: args.entityType ?? null,
      entityId: args.entityId ?? null,
      idempotencyKey: args.idempotencyKey ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: notifications.id });

  if (inserted.length === 0) {
    return null;
  }

  const event = {
    type: "new-notification" as const,
    data: {
      id,
      title: args.title,
      message: args.message,
      isRead: false,
      createdAt: new Date().toISOString(),
      entityType: args.entityType ?? null,
      entityId: args.entityId ?? null,
    },
  };

  broadcastUserNotification(args.userId, event);
  return id;
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
  const matches = text.match(/@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}|[a-zA-Z0-9._-]+)/g);
  if (!matches) {
    return { authorName: "A colleague", targets: [] };
  }
  const usernamesOrEmails = matches.map((m) => m.slice(1));

  const authorRows = await tx
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, authorId))
    .limit(1);
  const authorName = authorRows.at(0)?.name ?? "A colleague";

  const targets: SafeId<"user">[] = [];

  for (const key of usernamesOrEmails) {
    const targetRows = await tx
      .select({ id: user.id })
      .from(user)
      .where(or(eq(user.email, key), eq(user.name, key)))
      .limit(1);
    const targetUser = targetRows.at(0);

    if (targetUser && targetUser.id !== authorId) {
      // Prove that the recipient can access the comment's workspace before sending
      const isMember = await tx
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, targetUser.id)
          )
        )
        .limit(1);

      if (isMember.length > 0) {
        targets.push(brandPersistedUserId(targetUser.id));
      }
    }
  }

  return { authorName, targets };
};

export const createAndBroadcastNotifications = async (
  userIds: SafeId<"user">[],
  args: {
    title: string;
    message: string;
    entityType?: string;
    entityId?: string;
    idempotencyKey?: string;
  }
): Promise<void> => {
  if (userIds.length === 0) return;

  const rows = userIds.map((userId) => ({
    id: createSafeId<"notification">(),
    userId,
    title: args.title,
    message: args.message,
    entityType: args.entityType ?? null,
    entityId: args.entityId ?? null,
    idempotencyKey: args.idempotencyKey ?? null,
  }));

  // Perform bulk insert on rootDb to bypass caller RLS policies
  const inserted = await rootDb.transaction(async (tx) => {
    return await tx
      .insert(notifications)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: notifications.id, userId: notifications.userId });
  });

  const insertedUserIds = new Set(inserted.map((row) => row.userId));

  // Broadcast to each user post-commit only if successfully inserted
  for (const row of rows) {
    if (insertedUserIds.has(row.userId)) {
      const event = {
        type: "new-notification" as const,
        data: {
          id: row.id,
          title: row.title,
          message: row.message,
          isRead: false,
          createdAt: new Date().toISOString(),
          entityType: row.entityType,
          entityId: row.entityId,
        },
      };
      broadcastUserNotification(row.userId, event);
    }
  }
};
