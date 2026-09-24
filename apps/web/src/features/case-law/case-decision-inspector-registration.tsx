import { lazy, Suspense } from "react";

import {
  CASE_DECISION_VIEW,
  isCaseDecisionViewPayload,
} from "@/components/inspector/case-decision-view";
import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import { registerInspectorView } from "@/components/inspector/view-registry";
import type { InspectorViewRenderProps } from "@/components/inspector/view-registry";
import { CaseDecisionRailIcon } from "@/features/case-law/components/case-decision-rail-icon";

const LazyCaseDecisionInspectorView = lazy(async () => {
  const module =
    await import("@/features/case-law/components/case-decision-inspector-view");
  return { default: module.CaseDecisionInspectorView };
});

const CaseDecisionView = (
  props: InspectorViewRenderProps<CaseDecisionViewPayload>,
) => (
  <Suspense fallback={<div className="bg-background flex-1" />}>
    <LazyCaseDecisionInspectorView {...props} />
  </Suspense>
);

registerInspectorView<CaseDecisionViewPayload>({
  type: CASE_DECISION_VIEW,
  render: CaseDecisionView,
  railIcon: CaseDecisionRailIcon,
  // The rail icon is the court's abbreviation, two or three capitals at chip
  // size: the inactive fade would take them under the contrast floor.
  railIconInactive: "legible",
  validate: isCaseDecisionViewPayload,
  ariaLabel: (tab) => tab.label,
});
