import { lazy, Suspense } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";

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
import { queryView } from "@/lib/query-view.logic";

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

type PlaybookRailLabelProps = {
  playbookId: string;
  fallback: string;
  renderLabel: InspectorRailLabelProps<PlaybookDraftViewPayload>["renderLabel"];
};

const PlaybookRailLabel = ({
  playbookId,
  fallback,
  renderLabel,
}: PlaybookRailLabelProps) => {
  const { activeOrganizationId } = useAuthenticatedUser();
  const detailView = queryView(
    useQuery({
      ...playbookDetailOptions(activeOrganizationId, playbookId),
      enabled: false,
    }),
  );
  const name =
    detailView.type === "items" && "name" in detailView.items
      ? detailView.items.name
      : null;
  return renderLabel(name !== null && name.trim() !== "" ? name : fallback);
};

const PlaybookDraftRailLabel = ({
  tab,
  renderLabel,
}: InspectorRailLabelProps<PlaybookDraftViewPayload>) => {
  switch (tab.payload.type) {
    case "pending":
      return renderLabel(tab.label);
    case "playbook":
      return (
        <PlaybookRailLabel
          fallback={tab.label}
          playbookId={tab.payload.playbookId}
          renderLabel={renderLabel}
        />
      );
    default:
      tab.payload satisfies never;
      return panic("Unhandled playbook pane payload");
  }
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
    switch (payload.type) {
      case "pending":
        proceed();
        return;
      case "playbook":
        if (
          isPlaybookDraftViewPayload(nextPayload) &&
          nextPayload.type === "playbook" &&
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
        return;
      default:
        payload satisfies never;
        panic("Unhandled playbook pane payload");
    }
  },
  onClose: discardParkedPlaybookPane,
});
