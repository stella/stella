import { lazy, Suspense } from "react";

import { CASE_DECISION_DETAILS_VIEW } from "@/components/inspector/case-decision-details-view";
import { isCaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import { registerInspectorView } from "@/components/inspector/view-registry";
import type { InspectorViewRenderProps } from "@/components/inspector/view-registry";
import { CaseDecisionDetailsRailIcon } from "@/features/case-law/components/case-decision-rail-icon";

const LazyCaseDecisionDetailsInspectorView = lazy(async () => {
  const module =
    await import("@/features/case-law/components/case-decision-details-inspector-view");
  return { default: module.CaseDecisionDetailsInspectorView };
});

const CaseDecisionDetailsView = (
  props: InspectorViewRenderProps<CaseDecisionViewPayload>,
) => (
  <Suspense fallback={<div className="bg-background flex-1" />}>
    <LazyCaseDecisionDetailsInspectorView {...props} />
  </Suspense>
);

registerInspectorView<CaseDecisionViewPayload>({
  type: CASE_DECISION_DETAILS_VIEW,
  render: CaseDecisionDetailsView,
  railIcon: CaseDecisionDetailsRailIcon,
  // Same court chip as the decision's own tab, so the same exemption.
  railIconInactive: "legible",
  validate: isCaseDecisionViewPayload,
  ariaLabel: (tab) => tab.label,
});
