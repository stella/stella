import { name } from "@gdp-ts/core";
import type { Named } from "@gdp-ts/core";
import { Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import { emitSignalRequest } from "@/api/handlers/signals/requests/write";
import { transitionSignal } from "@/api/handlers/signals/transition";
import type { SignalTransitionArgs } from "@/api/handlers/signals/transition";
import type { SafeId } from "@/api/lib/branded-types";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { withSignalRequestAuthorization } from "@/api/lib/signals/proofs/may-create-signal-request";
import type { MayCreateSignalRequest } from "@/api/lib/signals/proofs/may-create-signal-request";
import { withVisibleSignal } from "@/api/lib/signals/proofs/signal-visible-to";

// Planted wrong calls never run; their outcome is handed here so each call
// stays a single expression the compiler must reject.
const rejectedAtCompileTime = (outcome: unknown): unknown => outcome;

// Compile-only: these functions are never invoked.
export const signalProofMistakes = async <U, S, T, O, Other>(
  args: SignalTransitionArgs<U, S, T, O>,
  otherSignal: Named<Other, SafeId<"signal">>,
  otherActor: Named<Other, SafeId<"user">>,
  otherTransaction: Named<Other, Transaction>,
  otherOrganizationId: SafeId<"organization">,
  otherOrganization: Named<Other, SafeId<"organization">>,
) => {
  const { visibility, ...withoutProof } = args;
  // @ts-expect-error The transition requires evidence.
  rejectedAtCompileTime(await transitionSignal(withoutProof));
  rejectedAtCompileTime(
    // @ts-expect-error A raw ID has no exact value name.
    await transitionSignal({ ...args, signalId: args.signalId.value }),
  );
  rejectedAtCompileTime(
    // @ts-expect-error Evidence for one signal does not authorize another.
    await transitionSignal({ ...args, signalId: otherSignal }),
  );
  rejectedAtCompileTime(
    // @ts-expect-error The recorded actor must match the proof.
    await transitionSignal({ ...args, actorUserId: otherActor }),
  );
  rejectedAtCompileTime(
    // @ts-expect-error Evidence belongs to the transaction that checked it.
    await transitionSignal({ ...args, tx: otherTransaction }),
  );
  // @ts-expect-error A boolean is not authorization evidence.
  rejectedAtCompileTime(await transitionSignal({ ...args, visibility: true }));
  // @ts-expect-error An object literal cannot construct proof evidence.
  const fabricated: typeof visibility = {
    kind: "SignalVisibleTo",
    organizationId: visibility.organizationId,
  };
  const replaced: typeof visibility = {
    ...visibility,
    // @ts-expect-error Organization is a named proof input.
    organizationId: otherOrganizationId,
  };
  const renamed: typeof visibility = {
    ...visibility,
    // @ts-expect-error The organization name must match the proof.
    organizationId: otherOrganization,
  };
  const differentOrganization: typeof visibility = {
    kind: "SignalVisibleTo",
    // @ts-expect-error An object literal cannot construct evidence for another organization.
    organizationId: otherOrganization,
  };
  return { fabricated, replaced, renamed, differentOrganization };
};

export const signalNameMistakes = (signalId: SafeId<"signal">) => {
  // @ts-expect-error Exact names cannot escape their scope.
  const escaped = name(signalId, signalId, signalId, (signal) => signal);
  return escaped;
};

export const requestProofOrganizationMistakes = <U, W, T, O, Other>(
  proof: MayCreateSignalRequest<U, W, T, O>,
  otherOrganizationId: SafeId<"organization">,
  otherOrganization: Named<Other, SafeId<"organization">>,
) => {
  const replaced: typeof proof = {
    ...proof,
    // @ts-expect-error Organization is a named proof input.
    organizationId: otherOrganizationId,
  };
  // @ts-expect-error The organization name must match the proof.
  const renamed: typeof proof = { ...proof, organizationId: otherOrganization };
  const differentOrganization: typeof proof = {
    kind: "MayCreateSignalRequest",
    // @ts-expect-error An object literal cannot construct evidence for another organization.
    organizationId: otherOrganization,
  };
  return { replaced, renamed, differentOrganization };
};

type SignalRequestProofMistakesOptions<U, W, T, O, Other> = {
  args: Parameters<typeof emitSignalRequest<U, W, T, O>>[0];
  otherWorkspace: Named<Other, SafeId<"workspace"> | null>;
  otherActor: Named<Other, SafeId<"user">>;
  otherTransaction: Named<Other, Transaction>;
};

export const signalRequestProofMistakes = async <U, W, T, O, Other>({
  args,
  otherWorkspace,
  otherActor,
  otherTransaction,
}: SignalRequestProofMistakesOptions<U, W, T, O, Other>) => {
  const { proof, ...withoutProof } = args;
  // @ts-expect-error Request writes require evidence.
  rejectedAtCompileTime(await emitSignalRequest(withoutProof));
  rejectedAtCompileTime(
    // @ts-expect-error The recorded actor must match the proof.
    await emitSignalRequest({ ...args, actor: otherActor }),
  );
  rejectedAtCompileTime(
    // @ts-expect-error Evidence for one matter does not authorize another.
    await emitSignalRequest({ ...args, workspace: otherWorkspace }),
  );
  rejectedAtCompileTime(
    // @ts-expect-error Evidence belongs to the transaction that checked it.
    await emitSignalRequest({ ...args, tx: otherTransaction }),
  );
  rejectedAtCompileTime(
    // @ts-expect-error A raw actor ID has no exact value name.
    await emitSignalRequest({ ...args, actor: args.actor.value }),
  );
  rejectedAtCompileTime(
    // @ts-expect-error A raw matter ID has no exact value name.
    await emitSignalRequest({ ...args, workspace: args.workspace.value }),
  );
  rejectedAtCompileTime(
    // @ts-expect-error A raw transaction has no exact value name.
    await emitSignalRequest({ ...args, tx: args.tx.value }),
  );
  // @ts-expect-error A boolean is not authorization evidence.
  rejectedAtCompileTime(await emitSignalRequest({ ...args, proof: true }));
  return proof;
};

export const signalProofOutcomeInference = async (
  options: Parameters<typeof withVisibleSignal>[0],
) => {
  const outcome = await withVisibleSignal(options, async () =>
    Result.ok(await Promise.resolve({ type: "visible" } as const)),
  );
  if (Result.isError(outcome)) {
    return outcome.error.status;
  }
  return outcome.value.type satisfies "visible";
};

export const signalRequestOutcomeInference = async (
  options: Parameters<typeof withSignalRequestAuthorization>[0],
) => {
  const outcome = await withSignalRequestAuthorization(options, async () =>
    Result.ok(await Promise.resolve({ type: "created" } as const)),
  );
  if (Result.isError(outcome)) {
    return outcome.error.status;
  }
  return outcome.value.type satisfies "created";
};

export const signalProofErrorInference = async <E>(
  options: Parameters<typeof withVisibleSignal>[0],
  failure: E,
) => {
  const outcome = await withVisibleSignal(options, async () =>
    Result.err(await Promise.resolve(failure)),
  );
  if (Result.isError(outcome)) {
    return outcome.error satisfies HandlerError | E;
  }
  return undefined;
};
