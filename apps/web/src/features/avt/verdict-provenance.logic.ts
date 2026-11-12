import { panic } from "better-result";

import type { VerificationClaim } from "@/features/avt/types";

type VerdictDecider = VerificationClaim["decider"];

/** A decision model id as a person reads it: `jev-1.14` is "Jev 1.14". */
export const decisionModelLabel = (model: string): string => {
  const jev = /^jev(?:-(.+))?$/u.exec(model);
  if (jev === null) {
    return model;
  }
  const version = jev.at(1);
  return version === undefined ? "Jev" : `Jev ${version}`;
};

/**
 * The quiet line under a verdict saying who decided it, or null when there
 * is nothing to tell: the generative model decided it and the decision
 * model was never asked.
 */
export type VerdictProvenanceLine =
  { type: "decision-model"; model: string } | { type: "generative" } | null;

export const verdictProvenanceLine = (
  decider: VerdictDecider,
): VerdictProvenanceLine => {
  switch (decider.kind) {
    case "decision-model": {
      return {
        type: "decision-model",
        model: decisionModelLabel(decider.model),
      };
    }
    case "llm": {
      return decider.fallback === null ? null : { type: "generative" };
    }
    default: {
      decider satisfies never;
      return panic("Unhandled verdict decider");
    }
  }
};
