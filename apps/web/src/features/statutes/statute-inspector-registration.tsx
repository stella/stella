import { lazy, Suspense } from "react";

import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";

import { registerInspectorView } from "@/components/inspector/view-registry";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import { statuteDocumentIdentity } from "@/features/statutes/statute-act-number";
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
  tab,
}: InspectorRailIconProps<StatuteViewPayload>) => (
  <DocumentIdentityBadge identity={statuteDocumentIdentity(tab.payload.eli)} />
);

const StatuteView = (props: InspectorViewRenderProps<StatuteViewPayload>) => (
  <Suspense fallback={<div className="bg-background flex-1" />}>
    <LazyStatuteInspectorView
      {...props}
      key={`${props.tab.id}:${props.tab.payload.findSessionId ?? props.tab.payload.searchQuery ?? ""}`}
    />
  </Suspense>
);

// An act tab outlives the decision it was opened from: a reader who follows
// the citation and comes back finds the wording where it was.
registerInspectorView<StatuteViewPayload>({
  type: STATUTE_VIEW,
  render: StatuteView,
  railIcon: StatuteRailIcon,
  railIconInactive: "legible",
  validate: isStatuteViewPayload,
  ariaLabel: (tab) => tab.label,
});
