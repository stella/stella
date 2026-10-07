import { name } from "@gdp-ts/core";
import type { Named } from "@gdp-ts/core";

import type { Transaction } from "@/api/db/root";
import { transitionSignal } from "@/api/handlers/signals/transition";
import type { SignalTransitionArgs } from "@/api/handlers/signals/transition";
import type { SafeId } from "@/api/lib/branded-types";
import type { MayCreateSignalRequest } from "@/api/lib/signals/proofs/may-create-signal-request";

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
  await transitionSignal(withoutProof);
  // @ts-expect-error A raw ID has no exact value name.
  await transitionSignal({ ...args, signalId: args.signalId.value });
  // @ts-expect-error Evidence for one signal does not authorize another.
  await transitionSignal({ ...args, signalId: otherSignal });
  // @ts-expect-error The recorded actor must match the proof.
  await transitionSignal({ ...args, actorUserId: otherActor });
  // @ts-expect-error Evidence belongs to the transaction that checked it.
  await transitionSignal({ ...args, tx: otherTransaction });
  // @ts-expect-error A boolean is not authorization evidence.
  await transitionSignal({ ...args, visibility: true });
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
