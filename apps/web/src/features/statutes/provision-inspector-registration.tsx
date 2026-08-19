import { lazy, Suspense } from "react";

import { ScrollTextIcon } from "lucide-react";

import { cn } from "@stll/ui/utils";

import { registerInspectorView } from "@/components/inspector/view-registry";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import {
  isProvisionViewPayload,
  PROVISION_VIEW,
} from "@/features/statutes/provision-inspector.logic";
import type { ProvisionViewPayload } from "@/features/statutes/provision-inspector.logic";

// The reader registers the kind on load so a tab can be opened (and a synced
// tab recognised) immediately, but the view itself reads case law, diffs
// versions and drives a chat composer. None of that belongs in the statute
// route's chunk, so it arrives with the first tab a reader opens.
const LazyProvisionInspectorView = lazy(async () => {
  const module =
    await import("@/features/statutes/components/provision-inspector-view");
  return { default: module.ProvisionInspectorView };
});

const ProvisionRailIcon = ({
  active,
}: InspectorRailIconProps<ProvisionViewPayload>) => (
  <ScrollTextIcon className={cn("size-3.5", !active && "opacity-70")} />
);

const ProvisionView = (
  props: InspectorViewRenderProps<ProvisionViewPayload>,
) => (
  <Suspense fallback={<div className="bg-background flex-1" />}>
    <LazyProvisionInspectorView {...props} />
  </Suspense>
);

// A provision tab outlives the reader it was opened from: a reader who
// follows a citing decision and comes back finds the tab where it was.
registerInspectorView<ProvisionViewPayload>({
  type: PROVISION_VIEW,
  render: ProvisionView,
  railIcon: ProvisionRailIcon,
  navigationPolicy: "persist",
  validate: isProvisionViewPayload,
  ariaLabel: (tab) => tab.label,
});
