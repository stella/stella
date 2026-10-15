import { lazy, Suspense } from "react";

import { useQuery } from "@tanstack/react-query";

import { ClipboardCheckIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { registerInspectorView } from "@/components/inspector/view-registry";
import type {
  InspectorRailIconProps,
  InspectorRailLabelProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import {
  discardParkedPlaybookPane,
  requestPlaybookPaneLeave,
} from "@/features/knowledge/playbook-editor/playbook-pane-parking";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import {
  isPlaybookDraftViewPayload,
  PLAYBOOK_DRAFT_VIEW,
} from "@/lib/knowledge/playbook-draft-view";
import type { PlaybookDraftViewPayload } from "@/lib/knowledge/playbook-draft-view";
import { playbookDetailOptions } from "@/lib/knowledge/queries";
import { useQueryView } from "@/lib/use-query-view";

// The kind registers with the app shell, so a tab restored after a reload
// renders on any page; the editor itself loads with the first pane opened.
const LazyPlaybookDraftView = lazy(async () => {
  const module =
    await import("@/features/knowledge/playbook-editor/playbook-draft-view");
  return { default: module.PlaybookDraftView };
});

const PlaybookDraftRailIcon = ({
  active,
}: InspectorRailIconProps<PlaybookDraftViewPayload>) => (
  <ClipboardCheckIcon className={cn("size-3.5", !active && "opacity-70")} />
);

const PlaybookDraftRailLabel = ({
  tab,
  renderLabel,
}: InspectorRailLabelProps<PlaybookDraftViewPayload>) => {
  const { activeOrganizationId } = useAuthenticatedUser();
  const detailView = useQueryView(
    useQuery({
      ...playbookDetailOptions(activeOrganizationId, tab.payload.playbookId),
      enabled: false,
    }),
  );
  const name =
    detailView.type === "items" && "name" in detailView.items
      ? detailView.items.name
      : null;
  return renderLabel(name !== null && name.trim() !== "" ? name : tab.label);
};

const PlaybookDraftViewSlot = (
  props: InspectorViewRenderProps<PlaybookDraftViewPayload>,
) => (
  <Suspense fallback={<div className="bg-background flex-1" />}>
    <LazyPlaybookDraftView {...props} />
  </Suspense>
);

registerInspectorView<PlaybookDraftViewPayload>({
  type: PLAYBOOK_DRAFT_VIEW,
  render: PlaybookDraftViewSlot,
  railIcon: PlaybookDraftRailIcon,
  railLabel: PlaybookDraftRailLabel,
  validate: isPlaybookDraftViewPayload,
  ariaLabel: (tab) => tab.label,
  beforeLeave: ({ tabId, payload, nextPayload, proceed }) => {
    if (
      isPlaybookDraftViewPayload(nextPayload) &&
      nextPayload.playbookId === payload.playbookId
    ) {
      proceed();
      return;
    }
    requestPlaybookPaneLeave({
      tabId,
      playbookId: payload.playbookId,
      proceed,
    });
  },
  onClose: discardParkedPlaybookPane,
});
