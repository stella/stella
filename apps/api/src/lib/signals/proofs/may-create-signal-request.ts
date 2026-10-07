import { defineProof, name } from "@gdp-ts/core";
import type { Named, Proof } from "@gdp-ts/core";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { canTriageSignals } from "@/api/lib/signals/read";

const MayCreateSignalRequestProver = defineProof("MayCreateSignalRequest");
export type MayCreateSignalRequest<U, W, T> = {
  readonly organizationId: SafeId<"organization">;
} & Proof<"MayCreateSignalRequest", [U, W, T]>;

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
  run: <U, W, T>(context: {
    tx: Named<T, Transaction>;
    workspace: Named<W, SafeId<"workspace"> | null>;
    actor: Named<U, SafeId<"user">>;
    proof: MayCreateSignalRequest<U, W, T>;
  }) => Promise<Result<R, HandlerError>>,
) =>
  name(actorUserId, workspaceId, tx, async (actor, workspace, transaction) => {
    if (!hasMemberPermission(memberRole, { signal: ["create"] })) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Signal action is not permitted",
        }),
      );
    }
    if (workspace.value) {
      const visible = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.id, workspace.value),
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
    const proof = {
      ...MayCreateSignalRequestProver.prove(actor, workspace, transaction),
      organizationId,
    };
    return await run({ tx: transaction, workspace, actor, proof });
  });
