import type { DecisionGenerator } from "@/api/lib/workflow/decisions/decide";
import { SystemOneError } from "@/api/lib/workflow/decisions/system-one";

export const failingDecisionGenerator: DecisionGenerator = async () =>
  Promise.reject(
    new SystemOneError({
      message: "Generative decision unavailable in this fixture",
      kind: "network",
    }),
  );
