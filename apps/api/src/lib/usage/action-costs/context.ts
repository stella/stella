import { AsyncLocalStorage } from "node:async_hooks";

import type { SafeId } from "@/api/lib/branded-types";

export const ACTION_COST_CALL_KIND = {
  registryRequest: "registry_request",
  corpusRequest: "corpus_request",
} as const;

export type ActionCostIdentity = {
  organizationId: SafeId<"organization">;
  actionKind: string;
  logicalPhaseId: string;
};

export type ActionCostRecord = ActionCostIdentity & {
  userId: SafeId<"user"> | null;
  admittedAt: Date;
  settledAt: Date | null;
  estimatedMicroUnits: number | null;
};

export type ActionCostCall = ActionCostIdentity & {
  callId: string;
  kind: string;
  occurredAt: Date;
  measuredMicroUnits: number | null;
};

export type ActionCostObservation =
  | { type: "action"; record: ActionCostRecord }
  | { type: "call"; record: ActionCostCall };

export type ActionCostRecorder = {
  enqueue: (observation: ActionCostObservation) => void;
  estimate: (kind: string) => number | null;
  callRate: (kind: string) => number | null;
};

type ActionCostScope = {
  identity: ActionCostIdentity;
  recorder: ActionCostRecorder;
  status: "active" | "settled";
};
const actionCostScope = new AsyncLocalStorage<ActionCostScope>();

export const currentActionCostIdentity = (
  organizationId: SafeId<"organization">,
): ActionCostIdentity | undefined => {
  const scope = actionCostScope.getStore();
  if (scope?.identity.organizationId === organizationId) {
    return scope.identity;
  }
  return undefined;
};

export const recordExternalActionCall = (kind: string): void => {
  const scope = actionCostScope.getStore();
  if (scope?.status !== "active") {
    return;
  }
  scope.recorder.enqueue({
    type: "call",
    record: {
      ...scope.identity,
      callId: Bun.randomUUIDv7(),
      kind,
      occurredAt: new Date(),
      measuredMicroUnits: scope.recorder.callRate(kind),
    },
  });
};

type RunObservedActionOptions<T> = {
  identity: ActionCostIdentity;
  userId: SafeId<"user"> | null;
  recorder: ActionCostRecorder;
  run: () => Promise<T>;
};

export const runObservedAction = async <T>({
  identity,
  userId,
  recorder,
  run,
}: RunObservedActionOptions<T>): Promise<T> => {
  const inherited = actionCostScope.getStore();
  if (
    inherited?.status === "active" &&
    inherited.identity.organizationId === identity.organizationId &&
    inherited.identity.actionKind === identity.actionKind &&
    inherited.identity.logicalPhaseId === identity.logicalPhaseId
  ) {
    return await run();
  }
  const record = {
    ...identity,
    userId,
    admittedAt: new Date(),
    settledAt: null,
    estimatedMicroUnits: recorder.estimate(identity.actionKind),
  };
  recorder.enqueue({ type: "action", record });
  const scope: ActionCostScope = { identity, recorder, status: "active" };
  return await actionCostScope.run(scope, async () => {
    try {
      return await run();
    } finally {
      scope.status = "settled";
      recorder.enqueue({
        type: "action",
        record: { ...record, settledAt: new Date() },
      });
    }
  });
};
