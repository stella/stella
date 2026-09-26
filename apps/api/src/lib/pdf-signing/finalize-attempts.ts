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
import type { SafeId } from "@/api/lib/branded-types";

export const MAX_FINALIZE_ATTEMPTS = 3;

/**
 * Longer than one finalization can take (phase 2's own budget plus the
 * version write), so a lease only lapses when its attempt is gone.
 */
const FINALIZE_LEASE_MS = 120_000;

type Store = Pick<Transaction, "select" | "update">;

export type StoredSignature =
  | { status: "stored" }
  | { status: "conflict" }
  | { status: "closed" };

/**
 * Keep the desktop's verified signature. The first one wins; a later call
 * may only repeat it, so a retry can never swap in a different signature.
 */
export const storeDesktopSignature = async ({
  sessionId,
  signature,
  tx,
}: {
  sessionId: SafeId<"pdfSigningSession">;
  signature: Uint8Array;
  tx: Store;
}): Promise<StoredSignature> => {
  // audit: skip — the signature is prepared state of an audited exchange;
  // the transition it leads to is audited when the exchange closes.
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
  sessionId,
  tx,
}: {
  now: Date;
  sessionId: SafeId<"pdfSigningSession">;
  tx: Store;
}): Promise<FinalizeClaim> => {
  // audit: skip — attempt bookkeeping, not a state transition.
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
    return { status: "claimed", attempt };
  }

  const rows = await tx
    .select({
      attempts: pdfSigningSessions.finalizeAttempts,
      status: pdfSigningSessions.status,
    })
    .from(pdfSigningSessions)
    .where(eq(pdfSigningSessions.id, sessionId))
    .limit(1);
  const row = rows.at(0);
  if (row?.status !== "open") {
    return { status: "closed" };
  }
  return row.attempts >= MAX_FINALIZE_ATTEMPTS
    ? { status: "exhausted" }
    : { status: "in-progress" };
};

/** Give the lease back after a retryable failure, so a retry may start. */
export const releaseFinalizeAttempt = async ({
  sessionId,
  tx,
}: {
  sessionId: SafeId<"pdfSigningSession">;
  tx: Store;
}) => {
  // audit: skip — attempt bookkeeping, not a state transition.
  await tx
    .update(pdfSigningSessions)
    .set({ finalizeLeaseExpiresAt: null })
    .where(
      and(
        eq(pdfSigningSessions.id, sessionId),
        eq(pdfSigningSessions.status, "open"),
      ),
    );
};
