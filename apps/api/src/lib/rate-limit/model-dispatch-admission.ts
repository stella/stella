import { panic } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import type { ActionKind } from "@/api/lib/rate-limit/action-kinds";

const ADMITTED = Symbol("model-dispatch-admission");

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
  readonly [ADMITTED]: true;
};

/**
 * Model work with no organization to budget: public-corpus jobs, provider
 * canaries and offline evaluations.
 */
export type NoOrganizationModelDispatch = {
  readonly type: "no-organization";
  readonly [ADMITTED]: true;
};

/**
 * Mint the proof for an admitted run. Confined to the admission wrappers
 * (`scripts/ownership.ts`, `model-dispatch-admission`); call it only inside
 * the admitted run.
 */
export const admitModelDispatch = ({
  organizationId,
  actionKind,
}: {
  organizationId: SafeId<"organization">;
  actionKind: ActionKind;
}): ModelDispatchAdmission => ({
  type: "organization",
  organizationId,
  actionKind,
  [ADMITTED]: true,
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
