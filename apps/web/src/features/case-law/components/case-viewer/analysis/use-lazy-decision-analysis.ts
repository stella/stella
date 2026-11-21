import { useQuery } from "@tanstack/react-query";

import { useDecisionAnalysis } from "@/features/case-law/components/case-viewer/analysis/use-decision-analysis";
import type { DecisionAnalysisKey } from "@/features/case-law/queries/decision-analysis";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { aiAvailabilityOptions } from "@/lib/organization/ai-config-queries";

type UseLazyDecisionAnalysisOptions = DecisionAnalysisKey & {
  documentReady: boolean;
  sourceAllowsDerivedAi: boolean;
  mode: "enabled" | "gated";
};

/** The reader and inspector share the authenticated, versioned lazy generation path. */
export const useLazyDecisionAnalysis = ({
  documentReady,
  sourceAllowsDerivedAi,
  mode,
  ...key
}: UseLazyDecisionAnalysisOptions) => {
  const user = useMaybeAuthenticatedUser();
  const eligible =
    mode === "enabled" &&
    user !== null &&
    documentReady &&
    sourceAllowsDerivedAi;
  const availability = useQuery({
    ...aiAvailabilityOptions({
      organizationId: user?.activeOrganizationId ?? "",
    }),
    enabled: eligible,
  });
  const available =
    eligible && !availability.isError && availability.data?.available === true;
  const analysis = useDecisionAnalysis({ ...key, enabled: available });
  const generate = () => {
    if (!available) {
      return;
    }
    analysis.generate();
  };
  return { state: analysis.state, generate, available };
};
