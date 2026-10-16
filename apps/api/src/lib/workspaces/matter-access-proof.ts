import type { Named } from "@gdp-ts/core";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { withCheckedTransaction } from "@/api/lib/proofs/checked-transaction";
import type { TransactionProof } from "@/api/lib/proofs/checked-transaction";
import { memberReachesMatterSql } from "@/api/lib/workspaces/authorized-workspace-ids";

const MATTER_ACCESS_PROOFS = {
  read: "MatterReadable",
  write: "MatterWritable",
} as const;
type MatterAccessNeed = keyof typeof MATTER_ACCESS_PROOFS;

export type MatterReadable<U, M, T, O> = TransactionProof<
  "MatterReadable",
  U,
  M,
  T,
  O
>;
export type MatterWritable<U, M, T, O> = TransactionProof<
  "MatterWritable",
  U,
  M,
  T,
  O
>;

export type MatterAccessContext<Need extends MatterAccessNeed, U, M, T, O> = {
  tx: Named<T, Transaction>;
  matter: Named<M, SafeId<"workspace">>;
  actor: Named<U, SafeId<"user">>;
  proof: TransactionProof<(typeof MATTER_ACCESS_PROOFS)[Need], U, M, T, O>;
};

type WithMatterAccessOptions<Need extends MatterAccessNeed> = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  need: Need;
  role: AuthorizedMemberRole;
  /** Acquire the caller's domain locks before the later access statement. */
  lock?: (tx: Transaction) => Promise<Result<void, HandlerError>>;
};

/**
 * Evidence retains the exact actor, matter, organization and transaction
 * names. Consume the context inside `run`: the proof is valid only while that
 * transaction is open, so returning, storing or capturing `tx`/`proof` beyond
 * the callback is rejected by `gdp-ts/no-matter-access-context-escape`.
 */
export const withMatterAccess = async <
  const Need extends MatterAccessNeed,
  R,
  E,
>(
  {
    tx,
    organizationId,
    userId,
    workspaceId,
    need,
    role,
    lock,
  }: WithMatterAccessOptions<Need>,
  run: <U, M, T, O>(
    context: MatterAccessContext<Need, U, M, T, O>,
  ) => Promise<Result<R, E>>,
) =>
  withCheckedTransaction(
    {
      kind: MATTER_ACCESS_PROOFS[need],
      tx,
      organizationId,
      actorUserId: userId,
      entityId: workspaceId,
      check: async (matterId) => {
        if (lock) {
          const locked = await lock(tx);
          if (Result.isError(locked)) {
            return locked;
          }
        }
        // A separate statement after locks observes access changes that committed
        // while this transaction waited for those locks under READ COMMITTED.
        const rows = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(
            and(
              eq(workspaces.id, matterId),
              eq(workspaces.organizationId, organizationId),
              memberReachesMatterSql({ organizationId, userId }, workspaces.id),
            ),
          )
          .limit(1);
        if (
          !rows.at(0) ||
          (need === "write" &&
            !hasMemberPermission(role, { entity: ["update"] }))
        ) {
          return Result.err(
            new HandlerError({
              status: 403,
              message: "Matter access is not permitted",
            }),
          );
        }
        return Result.ok(undefined);
      },
    },
    async ({ tx: transaction, entity, actor, proof }) =>
      await run({ tx: transaction, matter: entity, actor, proof }),
  );
