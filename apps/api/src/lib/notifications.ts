import { eq, or } from "drizzle-orm";
import { user } from "@/api/db/auth-schema";
import { notifications } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { broadcastUserNotification } from "@/api/lib/sse";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import type { Transaction } from "@/api/db/root";

export const createNotification = async (
  tx: Transaction,
  args: {
    userId: SafeId<"user">;
    title: string;
    message: string;
    entityType?: string;
    entityId?: string;
  }
): Promise<SafeId<"notification">> => {
  const id = createSafeId<"notification">();
  await tx.insert(notifications).values({
    id,
    userId: args.userId,
    title: args.title,
    message: args.message,
    entityType: args.entityType ?? null,
    entityId: args.entityId ?? null,
  });

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

export const detectAndNotifyMentions = async (
  tx: Transaction,
  text: string,
  authorId: SafeId<"user">,
  entityType?: string,
  entityId?: string
): Promise<void> => {
  const matches = text.match(/@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}|[a-zA-Z0-9._-]+)/g);
  if (!matches) return;
  const usernamesOrEmails = matches.map(m => m.slice(1));
  
  const authorRows = await tx
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, authorId))
    .limit(1);
  const authorName = authorRows.at(0)?.name ?? "A colleague";

  for (const key of usernamesOrEmails) {
    const targetRows = await tx
      .select({ id: user.id })
      .from(user)
      .where(or(eq(user.email, key), eq(user.name, key)))
      .limit(1);
    const targetUser = targetRows.at(0);
    
    if (targetUser && targetUser.id !== authorId) {
      await createNotification(tx, {
        userId: brandPersistedUserId(targetUser.id),
        title: "New Mention",
        message: `${authorName} @-mentioned you: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
        ...(entityType ? { entityType } : {}),
        ...(entityId ? { entityId } : {}),
      });
    }
  }
};
