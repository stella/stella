import { name } from "@gdp-ts/core";
import type { Named } from "@gdp-ts/core";

import type { Transaction } from "@/api/db/root";
import { transitionSignal } from "@/api/handlers/signals/transition";
import type { SignalTransitionArgs } from "@/api/handlers/signals/transition";
import type { SafeId } from "@/api/lib/branded-types";

// Compile-only: these functions are never invoked.
export const signalProofMistakes = async <U, S, T, Other>(
  args: SignalTransitionArgs<U, S, T>,
  otherSignal: Named<Other, SafeId<"signal">>,
  otherActor: Named<Other, SafeId<"user">>,
  otherTransaction: Named<Other, Transaction>,
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
  return fabricated;
};

export const signalNameMistakes = (signalId: SafeId<"signal">) => {
  // @ts-expect-error Exact names cannot escape their scope.
  const escaped = name(signalId, signalId, signalId, (signal) => signal);
  return escaped;
};
