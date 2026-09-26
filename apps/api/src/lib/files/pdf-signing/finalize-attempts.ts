/**
 * Finalization as a bounded, leased, retryable step.
 *
 * Once the desktop's signature is verified it is stored on the exchange, and
 * every finalization after that embeds exactly that signature. A transient
 * failure (storage, a slow run) leaves the exchange open for a retry that
 * needs no new PIN; each attempt claims a lease so two attempts never embed
 * at once, and the number of attempts is capped so a failing document
 * cannot loop. The token's TTL still bounds all of it.
 */

import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { pdfSigningSessions } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

export const MAX_FINALIZE_ATTEMPTS = 3;

/**
 * Longer than one finalization can take (phase 2's own budget plus the
 * version write), so a lease only lapses when its attempt is gone.
 */
const FINALIZE_LEASE_MS = 120_000;

export type StoredSignature =
  | { status: "stored" }
  | { status: "conflict" }
  | { status: "closed" };

/**
 * Keep the desktop's verified signature. The first one wins; a later call
 * may only repeat it, so a retry can never swap in a different signature.
 */
export const storeDesktopSignature = async ({
  recordAuditEvent,
  sessionId,
  signature,
  tx,
}: {
  recordAuditEvent: AuditRecorder;
  sessionId: SafeId<"pdfSigningSession">;
  signature: Uint8Array;
  tx: Transaction;
}): Promise<StoredSignature> => {
  const stored = await tx
    .update(pdfSigningSessions)
    .set({ signature: Buffer.from(signature) })
    .where(
      and(
        eq(pdfSigningSessions.id, sessionId),
        eq(pdfSigningSessions.status, "open"),
        isNull(pdfSigningSessions.signature),
      ),
    )
    .returning({ id: pdfSigningSessions.id });
  if (stored.at(0)) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION,
      resourceId: sessionId,
      changes: { signature: { old: null, new: "received" } },
    });
    return { status: "stored" };
  }

  const rows = await tx
    .select({
      signature: pdfSigningSessions.signature,
      status: pdfSigningSessions.status,
    })
    .from(pdfSigningSessions)
    .where(eq(pdfSigningSessions.id, sessionId))
    .limit(1);
  const row = rows.at(0);
  if (row?.status !== "open") {
    return { status: "closed" };
  }
  return row.signature !== null &&
    Buffer.from(row.signature).equals(Buffer.from(signature))
    ? { status: "stored" }
    : { status: "conflict" };
};

export type FinalizeClaim =
  | { status: "claimed"; attempt: number }
  | { status: "in-progress" }
  | { status: "exhausted" }
  | { status: "closed" };

/**
 * Start one finalization. The conditional UPDATE is the whole decision: it
 * only succeeds for an open exchange with attempts left and no live lease.
 */
export const claimFinalizeAttempt = async ({
  now,
  recordAuditEvent,
  sessionId,
  tx,
}: {
  now: Date;
  recordAuditEvent: AuditRecorder;
  sessionId: SafeId<"pdfSigningSession">;
  tx: Transaction;
}): Promise<FinalizeClaim> => {
  const claimed = await tx
    .update(pdfSigningSessions)
    .set({
      finalizeAttempts: sql`${pdfSigningSessions.finalizeAttempts} + 1`,
      finalizeLeaseExpiresAt: new Date(now.getTime() + FINALIZE_LEASE_MS),
    })
    .where(
      and(
        eq(pdfSigningSessions.id, sessionId),
        eq(pdfSigningSessions.status, "open"),
        lt(pdfSigningSessions.finalizeAttempts, MAX_FINALIZE_ATTEMPTS),
        or(
          isNull(pdfSigningSessions.finalizeLeaseExpiresAt),
          // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- cutoff read from the caller's clock, never round-tripped through the database
          lte(pdfSigningSessions.finalizeLeaseExpiresAt, now),
        ),
      ),
    )
    .returning({ attempt: pdfSigningSessions.finalizeAttempts });
  const attempt = claimed.at(0)?.attempt;
  if (attempt !== undefined) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION,
      resourceId: sessionId,
      changes: { finalizeAttempts: { old: attempt - 1, new: attempt } },
    });
    return { status: "claimed", attempt };
  }

  const rows = await tx
    .select({
      attempts: pdfSigningSessions.finalizeAttempts,
      lease: pdfSigningSessions.finalizeLeaseExpiresAt,
      status: pdfSigningSessions.status,
    })
    .from(pdfSigningSessions)
    .where(eq(pdfSigningSessions.id, sessionId))
    .limit(1);
  const row = rows.at(0);
  if (row?.status !== "open") {
    return { status: "closed" };
  }
  // A live lease means the last attempt may still land: it is in progress,
  // not exhausted, whatever the count says.
  if (row.lease !== null && row.lease > now) {
    return { status: "in-progress" };
  }
  return row.attempts >= MAX_FINALIZE_ATTEMPTS
    ? { status: "exhausted" }
    : { status: "in-progress" };
};

/**
 * Give the lease back after a retryable failure, so a retry may start.
 * Fenced by `attempt`: an attempt that outlived its lease cannot release
 * the lease a later attempt now holds.
 */
export const releaseFinalizeAttempt = async ({
  attempt,
  recordAuditEvent,
  sessionId,
  tx,
}: {
  attempt: number;
  recordAuditEvent: AuditRecorder;
  sessionId: SafeId<"pdfSigningSession">;
  tx: Transaction;
}) => {
  const released = await tx
    .update(pdfSigningSessions)
    .set({ finalizeLeaseExpiresAt: null })
    .where(
      and(
        eq(pdfSigningSessions.id, sessionId),
        eq(pdfSigningSessions.status, "open"),
        eq(pdfSigningSessions.finalizeAttempts, attempt),
      ),
    )
    .returning({ id: pdfSigningSessions.id });
  if (released.at(0)) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION,
      resourceId: sessionId,
      changes: { finalizeLease: { old: "held", new: "released" } },
      metadata: { attempt },
    });
  }
};
