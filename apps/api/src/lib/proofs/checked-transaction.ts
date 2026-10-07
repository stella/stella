import { defineProof, name } from "@gdp-ts/core";
import type { Named, Proof, Prover } from "@gdp-ts/core";
import { panic, Result } from "better-result";

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

export type CheckedOperationContext<Kind extends string, Input, N> = {
  input: Named<N, Input>;
  proof: Proof<Kind, [NoInfer<N>]>;
};

class AuthorizedOperation<Kind extends string, Input> {
  readonly #input: Input;
  readonly #prover: Prover<Kind>;
  #state: "ready" | "consumed" = "ready";

  constructor(input: Input, prover: Prover<Kind>) {
    this.#input = input;
    this.#prover = prover;
  }

  async execute<R>(
    run: <N>(
      context: CheckedOperationContext<Kind, Input, N>,
    ) => R | Promise<R>,
  ): Promise<R> {
    if (this.#state === "consumed") {
      return panic("Checked operation authorization already consumed");
    }
    this.#state = "consumed";
    return await name(
      this.#input,
      async (input) => await run({ input, proof: this.#prover.prove(input) }),
    );
  }
}

export type OperationAuthorization<
  Kind extends string,
  Input,
> = AuthorizedOperation<Kind, Input>;

type AuthorizeOperationOptions<Kind extends string, Input, E> = {
  kind: Kind;
  input: Input;
  check: () => Promise<Result<void, E>>;
};

// The continuation retains exact names while operations may outlive a read transaction.
export const authorizeOperation = async <const Kind extends string, Input, E>({
  kind,
  input,
  check,
}: AuthorizeOperationOptions<Kind, Input, E>) => {
  const checked = await check();
  if (Result.isError(checked)) {
    return Result.err(checked.error);
  }
  return Result.ok(new AuthorizedOperation(input, defineProof(kind)));
};

export type AdmittedOperationContext<
  Kind extends string,
  Input,
  Admission,
  N,
  A,
> = {
  input: Named<N, Input>;
  admission: Named<A, Admission>;
  proof: Proof<Kind, [NoInfer<N>, NoInfer<A>]>;
};

type WithAdmittedOperationOptions<
  Kind extends string,
  Input,
  Admission,
  R,
  Outcome,
> = {
  kind: Kind;
  input: Input;
  admit: (run: (admission: Admission) => Promise<R>) => Promise<Outcome>;
  run: <N, A>(
    context: AdmittedOperationContext<Kind, Input, Admission, N, A>,
  ) => Promise<R>;
};

// The predicate owns admission and cleanup; evidence exists only in its execution scope.
export const withAdmittedOperation = async <
  const Kind extends string,
  Input,
  Admission,
  R,
  Outcome,
>({
  kind,
  input,
  admit,
  run,
}: WithAdmittedOperationOptions<
  Kind,
  Input,
  Admission,
  R,
  Outcome
>): Promise<Outcome> =>
  await admit(
    async (admission) =>
      await name(
        input,
        admission,
        async (namedInput, namedAdmission) =>
          await run({
            input: namedInput,
            proof: defineProof(kind).prove(namedInput, namedAdmission),
            admission: namedAdmission,
          }),
      ),
  );
