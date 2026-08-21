import { lazy, Suspense } from "react";

import { InboxIcon } from "lucide-react";

import { cn } from "@stll/ui/utils";

import { registerInspectorView } from "@/components/inspector/view-registry";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import {
  INBOX_SIGNAL_VIEW,
  isInboxSignalViewPayload,
} from "@/features/inbox/signal-inspector.logic";
import type { InboxSignalViewPayload } from "@/features/inbox/signal-inspector.logic";

// The feed registers the kind on load; the evidence view itself arrives
// with the first card a reader opens.
const LazySignalInspectorView = lazy(async () => {
  const module =
    await import("@/features/inbox/components/signal-inspector-view");
  return { default: module.SignalInspectorView };
});

const SignalRailIcon = ({
  active,
}: InspectorRailIconProps<InboxSignalViewPayload>) => (
  <InboxIcon className={cn("size-3.5", !active && "opacity-70")} />
);

const SignalView = (
  props: InspectorViewRenderProps<InboxSignalViewPayload>,
) => (
  <Suspense fallback={<div className="bg-background flex-1" />}>
    <LazySignalInspectorView {...props} />
  </Suspense>
);

registerInspectorView<InboxSignalViewPayload>({
  type: INBOX_SIGNAL_VIEW,
  render: SignalView,
  railIcon: SignalRailIcon,
  navigationPolicy: "persist",
  validate: isInboxSignalViewPayload,
  ariaLabel: (tab) => tab.label,
});
