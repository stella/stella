import { panic } from "better-result";
import { and, eq, inArray, ne } from "drizzle-orm";

import { newNotificationRealtimeEvent } from "@stll/api-contract";
import type {
  NOTIFICATION_KIND,
  NotificationEntityType,
  NotificationKind,
  NotificationMetadataByKind,
} from "@stll/api-contract/notifications";

import { member as organizationMember, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { notifications, workspaceMembers } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { broadcastToUser } from "@/api/lib/sse";

/**
 * Compile-time totality gate: a kind added without an entity-pointer decision
 * fails this constraint rather than defaulting to "points at nothing".
 */
type TotalEntityRefMap<
  T extends Record<
    NotificationKind,
    {
      entityType: NotificationEntityType | null;
      entityId: string | null;
      workspaceId: SafeId<"workspace"> | null;
    }
  >,
> = T;

/**
 * What each kind points at. The pointer is derived from the kind, not chosen
 * per call, so a producer cannot file a flow-run notification against a report
 * export id.
 *
 * `workspaceId` travels with the pointer because every target route is
 * `/workspaces/:workspaceId/...`: an entity id alone is not addressable. It is
 * the matter the producer already validated, never a value off a request body.
 */
type NotificationEntityRefByKind = TotalEntityRefMap<{
  [NOTIFICATION_KIND.MENTION]: {
    entityType: "entity";
    entityId: SafeId<"entity">;
    workspaceId: SafeId<"workspace">;
  };
  [NOTIFICATION_KIND.REPORT_EXPORT_SUCCEEDED]: {
    entityType: "report_export";
    entityId: SafeId<"reportExport">;
    workspaceId: SafeId<"workspace">;
  };
  [NOTIFICATION_KIND.REPORT_EXPORT_FAILED]: {
    entityType: "report_export";
    entityId: SafeId<"reportExport">;
    workspaceId: SafeId<"workspace">;
  };
  [NOTIFICATION_KIND.FLOW_RUN_COMPLETED]: {
    entityType: "flow_run";
    entityId: SafeId<"flowRun">;
    workspaceId: SafeId<"workspace">;
  };
  [NOTIFICATION_KIND.FLOW_RUN_FAILED]: {
    entityType: "flow_run";
    entityId: SafeId<"flowRun">;
    workspaceId: SafeId<"workspace">;
  };
  [NOTIFICATION_KIND.FLOW_RUN_AWAITING_APPROVAL]: {
    entityType: "flow_run";
    entityId: SafeId<"flowRun">;
    workspaceId: SafeId<"workspace">;
  };
  [NOTIFICATION_KIND.ANNOUNCEMENT]: {
    entityType: null;
    entityId: null;
    workspaceId: null;
  };
}>;

/**
 * One notification to file. The kind fixes both the metadata shape (exactly
 * the ICU parameters its message renders) and the entity pointer, so a call
 * site that sends the wrong parameters or the wrong pointer does not compile.
 *
 * `idempotencyKey` is scoped per user and must be derived from the event, not
 * from the moment: a redelivered job re-running this with the same key is a
 * no-op instead of a second badge.
 */
export type NewNotification = {
  [K in NotificationKind]: {
    kind: K;
    metadata: NotificationMetadataByKind[K];
    userId: SafeId<"user">;
    organizationId: SafeId<"organization">;
    idempotencyKey: string;
  } & NotificationEntityRefByKind[K];
}[NotificationKind];

/**
 * Rows per INSERT when fanning out to many recipients. Bounded so one
 * announcement to a large firm cannot build a single statement with thousands
 * of parameter placeholders.
 */
export const NOTIFICATION_INSERT_BATCH_SIZE = 200;

const chunked = <T>(items: readonly T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};

/**
 * Structural handle the owner-connection paths read and write through.
 * Declared structurally rather than as `typeof rootDb` so the fan-out and the
 * announcement audience can be exercised against the embedded test database;
 * production call sites always take the default.
 */
export type NotificationFanOutDb = {
  transaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
  select: (typeof rootDb)["select"];
};

/**
 * One recipient stream owed a content-free "your notifications changed" ping.
 *
 * Handed back rather than sent from inside the write so the ping cannot
 * outrun the row it announces: a client answers each event with exactly one
 * re-read, so a ping delivered before its transaction commits buys the reader
 * a stale badge until something unrelated refetches.
 */
export type NotificationPing = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
};

type NotificationInsertRow = {
  userId: string;
  organizationId: SafeId<"organization">;
};

const insertNotifications = async (
  rows: readonly NewNotification[],
  writeBatch: (
    insert: (tx: Transaction) => Promise<NotificationInsertRow[]>,
  ) => Promise<NotificationInsertRow[]>,
): Promise<NotificationPing[]> => {
  if (rows.length === 0) {
    return [];
  }

  const values = rows.map((row) => ({
    id: createSafeId<"notification">(),
    userId: row.userId,
    organizationId: row.organizationId,
    kind: row.kind,
    metadata: row.metadata,
    entityType: row.entityType,
    entityId: row.entityId,
    workspaceId: row.workspaceId,
    idempotencyKey: row.idempotencyKey,
  }));

  const inserted: NotificationInsertRow[] = [];
  for (const batch of chunked(values, NOTIFICATION_INSERT_BATCH_SIZE)) {
    // oxlint-disable-next-line no-await-in-loop -- batches are written in order so one oversized fan-out cannot hold every pool connection at once
    const batchRows = await writeBatch(
      async (tx) =>
        await tx
          .insert(notifications)
          .values(batch)
          .onConflictDoNothing()
          .returning({
            userId: notifications.userId,
            organizationId: notifications.organizationId,
          }),
    );
    inserted.push(...batchRows);
  }

  // One ping per recipient stream. Collapsed per (user, organization) so an
  // announcement does not emit a burst to the same tab.
  const seen = new Set<string>();
  const pings: NotificationPing[] = [];
  for (const row of inserted) {
    const key = `${row.userId}:${row.organizationId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    pings.push({
      userId: brandPersistedUserId(row.userId),
      organizationId: row.organizationId,
    });
  }
  return pings;
};

/**
 * File notifications a recipient is writing for THEMSELVES, in the caller's
 * own transaction: the user-and-organization RLS scope already admits those
 * rows, so they land atomically with whatever write caused them instead of in
 * a second round trip that a crash could lose.
 *
 * Returns the pings the caller must send with {@link pingNotificationRecipients}
 * AFTER that transaction commits. Nothing is broadcast here, because when this
 * returns the rows are still invisible to everybody, the recipient included.
 *
 * Rejections propagate: filing the notification is part of the caller's write,
 * so it fails or rolls back with it.
 */
export const createNotificationsInTransaction = async (
  rows: readonly NewNotification[],
  tx: Transaction,
): Promise<NotificationPing[]> =>
  await insertNotifications(rows, async (insert) => await insert(tx));

/**
 * File notifications addressed to OTHER people (a mentioned colleague, every
 * member of a firm) and ping them.
 *
 * No caller's RLS scope can admit a row addressed to somebody else, so this
 * writes through the owner connection; the recipient and organization it names
 * are always server-derived. Its own transaction has committed by the time
 * this returns, so the pings go out here and no caller has to remember them.
 *
 * Rejections propagate — the caller decides whether to fail the request or
 * hand it to `detached`, which captures. Nothing is swallowed here.
 */
export const fanOutNotifications = async (
  rows: readonly NewNotification[],
  database: NotificationFanOutDb = rootDb,
): Promise<void> => {
  pingNotificationRecipients(
    await insertNotifications(
      rows,
      async (insert) => await database.transaction(insert),
    ),
  );
};

/**
 * Send the content-free pings {@link createNotificationsInTransaction} handed
 * back, once the transaction they belong to has committed. The event carries
 * no payload, so a recipient's client answers it by re-reading the ordinary
 * authorized endpoint.
 */
export const pingNotificationRecipients = (
  pings: readonly NotificationPing[],
): void => {
  for (const { organizationId, userId } of pings) {
    broadcastToUser(userId, organizationId, newNotificationRealtimeEvent());
  }
};

/**
 * `@someone@example.com` in free text. Email is the only handle the product
 * exposes today, so mention syntax is an email preceded by `@`.
 */
const MENTION_PATTERN =
  /@(?<email>[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gu;

export type MentionTargets = {
  actorName: string;
  userIds: SafeId<"user">[];
};

/**
 * Resolve `@email` mentions in `text` to users who are members of
 * `workspaceId`.
 *
 * `workspaceId` must be server-derived (the handler's validated workspace),
 * never read off the body: it is the whole containment. An address that is not
 * a member of that workspace resolves to nobody, so a comment cannot be used
 * to probe for accounts or to notify somebody who cannot see the thread.
 */
export const resolveMentionTargets = async (
  tx: Transaction,
  {
    actorUserId,
    text,
    workspaceId,
  }: {
    actorUserId: SafeId<"user">;
    text: string;
    workspaceId: SafeId<"workspace">;
  },
): Promise<MentionTargets> => {
  const mentioned = [
    ...new Set(
      [...text.matchAll(MENTION_PATTERN)].flatMap((match) => {
        const email = match.groups?.["email"];
        return email ? [email] : [];
      }),
    ),
  ].slice(0, LIMITS.mentionTargetsMax);
  if (mentioned.length === 0) {
    // Nothing to name, so nothing to look the actor's name up for.
    return { actorName: "", userIds: [] };
  }

  // The actor is the authenticated caller and their own row is always visible
  // to them, so a miss here is a broken invariant, not an absent name.
  const actorRow = await tx
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, actorUserId))
    .limit(1);
  const actorName =
    actorRow.at(0)?.name ?? panic("the mentioning user's own row is missing");

  // Stored addresses are whatever the identity provider recorded, and a
  // reader types the address they see. Match both the verbatim mention and its
  // lower-case form rather than folding the column, which would turn the
  // unique email index into a sequential scan of every account.
  const candidates = [
    ...new Set(mentioned.flatMap((email) => [email, email.toLowerCase()])),
  ];

  const members = await tx
    .select({ userId: user.id })
    .from(user)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, user.id))
    .where(
      and(
        inArray(user.email, candidates),
        ne(user.id, actorUserId),
        eq(workspaceMembers.workspaceId, workspaceId),
      ),
    )
    .limit(LIMITS.mentionTargetsMax);

  return {
    actorName,
    userIds: members.map((member) => brandPersistedUserId(member.userId)),
  };
};

/**
 * Recipients are read through the owner connection: an announcement's audience
 * is every member of the organization, which no single caller's RLS scope
 * reveals. Callers pass their cap plus one so an oversized audience is
 * detected and refused rather than silently truncated.
 */
export const listAnnouncementRecipients = async (
  organizationId: SafeId<"organization">,
  limit: number,
  database: NotificationFanOutDb = rootDb,
): Promise<{ userId: string }[]> =>
  await database
    .select({ userId: organizationMember.userId })
    .from(organizationMember)
    .where(eq(organizationMember.organizationId, organizationId))
    .limit(limit);
