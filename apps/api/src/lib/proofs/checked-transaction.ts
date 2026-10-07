import { defineProof, name } from "@gdp-ts/core";
import type { Named, Proof } from "@gdp-ts/core";
import { Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";

export type TransactionProof<Kind extends string, U, S, T, O> = {
  readonly organizationId: Named<O, SafeId<"organization">>;
} & Proof<Kind, [U, S, T, O]>;

type CheckedTransactionContext<
  Kind extends string,
  Entity,
  Checked,
  U,
  S,
  T,
  O,
> = {
  tx: Named<T, Transaction>;
  entity: Named<S, Entity>;
  actor: Named<U, SafeId<"user">>;
  proof: TransactionProof<Kind, U, S, T, O>;
  checked: Checked;
};

type WithCheckedTransactionOptions<Kind extends string, Entity, Checked> = {
  kind: Kind;
  tx: Transaction;
  organizationId: SafeId<"organization">;
  actorUserId: SafeId<"user">;
  entityId: Entity;
  check: () => Promise<Result<Checked, HandlerError>>;
};

// Only trusted predicate modules may import this minting boundary.
export const withCheckedTransaction = async <
  const Kind extends string,
  Entity,
  Checked,
  R,
  E,
>(
  {
    kind,
    tx,
    organizationId,
    actorUserId,
    entityId,
    check,
  }: WithCheckedTransactionOptions<Kind, Entity, Checked>,
  run: <U, S, T, O>(
    context: CheckedTransactionContext<Kind, Entity, Checked, U, S, T, O>,
  ) => Promise<Result<R, E>>,
): Promise<Result<R, E | HandlerError>> =>
  name(actorUserId, entityId, tx, async (actor, entity, transaction) => {
    const result = await check();
    if (Result.isError(result)) {
      return Result.err(result.error);
    }
    return await name(organizationId, async (organization) => {
      const prover = defineProof(kind);
      const proof = {
        ...prover.prove(actor, entity, transaction, organization),
        organizationId: organization,
      };
      return await run({
        tx: transaction,
        entity,
        actor,
        proof,
        checked: result.value,
      });
    });
  });
