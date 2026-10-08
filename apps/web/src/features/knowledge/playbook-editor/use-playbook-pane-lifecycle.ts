import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { detached } from "@/lib/detached";

import {
  createPlaybookBaseline,
  hasPlaybookDraftChanges,
} from "./playbook-editor.logic";
import {
  completeParkedPlaybookPaneSave,
  discardParkedPlaybookPane,
  discardParkedPlaybookDraft,
  markParkedPlaybookPaneSaveFailed,
  parkPlaybookPane,
  registerPlaybookPaneLeaveGuard,
  resolvePaneDraftState,
} from "./playbook-pane-parking";
import type { ParkedPlaybookPane } from "./playbook-pane-parking";
import type { SaveOutcome } from "./use-playbook-save-queue";

type PaneLifecycleOptions = {
  host:
    | { type: "page" }
    | { type: "pane"; tabId: string; isTabOpen: (tabId: string) => boolean };
  playbookId: string | null;
  state: Omit<ParkedPlaybookPane, "playbookId" | "leaveState" | "scrollTop">;
  isDirty: boolean;
  pendingSaveCount: number;
  saveFailed: boolean;
  autosaves: boolean;
  canSave: boolean;
  nameMissing: boolean;
  invalidCount: number;
  isDeleting: () => boolean;
  wasDeleted: () => boolean;
  flush: (canSaveDraft: boolean) => Promise<SaveOutcome | null>;
  readScrollTop: () => number;
};

export const usePlaybookPaneLifecycle = ({
  host,
  playbookId,
  state,
  isDirty,
  pendingSaveCount,
  saveFailed,
  autosaves,
  canSave,
  nameMissing,
  invalidCount,
  isDeleting,
  wasDeleted,
  flush,
  readScrollTop,
}: PaneLifecycleOptions) => {
  const pane =
    host.type === "pane" && playbookId !== null
      ? { tabId: host.tabId, playbookId, isTabOpen: host.isTabOpen }
      : null;
  const valid = !nameMissing && invalidCount === 0;
  const leaveState = resolvePaneDraftState({
    isDirty: isDirty || pendingSaveCount > 0,
    canAutosave: autosaves && valid,
    saveFailed,
  });
  const capture = useLatestCallback(() => {
    if (pane === null) {
      return null;
    }
    return {
      pane,
      snapshot: {
        ...state,
        leaveState,
        scrollTop: readScrollTop(),
        playbookId: pane.playbookId,
      },
    };
  });
  type FlushParkedOptions = {
    snapshot: ParkedPlaybookPane;
    tabId: string;
    mode: "leave" | "retry";
  };
  const flushParked = useLatestCallback(
    async ({ snapshot, tabId, mode }: FlushParkedOptions) => {
      const canSaveDraft =
        !isDeleting() && canSave && valid && (mode === "retry" || autosaves);
      const outcome = await flush(canSaveDraft);
      if (outcome === null) {
        return false;
      }
      if (outcome.type !== "saved") {
        markParkedPlaybookPaneSaveFailed({ tabId, parkedState: snapshot });
        return false;
      }
      completeParkedPlaybookPaneSave({
        tabId,
        parkedState: snapshot,
        updatedAt: outcome.updatedAt,
      });
      const current = capture();
      return (
        current !== null &&
        current.pane.tabId === tabId &&
        current.pane.playbookId === snapshot.playbookId &&
        !hasPlaybookDraftChanges({
          baseline: createPlaybookBaseline(snapshot.draft),
          current: current.snapshot.draft,
        })
      );
    },
  );
  const saveBeforeLeave = useLatestCallback(async () => {
    const current = capture();
    if (current === null) {
      return false;
    }
    parkPlaybookPane({
      tabId: current.pane.tabId,
      state: current.snapshot,
      isTabOpen: current.pane.isTabOpen,
    });
    return await flushParked({
      snapshot: current.snapshot,
      tabId: current.pane.tabId,
      mode: "retry",
    });
  });

  const tabId = pane?.tabId;
  const panePlaybookId = pane?.playbookId;
  useExternalSyncEffect(() => {
    if (tabId === undefined || panePlaybookId === undefined) {
      return undefined;
    }
    if (leaveState === "saved") {
      discardParkedPlaybookDraft({ tabId, playbookId: panePlaybookId });
    }
    return registerPlaybookPaneLeaveGuard({
      tabId,
      playbookId: panePlaybookId,
      leaveState,
      saveBeforeLeave,
    });
  }, [tabId, panePlaybookId, leaveState, saveBeforeLeave]);

  return useLatestCallback(() => {
    const current = capture();
    if (current === null) {
      return;
    }
    if (wasDeleted()) {
      discardParkedPlaybookDraft({
        tabId: current.pane.tabId,
        playbookId: current.pane.playbookId,
      });
      return;
    }
    if (!current.pane.isTabOpen(current.pane.tabId)) {
      discardParkedPlaybookPane(current.pane.tabId);
      return;
    }
    parkPlaybookPane({
      tabId: current.pane.tabId,
      state: current.snapshot,
      isTabOpen: current.pane.isTabOpen,
    });
    detached(
      flushParked({
        snapshot: current.snapshot,
        tabId: current.pane.tabId,
        mode: "leave",
      }),
      "playbook-editor.flush-on-leave",
    );
  });
};
