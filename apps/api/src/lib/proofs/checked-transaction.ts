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
  check: (entityId: Entity) => Promise<Result<Checked, HandlerError>>;
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
  name(
    actorUserId,
    snapshotOperationInput(entityId),
    tx,
    async (actor, entity, transaction) => {
      const result = await check(entity.value);
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
    },
  );

// Private fields prevent object spread from rebinding evidence to another snapshot.
class OperationEvidence<
  Kind extends string,
  Input,
  N,
  About extends readonly unknown[] = [N],
> {
  readonly #input: Named<N, Input>;
  readonly #proof: Proof<Kind, About>;

  constructor(input: Named<N, Input>, proof: Proof<Kind, About>) {
    this.#input = Object.freeze(input);
    this.#proof = proof;
  }

  get input(): Named<N, Input> {
    return this.#input;
  }

  get kind(): Kind {
    return this.#proof.kind;
  }
}

type AdmissionEvidenceOptions<Kind extends string, Input, Admission, N, A> = {
  input: Named<N, Input>;
  admission: Named<A, Admission>;
  proof: Proof<Kind, [N, A]>;
};

class AdmissionEvidence<
  Kind extends string,
  Input,
  Admission,
  N,
  A,
> extends OperationEvidence<Kind, Input, N, [N, A]> {
  readonly #admission: Named<A, Admission>;

  constructor({
    input,
    admission,
    proof,
  }: AdmissionEvidenceOptions<Kind, Input, Admission, N, A>) {
    super(input, proof);
    this.#admission = Object.freeze(admission);
  }

  get admission(): Named<A, Admission> {
    return this.#admission;
  }
}

export type CheckedOperationContext<Kind extends string, Input, N> = {
  input: Named<N, Input>;
  proof: OperationEvidence<Kind, Input, NoInfer<N>>;
  scratch: Input;
};

const isPlainOperationData = (value: unknown): value is object => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return (
    Array.isArray(value) || prototype === Object.prototype || prototype === null
  );
};

type OperationCopyContext = {
  copies: WeakMap<object, object>;
  mode: "protected" | "execution";
};

type CopyOperationPropertiesOptions = OperationCopyContext & {
  source: object;
  target: object;
};

const copyOperationProperties = ({
  source,
  target,
  copies,
  mode,
}: CopyOperationPropertiesOptions) => {
  copies.set(source, target);
  for (const key of Reflect.ownKeys(source)) {
    const value: unknown = Reflect.get(source, key);
    Object.defineProperty(target, key, {
      value: copyOperationData(value, { copies, mode }),
      enumerable: Object.prototype.propertyIsEnumerable.call(source, key),
      configurable: key !== "length" || !Array.isArray(source),
      writable: true,
    });
  }
  switch (mode) {
    case "protected":
      Object.freeze(target);
      break;
    case "execution":
      break;
    default:
      mode satisfies never;
      panic("Unhandled operation copy mode");
  }
};

const copyOperationData = (
  value: unknown,
  context: OperationCopyContext,
): unknown => {
  // File content is checked by value: a caller mutating its buffer in place
  // must not change the bytes a checked writer receives.
  if (value instanceof Uint8Array) {
    const existing = context.copies.get(value);
    if (existing) {
      return existing;
    }
    const copy = Buffer.isBuffer(value)
      ? Buffer.from(value)
      : new Uint8Array(value);
    context.copies.set(value, copy);
    return copy;
  }
  if (!isPlainOperationData(value)) {
    return value;
  }
  const existing = context.copies.get(value);
  if (existing) {
    return existing;
  }
  const copy = Array.isArray(value) ? [] : {};
  Object.setPrototypeOf(copy, Reflect.getPrototypeOf(value));
  copyOperationProperties({ source: value, target: copy, ...context });
  return copy;
};

const copyOperationInput = <Input>(
  input: Input,
  mode: OperationCopyContext["mode"],
): Input => {
  if (!isPlainOperationData(input)) {
    return input;
  }
  const copy = Object.assign(Array.isArray(input) ? [] : {}, { ...input });
  Object.setPrototypeOf(copy, Reflect.getPrototypeOf(input));
  copyOperationProperties({
    source: input,
    target: copy,
    copies: new WeakMap(),
    mode,
  });
  return copy;
};

// Plain data is copied and frozen; runtime handles and functions retain their identity.
export const snapshotOperationInput = <Input>(input: Input): Input =>
  copyOperationInput(input, "protected");

// Execution owns mutable plain data copied from the checked snapshot.
export const cloneOperationInput = <Input>(input: Input): Input =>
  copyOperationInput(input, "execution");

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
    return await name(this.#input, async (input) => {
      const proof = new OperationEvidence(input, this.#prover.prove(input));
      Object.freeze(proof);
      return await run({
        input,
        proof,
        scratch: cloneOperationInput(this.#input),
      });
    });
  }
}

export type OperationAuthorization<
  Kind extends string,
  Input,
> = AuthorizedOperation<Kind, Input>;

type AuthorizeOperationOptions<Kind extends string, Input, E> = {
  kind: Kind;
  input: Input;
  check: (input: Input) => Promise<Result<void, E>>;
};

// The continuation retains exact names while operations may outlive a read transaction.
export const authorizeOperation = async <const Kind extends string, Input, E>({
  kind,
  input,
  check,
}: AuthorizeOperationOptions<Kind, Input, E>) => {
  const snapshot = snapshotOperationInput(input);
  const checked = await check(snapshot);
  if (Result.isError(checked)) {
    return Result.err(checked.error);
  }
  return Result.ok(new AuthorizedOperation(snapshot, defineProof(kind)));
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
  proof: AdmissionEvidence<Kind, Input, Admission, NoInfer<N>, NoInfer<A>>;
  scratch: Input;
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
  admit: (
    input: Input,
    run: (admission: Admission) => Promise<R>,
  ) => Promise<Outcome>;
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
>): Promise<Outcome> => {
  const snapshot = snapshotOperationInput(input);
  return await admit(
    snapshot,
    async (admission) =>
      await name(
        snapshot,
        snapshotOperationInput(admission),
        async (namedInput, namedAdmission) => {
          const proof = new AdmissionEvidence({
            input: namedInput,
            admission: namedAdmission,
            proof: defineProof(kind).prove(namedInput, namedAdmission),
          });
          Object.freeze(proof);
          return await run({
            input: namedInput,
            proof,
            admission: namedAdmission,
            scratch: cloneOperationInput(snapshot),
          });
        },
      ),
  );
};
