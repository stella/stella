import { lazy, Suspense } from "react";

import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";

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
import { statuteDocumentIdentity } from "@/features/statutes/statute-act-number";

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
  tab,
}: InspectorRailIconProps<ProvisionViewPayload>) => (
  <DocumentIdentityBadge identity={statuteDocumentIdentity(tab.payload.eli)} />
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
  railIconInactive: "legible",
  validate: isProvisionViewPayload,
  ariaLabel: (tab) => tab.label,
});
