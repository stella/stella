import { lazy, Suspense } from "react";

import { ScaleIcon } from "lucide-react";

import { cn } from "@stll/ui/utils";

import { registerInspectorView } from "@/components/inspector/view-registry";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import {
  CASE_DECISION_VIEW,
  isCaseDecisionViewPayload,
} from "@/features/case-law/case-decision-inspector.logic";
import type { CaseDecisionViewPayload } from "@/features/case-law/case-decision-inspector.logic";

const LazyCaseDecisionInspectorView = lazy(async () => {
  const module =
    await import("@/features/case-law/components/case-decision-inspector-view");
  return { default: module.CaseDecisionInspectorView };
});

const CaseDecisionRailIcon = ({
  active,
}: InspectorRailIconProps<CaseDecisionViewPayload>) => (
  <ScaleIcon className={cn("size-3.5", !active && "opacity-70")} />
);

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
  navigationPolicy: "persist",
  validate: isCaseDecisionViewPayload,
  ariaLabel: (tab) => tab.label,
});
