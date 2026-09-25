/**
 * Owner-level DB access for the hosted usage webhook pipeline.
 *
 * The webhook route is unauthenticated (its authentication is the
 * HMAC signature) so there is no scopedDb / ctx available. Per
 * /conventions-security ("Handlers must not import the root db
 * module. Use ctx.scopedDb, or move owner-level DB access into a
 * narrow lib helper"), all rootDb access is kept here. The
 * receive handler imports these helpers; it does not touch
 * `rootDb` directly.
 *
 * `usage_provider_webhook_events` is a system table with a deny-stella RLS
 * policy; only this module legitimately writes to it.
 */

import { eq } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { hostedUsageWebhookEvents } from "@/api/db/schema";
import type { UsageProviderWebhookResult } from "@/api/db/schema";
import {
  createBackgroundAuditRecorder,
  type AuditAction,
  type AuditEvent,
  type AuditResourceType,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";

type InsertWebhookEventInput = {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  /**
   * Initial `result` to write on insert. Most callers want
   * "ok" — the receive pipeline overwrites it inside the same
   * transaction if dispatch decides "ignored" / "error".
   */
  initialResult: UsageProviderWebhookResult;
};

type FreshInsert = { kind: "fresh" };
type DuplicateInsert = { kind: "duplicate" };
type WebhookInsertOutcome = FreshInsert | DuplicateInsert;

/**
 * Insert a `usage_provider_webhook_events` row inside the supplied
 * transaction. Returns "duplicate" when the event id is already
 * present (the ON CONFLICT does nothing). Idempotency is the
 * structural guarantee: a row in the table means "this event has
 * been observed."
 *
 * Critical: this runs *inside the caller's transaction* so the
 * dedupe row commits or rolls back together with the dispatch
 * mutations. Splitting them would leak the dedupe row on dispatch
 * failure and then silently drop the next provider retry.
 */
const NUL = "\u0000";
/** U+2400 SYMBOL FOR NULL: marks, in the stored text, where a NUL stood. */
const NUL_SYMBOL = "\u2400";

const markNul = (value: string): string =>
  value.replaceAll(NUL, () => NUL_SYMBOL);

/**
 * Keys without a NUL keep their names. A key with one takes its marked name,
 * and when an original key already holds that name, the first free
 * `<marked>~<n>` from 2 upward, in payload order. Every value is kept.
 */
const storableRecord = (
  record: Record<string, unknown>,
): Record<string, unknown> => {
  const entries = Object.entries(record);
  const taken = new Set(
    entries.map(([key]) => key).filter((key) => !key.includes(NUL)),
  );
  const storedKey = (key: string): string => {
    if (!key.includes(NUL)) {
      return key;
    }
    const marked = markNul(key);
    let candidate = marked;
    for (let suffix = 2; taken.has(candidate); suffix++) {
      candidate = `${marked}~${suffix}`;
    }
    taken.add(candidate);
    return candidate;
  };
  return Object.fromEntries(
    entries.map(([key, entry]): [string, unknown] => [
      storedKey(key),
      storableJson(entry),
    ]),
  );
};

/**
 * The payload as a jsonb column stores it. Postgres text and jsonb values
 * carry no NUL character, so each one in a key or string is stored as the
 * NUL symbol (U+2400), and distinct keys stay distinct (see
 * `storableRecord`).
 */
const storableJson = (value: unknown): unknown => {
  if (typeof value === "string") {
    return markNul(value);
  }
  if (Array.isArray(value)) {
    return value.map(storableJson);
  }
  return isRecord(value) ? storableRecord(value) : value;
};

export const insertWebhookEventInTx = async ({
  tx,
  eventId,
  eventType,
  payload,
  initialResult,
}: InsertWebhookEventInput & {
  tx: Transaction;
}): Promise<WebhookInsertOutcome> => {
  const inserted = await tx
    .insert(hostedUsageWebhookEvents)
    .values({
      eventId,
      eventType: markNul(eventType),
      payload: storableRecord(payload),
      result: initialResult,
    })
    .onConflictDoNothing({ target: hostedUsageWebhookEvents.eventId })
    .returning({ eventId: hostedUsageWebhookEvents.eventId });
  if (inserted.length === 0) {
    return { kind: "duplicate" };
  }
  return { kind: "fresh" };
};

type UpdateWebhookEventInput = {
  tx: Transaction;
  eventId: string;
  result: UsageProviderWebhookResult;
  errorMessage?: string | null;
};

/**
 * Update the row's `result` column to the final dispatch outcome.
 * Runs inside the same transaction as the dispatch so the audit
 * status and the mutations commit together.
 */
export const updateWebhookEventResultInTx = async ({
  tx,
  eventId,
  result,
  errorMessage = null,
}: UpdateWebhookEventInput): Promise<void> => {
  await tx
    .update(hostedUsageWebhookEvents)
    .set({ result, errorMessage })
    .where(eq(hostedUsageWebhookEvents.eventId, eventId));
};

/**
 * Run `fn` inside a root-level transaction. The receive handler
 * uses this to run dedupe + dispatch + result update atomically
 * without importing `rootDb` directly.
 */
export const runWebhookTransaction = async <T>(
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> => await rootDb.transaction(fn);

export type WebhookTransactionRunner = typeof runWebhookTransaction;

/**
 * Special userId stamped on audit_log rows emitted from the
 * webhook pipeline. There is no human actor — the change was
 * driven by a verified provider event — so we use a stable string
 * marker. `audit_logs.user_id` is plain text (no FK) so this is
 * accepted by the schema.
 */
export const WEBHOOK_AUDIT_ACTOR = "system:usage-provider" as const;

type WebhookAuditEventInput = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
  /**
   * Provider event id. Lets a reviewer cross-reference the audit row
   * with `usage_provider_webhook_events.event_id` and the raw payload.
   */
  eventId: string;
  /**
   * Optional per-event details (field diffs, period dates, etc.).
   * Merged into the audit row's `changes` payload.
   */
  changes?: AuditEvent["changes"];
};

/**
 * Emit an `audit_logs` row from a webhook-driven mutation. Uses
 * the same shape as the request-time `recordAuditEvent` but
 * stamps the synthetic `system:usage-provider` actor since there is no
 * authenticated user on the webhook code path.
 *
 * Naming matches the project's audit-emitter naming convention so
 * the `require-audit-on-mutation` lint rule recognises the call.
 */
export const recordWebhookAuditEvent = async ({
  tx,
  organizationId,
  action,
  resourceType,
  resourceId,
  eventId,
  changes,
}: WebhookAuditEventInput): Promise<void> => {
  const recordAuditEvent = createBackgroundAuditRecorder({
    execution: {
      performer: {
        id: "usage-provider",
        name: "Usage provider",
        type: "service",
      },
      trigger: {
        source: "usage-provider",
        sourceId: eventId,
        type: "webhook",
      },
    },
    organizationId,
    workspaceId: null,
    userId: WEBHOOK_AUDIT_ACTOR,
  });
  await recordAuditEvent(tx, {
    action,
    resourceType,
    resourceId,
    changes: changes ?? null,
    metadata: { source: "usage_provider.webhook", eventId },
  });
};
