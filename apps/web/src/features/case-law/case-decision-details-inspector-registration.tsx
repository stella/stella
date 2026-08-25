import { lazy, Suspense } from "react";

import { InfoIcon } from "lucide-react";

import { cn } from "@stll/ui/utils";

import { CASE_DECISION_DETAILS_VIEW } from "@/components/inspector/case-decision-details-view";
import { isCaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import { registerInspectorView } from "@/components/inspector/view-registry";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";

const LazyCaseDecisionDetailsInspectorView = lazy(async () => {
  const module =
    await import("@/features/case-law/components/case-decision-details-inspector-view");
  return { default: module.CaseDecisionDetailsInspectorView };
});

const CaseDecisionDetailsRailIcon = ({
  active,
}: InspectorRailIconProps<CaseDecisionViewPayload>) => (
  <InfoIcon className={cn("size-3.5", !active && "opacity-70")} />
);

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
  navigationPolicy: "close-on-route-leave",
  validate: isCaseDecisionViewPayload,
  ariaLabel: (tab) => tab.label,
});
