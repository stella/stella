import { lazy, Suspense } from "react";

import { ScrollTextIcon } from "lucide-react";

import { cn } from "@stll/ui/utils";

import { registerInspectorView } from "@/components/inspector/view-registry";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import {
  isStatuteViewPayload,
  STATUTE_VIEW,
} from "@/features/statutes/statute-inspector.logic";
import type { StatuteViewPayload } from "@/features/statutes/statute-inspector.logic";

// The reader registers the kind on load so a tab can be opened (and a synced
// tab recognised) immediately, while the view itself pulls the whole statute
// reader. That chunk arrives with the first act a reader opens.
const LazyStatuteInspectorView = lazy(async () => {
  const module =
    await import("@/features/statutes/components/statute-inspector-view");
  return { default: module.StatuteInspectorView };
});

const StatuteRailIcon = ({
  active,
}: InspectorRailIconProps<StatuteViewPayload>) => (
  <ScrollTextIcon className={cn("size-3.5", !active && "opacity-70")} />
);

const StatuteView = (props: InspectorViewRenderProps<StatuteViewPayload>) => (
  <Suspense fallback={<div className="bg-background flex-1" />}>
    <LazyStatuteInspectorView {...props} />
  </Suspense>
);

// An act tab outlives the decision it was opened from: a reader who follows
// the citation and comes back finds the wording where it was.
registerInspectorView<StatuteViewPayload>({
  type: STATUTE_VIEW,
  render: StatuteView,
  railIcon: StatuteRailIcon,
  navigationPolicy: "persist",
  validate: isStatuteViewPayload,
  ariaLabel: (tab) => tab.label,
});
