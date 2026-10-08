import { lazy, Suspense } from "react";

import { ClipboardCheckIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { registerInspectorView } from "@/components/inspector/view-registry";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import {
  isPlaybookDraftViewPayload,
  PLAYBOOK_DRAFT_VIEW,
} from "@/lib/knowledge/playbook-draft-view";
import {
  discardParkedPlaybookPane,
  requestPlaybookPaneLeave,
} from "@/features/knowledge/playbook-editor/playbook-pane-parking";
import type { PlaybookDraftViewPayload } from "@/lib/knowledge/playbook-draft-view";

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
