import { lazy, Suspense } from "react";

import { FileTextIcon, InfoIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import type { InspectorRailIconProps } from "@/components/inspector/view-registry";

const LazyCaseDecisionRailIcon = lazy(async () => {
  const module = await import("./case-decision-rail-icon");
  return { default: module.CaseDecisionRailIcon };
});

const fallback = (active: boolean) => (
  <FileTextIcon className={cn("size-3.5", !active && "opacity-70")} />
);

export const CaseDecisionRailIcon = (
  props: InspectorRailIconProps<CaseDecisionViewPayload>,
) => (
  <Suspense fallback={fallback(props.active)}>
    <LazyCaseDecisionRailIcon {...props} />
  </Suspense>
);

export const CaseDecisionDetailsRailIcon = (
  props: InspectorRailIconProps<CaseDecisionViewPayload>,
) => (
  <span className="relative inline-flex">
    <CaseDecisionRailIcon {...props} />
    <InfoIcon
      aria-hidden="true"
      className={cn(
        "bg-background text-muted-foreground absolute -end-1 -bottom-1 size-2.5 rounded-full",
        !props.active && "opacity-70",
      )}
    />
  </span>
);
