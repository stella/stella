import { panic } from "better-result";
import { and, eq, inArray, ne } from "drizzle-orm";

import { newNotificationRealtimeEvent } from "@stll/api-contract";
import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";
import type {
  NotificationEntityType,
  NotificationKind,
  NotificationMetadataByKind,
} from "@stll/api-contract/notifications";

import { user } from "@/api/db/auth-schema";
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
    { entityType: NotificationEntityType | null; entityId: string | null }
  >,
> = T;

/**
 * What each kind points at. The pointer is derived from the kind, not chosen
 * per call, so a producer cannot file a flow-run notification against a report
 * export id.
 */
type NotificationEntityRefByKind = TotalEntityRefMap<{
  [NOTIFICATION_KIND.MENTION]: {
    entityType: "entity";
    entityId: SafeId<"entity">;
  };
  [NOTIFICATION_KIND.REPORT_EXPORT_SUCCEEDED]: {
    entityType: "report_export";
    entityId: SafeId<"reportExport">;
  };
  [NOTIFICATION_KIND.REPORT_EXPORT_FAILED]: {
    entityType: "report_export";
    entityId: SafeId<"reportExport">;
  };
  [NOTIFICATION_KIND.FLOW_RUN_COMPLETED]: {
    entityType: "flow_run";
    entityId: SafeId<"flowRun">;
  };
  [NOTIFICATION_KIND.FLOW_RUN_FAILED]: {
    entityType: "flow_run";
    entityId: SafeId<"flowRun">;
  };
  [NOTIFICATION_KIND.FLOW_RUN_AWAITING_APPROVAL]: {
    entityType: "flow_run";
    entityId: SafeId<"flowRun">;
  };
  [NOTIFICATION_KIND.ANNOUNCEMENT]: { entityType: null; entityId: null };
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
 * Structural handle the fan-out writes through. Declared structurally rather
 * than as `typeof rootDb` so the batching behaviour can be exercised against
 * the embedded test database; production call sites always take the default.
 */
type NotificationFanOutDb = {
  transaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
};

/**
 * Who a batch of notifications is written as.
 *
 * `callerTransaction` is a recipient writing their OWN row: the caller's RLS
 * scope already admits it, so the row lands atomically with whatever write
 * caused it instead of in a second round trip that a crash could lose.
 * `systemFanOut` is a write addressed to OTHER people (a mentioned colleague,
 * every member of a firm), which no caller's scope can admit — it goes through
 * the owner connection, and the recipient and organization it names are always
 * server-derived.
 */
export type NotificationWriter =
  | { kind: "callerTransaction"; tx: Transaction }
  | { kind: "systemFanOut"; database?: NotificationFanOutDb | undefined };

/**
 * File notifications and ping their recipients' streams.
 *
 * Under `callerTransaction` the ping is sent before that transaction commits.
 * That is deliberate rather than sloppy: the event is content-free, so a
 * rollback costs a client one wasted re-read of a list that did not change,
 * whereas deferring the ping would mean every caller had to remember to send
 * it — the kind of discipline that eventually goes missing at one call site.
 *
 * Rejections propagate — the caller decides whether to fail the request or
 * hand it to `detached`, which captures. Nothing is swallowed here.
 */
export const createNotifications = async (
  rows: readonly NewNotification[],
  writer: NotificationWriter,
): Promise<void> => {
  if (rows.length === 0) {
    return;
  }

  const values = rows.map((row) => ({
    id: createSafeId<"notification">(),
    userId: row.userId,
    organizationId: row.organizationId,
    kind: row.kind,
    metadata: row.metadata,
    entityType: row.entityType,
    entityId: row.entityId,
    idempotencyKey: row.idempotencyKey,
  }));

  const insert = async (
    tx: Transaction,
    batch: typeof values,
  ): Promise<{ userId: string; organizationId: SafeId<"organization"> }[]> =>
    await tx
      .insert(notifications)
      .values(batch)
      .onConflictDoNothing()
      .returning({
        userId: notifications.userId,
        organizationId: notifications.organizationId,
      });

  const inserted: { userId: string; organizationId: SafeId<"organization"> }[] =
    [];
  for (const batch of chunked(values, NOTIFICATION_INSERT_BATCH_SIZE)) {
    // oxlint-disable-next-line n -- batches are written in order so one oversized fan-out cannot hold every pool connection at once
    const batchRows = await (writer.kind === "callerTransaction"
      ? insert(writer.tx, batch)
      : (writer.database ?? rootDb).transaction(
          async (tx) => await insert(tx, batch),
        ));
    inserted.push(...batchRows);
  }

  // One content-free ping per recipient stream. Collapsed per (user,
  // organization) so an announcement does not emit a burst to the same tab.
  const pinged = new Set<string>();
  for (const row of inserted) {
    const key = `${row.userId}:${row.organizationId}`;
    if (pinged.has(key)) {
      continue;
    }
    pinged.add(key);
    broadcastToUser(
      brandPersistedUserId(row.userId),
      row.organizationId,
      newNotificationRealtimeEvent(),
    );
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
