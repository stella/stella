import { defineProof, name } from "@gdp-ts/core";
import type { Named, Proof } from "@gdp-ts/core";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { signals } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import {
  canTriageSignals,
  selectVisibleSignalInTransaction,
} from "@/api/lib/signals/read";

const SignalVisibleToProver = defineProof("SignalVisibleTo");
export type SignalVisibleTo<U, S, T> = {
  readonly organizationId: SafeId<"organization">;
} & Proof<"SignalVisibleTo", [U, S, T]>;

type VisibleSignal = Awaited<
  ReturnType<typeof selectVisibleSignalInTransaction>
>[number];
type WithVisibleSignalOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  actorUserId: SafeId<"user">;
  memberRole: AuthorizedMemberRole;
  signalId: SafeId<"signal">;
  expectedUpdatedAt?: Date;
};

/** Keep the check, locked row, and exact actor/resource/transaction names together. */
export const withVisibleSignal = async <R, E>(
  {
    tx,
    organizationId,
    actorUserId,
    memberRole,
    signalId,
    expectedUpdatedAt,
  }: WithVisibleSignalOptions,
  run: <U, S, T>(context: {
    tx: Named<T, Transaction>;
    signal: Named<S, SafeId<"signal">>;
    actor: Named<U, SafeId<"user">>;
    proof: SignalVisibleTo<U, S, T>;
    existing: VisibleSignal;
  }) => Promise<Result<R, E>>,
) =>
  name(actorUserId, signalId, tx, async (actor, signal, transaction) => {
    if (!hasMemberPermission(memberRole, { signal: ["resolve"] })) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Signal action is not permitted",
        }),
      );
    }
    // Lock only the signal table: the display joins include nullable sides.
    await tx
      .select({ id: signals.id })
      .from(signals)
      .where(
        and(
          eq(signals.id, signal.value),
          eq(signals.organizationId, organizationId),
        ),
      )
      .for("update")
      .limit(1);
    const rows = await selectVisibleSignalInTransaction({
      tx,
      organizationId,
      canTriage: canTriageSignals(memberRole),
      signalId: signal.value,
    });
    const existing = rows.at(0);
    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Signal not found" }),
      );
    }
    if (
      expectedUpdatedAt &&
      existing.updatedAt.getTime() !== expectedUpdatedAt.getTime()
    ) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Signal is no longer in a state that allows this action",
        }),
      );
    }
    const proof = {
      ...SignalVisibleToProver.prove(actor, signal, transaction),
      organizationId,
    };
    return await run({ tx: transaction, signal, actor, proof, existing });
  });
