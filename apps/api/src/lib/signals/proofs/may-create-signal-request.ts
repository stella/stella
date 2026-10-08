import type { Named } from "@gdp-ts/core";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isBackgroundFeatureEnabled } from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { withCheckedTransaction } from "@/api/lib/proofs/checked-transaction";
import type { TransactionProof } from "@/api/lib/proofs/checked-transaction";
import { canTriageSignals } from "@/api/lib/signals/read";

export type MayCreateSignalRequest<U, S, T, O> = TransactionProof<
  "MayCreateSignalRequest",
  U,
  S,
  T,
  O
>;

type WithSignalRequestAuthorizationOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  actorUserId: SafeId<"user">;
  memberRole: AuthorizedMemberRole;
  workspaceId: SafeId<"workspace"> | null;
};

export const withSignalRequestAuthorization = async <R>(
  {
    tx,
    organizationId,
    actorUserId,
    memberRole,
    workspaceId,
  }: WithSignalRequestAuthorizationOptions,
  run: <U, W, T, O>(context: {
    tx: Named<T, Transaction>;
    workspace: Named<W, SafeId<"workspace"> | null>;
    actor: Named<U, SafeId<"user">>;
    proof: MayCreateSignalRequest<U, W, T, O>;
  }) => Promise<Result<R, HandlerError>>,
) =>
  withCheckedTransaction(
    {
      kind: "MayCreateSignalRequest",
      tx,
      organizationId,
      actorUserId,
      entityId: workspaceId,
      check: async () => {
        await lockFeatureRecoveryAdmission({
          tx,
          organizationId,
          featureId: "signals",
        });
        if (
          !(await isBackgroundFeatureEnabled({
            tx,
            organizationId,
            userId: actorUserId,
            featureId: "signals",
          }))
        ) {
          return Result.err(
            new HandlerError({ status: 404, message: "Signal not found" }),
          );
        }
        if (!hasMemberPermission(memberRole, { signal: ["create"] })) {
          return Result.err(
            new HandlerError({
              status: 403,
              message: "Signal action is not permitted",
            }),
          );
        }
        if (workspaceId) {
          const visible = await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(
              and(
                eq(workspaces.id, workspaceId),
                eq(workspaces.organizationId, organizationId),
              ),
            )
            .for("share")
            .limit(1);
          if (!visible.at(0)) {
            return Result.err(
              new HandlerError({ status: 404, message: "Matter not found" }),
            );
          }
        } else if (!canTriageSignals(memberRole)) {
          return Result.err(
            new HandlerError({
              status: 403,
              message: "Unscoped requests require the triage permission",
            }),
          );
        }

        return Result.ok(undefined);
      },
    },
    async ({ tx: transaction, entity, actor, proof }) =>
      await run({ tx: transaction, workspace: entity, actor, proof }),
  );
