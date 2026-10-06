import { panic, Result } from "better-result";
import { and, sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { rootDb } from "@/api/db/root";
import { desktopDeviceProofReplays } from "@/api/db/schema/desktop-device-proof-replay";
import {
  VerifiedDesktopDeviceProof,
  deviceProofRefusal,
} from "@/api/lib/business-registries/desktop/proof";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const MAX_PRUNE_ROWS = 100;
type ProofStoreDb = Pick<typeof rootDb, "transaction">;
type ClaimProofOptions = {
  proof: VerifiedDesktopDeviceProof;
  db?: ProofStoreDb;
  now?: Date;
};

type PruneProofOptions = { db?: ProofStoreDb; now?: Date; limit?: number };
export const pruneDesktopProofReceipts = async ({
  db = rootDb,
  now = new Date(Temporal.Now.instant().epochMilliseconds),
  limit = MAX_PRUNE_ROWS,
}: PruneProofOptions = {}) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PRUNE_ROWS) {
    panic("Desktop proof pruning must have a bounded positive limit");
  }
  return await Result.tryPromise({
    try: async () =>
      await db.transaction(async (tx) => {
        // audit: skip - Expired authentication receipts are ephemeral request bookkeeping.
        const deleted = await tx
          .delete(desktopDeviceProofReplays)
          .where(
            and(
              sql`${desktopDeviceProofReplays.expiresAt} <= ${now}::timestamptz`,
              sql`(${desktopDeviceProofReplays.jkt}, ${desktopDeviceProofReplays.jti}) IN (
          SELECT ${desktopDeviceProofReplays.jkt}, ${desktopDeviceProofReplays.jti}
          FROM ${desktopDeviceProofReplays}
          WHERE ${desktopDeviceProofReplays.expiresAt} <= ${now}::timestamptz
          ORDER BY ${desktopDeviceProofReplays.expiresAt}, ${desktopDeviceProofReplays.jkt}, ${desktopDeviceProofReplays.jti}
          LIMIT ${limit} FOR UPDATE SKIP LOCKED
        )`,
            ),
          )
          .returning({ jti: desktopDeviceProofReplays.jti });
        return deleted.length;
      }),
    catch: (cause) =>
      new HandlerError({
        status: 503,
        message: "Desktop account proof cleanup is unavailable",
        cause,
      }),
  });
};

export class ConsumedDesktopDeviceProof {
  readonly proof: VerifiedDesktopDeviceProof;

  private constructor(proof: VerifiedDesktopDeviceProof) {
    this.proof = proof;
  }

  static async claim({ proof, db = rootDb, now }: ClaimProofOptions) {
    if (!(proof instanceof VerifiedDesktopDeviceProof)) {
      panic("Desktop proof authority must come from signature verification");
    }
    const claimTime = now ?? new Date(Temporal.Now.instant().epochMilliseconds);
    if (proof.expiresAt.getTime() <= claimTime.getTime()) {
      return Result.err(deviceProofRefusal("desktop_proof_expired"));
    }
    const pruned = await pruneDesktopProofReceipts({ db, now: claimTime });
    if (pruned.isErr()) {
      return pruned;
    }
    const recorded = await Result.tryPromise({
      try: async () =>
        await db.transaction(
          async (tx) =>
            // audit: skip - Authentication receipts preserve single-use request authority independently.
            await tx
              .insert(desktopDeviceProofReplays)
              .values({
                jkt: proof.thumbprint,
                jti: proof.jti,
                expiresAt: proof.expiresAt,
              })
              .onConflictDoNothing()
              .returning({ jti: desktopDeviceProofReplays.jti }),
        ),
      catch: (cause) =>
        new HandlerError({
          status: 503,
          message: "Desktop account proof verification is unavailable",
          cause,
        }),
    });
    if (recorded.isErr()) {
      return recorded;
    }
    if (recorded.value.length !== 1) {
      return Result.err(deviceProofRefusal("desktop_proof_replayed"));
    }
    // The receipt is committed independently: later handler/audit rollback
    // cannot make an accepted proof reusable. A delayed claim still fails closed.
    const finishedAt =
      now ?? new Date(Temporal.Now.instant().epochMilliseconds);
    if (proof.expiresAt.getTime() <= finishedAt.getTime()) {
      return Result.err(deviceProofRefusal("desktop_proof_expired"));
    }
    return Result.ok(new ConsumedDesktopDeviceProof(proof));
  }

  authorizesCredential({
    keyId,
    credentialHash,
    thumbprint,
  }: {
    keyId: string;
    credentialHash: string;
    thumbprint: string;
  }) {
    const binding = this.proof.binding;
    return (
      binding.type === "account" &&
      binding.keyId === keyId &&
      binding.credentialHash === credentialHash &&
      this.proof.thumbprint === thumbprint
    );
  }
}
