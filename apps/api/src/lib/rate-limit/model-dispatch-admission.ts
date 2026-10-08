import { panic, TaggedError } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import type { ActionKind } from "@/api/lib/rate-limit/action-kinds";

const ADMITTED = Symbol("model-dispatch-admission");

/** Whether the admitted action a proof was minted for still holds its slot. */
type AdmittedHold = { status: "held" | "settled" };

class ModelDispatchAdmissionSettledError extends TaggedError(
  "ModelDispatchAdmissionSettledError",
)<{ message: string }> {}

/**
 * Proof that a model dispatch for an organization runs inside an admitted
 * action. Only the admission wrappers mint one, inside their admitted run, and
 * every model dispatch requires one, so a path without admission does not
 * compile. A step of a larger action (a subagent, an in-turn compaction, a
 * workflow batch) dispatches on its parent's proof: `actionKind` names the
 * action that admitted the work, and the step is never admitted again.
 */
export type ModelDispatchAdmission = {
  readonly type: "organization";
  readonly organizationId: SafeId<"organization">;
  readonly actionKind: ActionKind;
  /**
   * Aborts when the admitted action loses its lease or settles. Every
   * dispatch on the proof combines it with its own signal, so model work
   * never outruns the slot that admitted it.
   */
  readonly signal: AbortSignal;
  readonly [ADMITTED]: AdmittedHold;
};

/**
 * Model work with no organization to budget: public-corpus jobs, provider
 * canaries and offline evaluations.
 */
export type NoOrganizationModelDispatch = {
  readonly type: "no-organization";
  readonly [ADMITTED]: true;
};

type AdmitModelDispatchOptions<T> = {
  organizationId: SafeId<"organization">;
  actionKind: ActionKind;
  /** The admitted action's lease signal. */
  signal: AbortSignal;
  run: (admission: ModelDispatchAdmission) => Promise<T>;
};

/**
 * Run admitted work with its dispatch proof. Confined to the admission
 * wrappers (`scripts/ownership.ts`, `model-dispatch-admission`), which call it
 * inside the run they admitted. The proof lives exactly as long as `run`:
 * when `run` settles, its signal aborts and any later dispatch on it panics,
 * so work that outlives its admission (a detached generation, a proof
 * returned out of the admitted callback) cannot reach a model.
 */
export const admitModelDispatch = async <T>({
  organizationId,
  actionKind,
  signal,
  run,
}: AdmitModelDispatchOptions<T>): Promise<T> => {
  const settled = new AbortController();
  const hold: AdmittedHold = { status: "held" };
  try {
    return await run({
      type: "organization",
      organizationId,
      actionKind,
      signal: AbortSignal.any([signal, settled.signal]),
      [ADMITTED]: hold,
    });
  } finally {
    hold.status = "settled";
    settled.abort(
      new ModelDispatchAdmissionSettledError({
        message: "The admitted action settled",
      }),
    );
  }
};

/**
 * A proof for a fixture organization that no admission holds, for offline
 * evaluations and tests that dispatch below the admission wrappers. Its
 * signal never aborts.
 */
export const admitFixtureModelDispatch = ({
  organizationId,
  actionKind,
}: {
  organizationId: SafeId<"organization">;
  actionKind: ActionKind;
}): ModelDispatchAdmission => ({
  type: "organization",
  organizationId,
  actionKind,
  signal: new AbortController().signal,
  [ADMITTED]: { status: "held" },
});

export const NO_ORGANIZATION_MODEL_DISPATCH: NoOrganizationModelDispatch = {
  type: "no-organization",
  [ADMITTED]: true,
};

/**
 * A chat tool set built for a run carries its turn's proof; one built only to
 * validate or name tools never executes, so it has none. A model-backed tool
 * reaching a dispatch without the proof is a wiring defect.
 */
export const requireChatToolModelAdmission = (
  admission: ModelDispatchAdmission | undefined,
): ModelDispatchAdmission =>
  admission ?? panic("A chat tool dispatched a model outside an admitted turn");

/** Who a dispatch serves, and the proof that its work was admitted. */
export type ModelDispatchScope =
  | {
      organizationId: SafeId<"organization">;
      admission: ModelDispatchAdmission;
    }
  | {
      organizationId: null;
      admission: NoOrganizationModelDispatch;
    };

/** A proof minted for one organization never admits another's dispatch. */
export const assertModelDispatchScope = ({
  organizationId,
  admission,
}: ModelDispatchScope): void => {
  switch (admission.type) {
    case "organization":
      if (admission.organizationId !== organizationId) {
        panic("Model dispatch carries another organization's admission");
      }
      if (admission[ADMITTED].status === "settled") {
        panic("Model dispatch outlived the action that admitted it");
      }
      return;
    case "no-organization":
      if (organizationId !== null) {
        panic("Organization model dispatch carries no admission");
      }
      return;
    default:
      admission satisfies never;
      panic("Unhandled model dispatch admission");
  }
};

/**
 * The signal a dispatch runs under: its own, combined with its admission's,
 * after checking the proof still admits it.
 */
export const admittedDispatchSignal = ({
  abortSignal,
  ...scope
}: ModelDispatchScope & {
  abortSignal?: AbortSignal | undefined;
}): AbortSignal | undefined => {
  assertModelDispatchScope(scope);
  switch (scope.admission.type) {
    case "organization":
      return abortSignal === undefined
        ? scope.admission.signal
        : AbortSignal.any([abortSignal, scope.admission.signal]);
    case "no-organization":
      return abortSignal;
    default:
      scope.admission satisfies never;
      return panic("Unhandled model dispatch admission");
  }
};
