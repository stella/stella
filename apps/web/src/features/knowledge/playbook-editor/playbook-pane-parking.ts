import { Result } from "better-result";
import { create } from "zustand";

import type {
  PlaybookBaseline,
  PlaybookDraft,
} from "@/features/knowledge/playbook-editor/playbook-editor.logic";
import { detached } from "@/lib/detached";
import type { PlaybookApprovalStatus } from "@/lib/knowledge/playbook-types";

import { resolveSavedPlaybookState } from "./playbook-editor-sync.logic";

export type PaneDraftState =
  | "saved"
  | "dirty-autosaveable"
  | "dirty-unsaveable"
  | "save-failed";

type ResolvePaneDraftStateArgs = {
  isDirty: boolean;
  canAutosave: boolean;
  saveFailed: boolean;
};

export const resolvePaneDraftState = ({
  isDirty,
  canAutosave,
  saveFailed,
}: ResolvePaneDraftStateArgs): PaneDraftState => {
  if (!isDirty) {
    return "saved";
  }
  if (saveFailed) {
    return "save-failed";
  }
  return canAutosave ? "dirty-autosaveable" : "dirty-unsaveable";
};

/**
 * The pane editor unmounts whenever the user opens another inspector tab or
 * minimizes the pane. Its state is parked here on unmount and restored on the
 * next mount, so leaving the tab keeps what a save could not: an invalid
 * draft, or unsaved edits to an approved playbook.
 *
 * The draft, its baseline and its token are parked together, so a restored
 * token is never paired with a different draft. In memory only: a reload
 * starts from the server.
 */
export type ParkedPlaybookPane = {
  playbookId: string;
  draft: PlaybookDraft;
  updatedAt: string | null;
  baseline: PlaybookBaseline;
  status: PlaybookApprovalStatus;
  approvedAt: string | null;
  openIds: ReadonlySet<string>;
  revealedIds: ReadonlySet<string>;
  scrollTop: number;
  leaveState: PaneDraftState;
};

const useParkedPlaybookPanes = create<
  Readonly<Record<string, Readonly<Record<string, ParkedPlaybookPane>>>>
>(() => ({}));

type ParkPlaybookPaneArgs = {
  tabId: string;
  state: ParkedPlaybookPane;
  /** Entries of tabs closed while their editor was not mounted are dropped. */
  isTabOpen: (tabId: string) => boolean;
};

export const parkPlaybookPane = ({
  tabId,
  state,
  isTabOpen,
}: ParkPlaybookPaneArgs) => {
  useParkedPlaybookPanes.setState(
    (current) => ({
      ...Object.fromEntries(
        Object.entries(current).filter(([id]) => isTabOpen(id)),
      ),
      [tabId]: { ...current[tabId], [state.playbookId]: state },
    }),
    true,
  );
};

/** The state parked for this tab, if it was parked for the same playbook. */
export const readParkedPlaybookPane = (
  tabId: string,
  playbookId: string,
): ParkedPlaybookPane | null =>
  useParkedPlaybookPanes.getState()[tabId]?.[playbookId] ?? null;

type CompleteParkedPlaybookPaneSaveArgs = {
  tabId: string;
  parkedState: ParkedPlaybookPane;
  updatedAt: string | null;
};

export const completeParkedPlaybookPaneSave = ({
  tabId,
  parkedState,
  updatedAt,
}: CompleteParkedPlaybookPaneSaveArgs) => {
  useParkedPlaybookPanes.setState((current) => {
    const tab = current[tabId];
    if (tab?.[parkedState.playbookId] !== parkedState) {
      return current;
    }
    const persisted = resolveSavedPlaybookState({
      current: parkedState,
      savedAt: updatedAt,
      savedDraft: parkedState.draft,
    });
    if (persisted === parkedState) {
      return current;
    }
    const savedState = {
      ...parkedState,
      updatedAt: persisted.updatedAt,
      baseline: persisted.baseline,
      status: "draft",
      approvedAt: null,
      leaveState: "saved",
    } satisfies ParkedPlaybookPane;
    return {
      ...current,
      [tabId]: { ...tab, [parkedState.playbookId]: savedState },
    };
  }, true);
};

type MarkParkedPlaybookPaneSaveFailedArgs = {
  tabId: string;
  parkedState: ParkedPlaybookPane;
};

export const markParkedPlaybookPaneSaveFailed = ({
  tabId,
  parkedState,
}: MarkParkedPlaybookPaneSaveFailedArgs) => {
  useParkedPlaybookPanes.setState((current) => {
    const tab = current[tabId];
    if (tab?.[parkedState.playbookId] !== parkedState) {
      return current;
    }
    const failedState = {
      ...parkedState,
      leaveState: "save-failed",
    } satisfies ParkedPlaybookPane;
    return {
      ...current,
      [tabId]: { ...tab, [parkedState.playbookId]: failedState },
    };
  }, true);
};

export const discardParkedPlaybookPane = (tabId: string) => {
  useParkedPlaybookPanes.setState(
    (current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => id !== tabId),
      ),
    true,
  );
};

type PaneLeaveGuardArgs = {
  tabId: string;
  playbookId: string;
  leaveState: PaneDraftState;
  saveBeforeLeave: () => Promise<boolean>;
};

type PaneLeaveGuard = Pick<
  PaneLeaveGuardArgs,
  "leaveState" | "saveBeforeLeave"
>;
type PaneLeaveGuards = Readonly<
  Record<string, Readonly<Record<string, PaneLeaveGuard>>>
>;

const usePaneLeaveGuards = create<PaneLeaveGuards>(() => ({}));

export const registerPlaybookPaneLeaveGuard = ({
  tabId,
  playbookId,
  leaveState,
  saveBeforeLeave,
}: PaneLeaveGuardArgs) => {
  const registration = { leaveState, saveBeforeLeave };
  usePaneLeaveGuards.setState(
    (current) => ({
      ...current,
      [tabId]: { ...current[tabId], [playbookId]: registration },
    }),
    true,
  );
  return () => {
    usePaneLeaveGuards.setState((current) => {
      const tab = current[tabId];
      if (tab?.[playbookId] !== registration) {
        return current;
      }
      const remaining = Object.fromEntries(
        Object.entries(tab).filter(([id]) => id !== playbookId),
      );
      if (Object.keys(remaining).length > 0) {
        return { ...current, [tabId]: remaining };
      }
      return Object.fromEntries(
        Object.entries(current).filter(([id]) => id !== tabId),
      );
    }, true);
  };
};

export const usePlaybookPaneHasUnsavedWork = () => {
  const liveDirty = usePaneLeaveGuards((tabs) =>
    Object.values(tabs).some((panes) =>
      Object.values(panes).some(({ leaveState }) => leaveState !== "saved"),
    ),
  );
  const parkedDirty = useParkedPlaybookPanes((tabs) =>
    Object.values(tabs).some((panes) =>
      Object.values(panes).some(({ leaveState }) => leaveState !== "saved"),
    ),
  );
  return liveDirty || parkedDirty;
};

type PaneLeaveRequest = {
  tabId: string;
  playbookId: string;
  proceed: () => void;
};

type PaneLeaveState =
  | { type: "idle" }
  | ({ type: "waiting" } & PaneLeaveRequest)
  | ({
      type: "confirm";
      phase: "ready" | "saving";
      leaveState: "dirty-unsaveable" | "save-failed";
      saveBeforeLeave: (() => Promise<boolean>) | null;
    } & PaneLeaveRequest);

export const usePlaybookPaneLeave = create<PaneLeaveState>(() => ({
  type: "idle",
}));

let pendingLeaveCleanup: (() => void) | null = null;

export const cancelPlaybookPaneLeave = () => {
  pendingLeaveCleanup?.();
  pendingLeaveCleanup = null;
  usePlaybookPaneLeave.setState({ type: "idle" }, true);
};

export const requestPlaybookPaneLeave = ({
  tabId,
  playbookId,
  proceed,
}: PaneLeaveRequest) => {
  cancelPlaybookPaneLeave();
  const liveGuard = usePaneLeaveGuards.getState()[tabId]?.[playbookId];
  const leaveState =
    liveGuard?.leaveState ??
    readParkedPlaybookPane(tabId, playbookId)?.leaveState ??
    "saved";
  const confirm = (state: "dirty-unsaveable" | "save-failed") => {
    usePlaybookPaneLeave.setState(
      {
        type: "confirm",
        phase: "ready",
        leaveState: state,
        tabId,
        playbookId,
        proceed,
        saveBeforeLeave:
          usePaneLeaveGuards.getState()[tabId]?.[playbookId]?.saveBeforeLeave ??
          null,
      },
      true,
    );
  };
  if (leaveState === "saved") {
    proceed();
    return;
  }
  if (leaveState !== "dirty-autosaveable") {
    confirm(leaveState);
    return;
  }
  const waitingRequest = {
    type: "waiting",
    tabId,
    playbookId,
    proceed,
  } as const satisfies PaneLeaveState;
  usePlaybookPaneLeave.setState(waitingRequest, true);
  if (liveGuard !== undefined) {
    const saveAndLeave = async () => {
      const result = await Result.tryPromise({
        try: liveGuard.saveBeforeLeave,
        catch: (error) => error,
      });
      if (usePlaybookPaneLeave.getState() !== waitingRequest) {
        return;
      }
      if (Result.isError(result) || !result.value) {
        confirm("save-failed");
        return;
      }
      cancelPlaybookPaneLeave();
      proceed();
    };
    detached(saveAndLeave(), "playbook-pane.save-before-leave");
    return;
  }
  const followParkedSave = () => {
    if (usePlaybookPaneLeave.getState() !== waitingRequest) {
      return;
    }
    const state = readParkedPlaybookPane(tabId, playbookId);
    if (state?.leaveState === "dirty-autosaveable") {
      return;
    }
    pendingLeaveCleanup?.();
    pendingLeaveCleanup = null;
    if (state === null) {
      cancelPlaybookPaneLeave();
      return;
    }
    if (state.leaveState !== "saved") {
      confirm(state.leaveState);
      return;
    }
    cancelPlaybookPaneLeave();
    proceed();
  };
  pendingLeaveCleanup = useParkedPlaybookPanes.subscribe(followParkedSave);
  followParkedSave();
};

export const confirmPlaybookPaneLeave = async () => {
  const request = usePlaybookPaneLeave.getState();
  if (request.type !== "confirm" || request.phase === "saving") {
    return;
  }
  if (request.leaveState !== "save-failed") {
    cancelPlaybookPaneLeave();
    request.proceed();
    return;
  }
  if (request.saveBeforeLeave === null) {
    return;
  }
  const savingRequest = {
    type: "confirm",
    phase: "saving",
    leaveState: request.leaveState,
    tabId: request.tabId,
    playbookId: request.playbookId,
    proceed: request.proceed,
    saveBeforeLeave: request.saveBeforeLeave,
  } as const satisfies PaneLeaveState;
  usePlaybookPaneLeave.setState(savingRequest, true);
  const result = await Result.tryPromise({
    try: request.saveBeforeLeave,
    catch: (error) => error,
  });
  if (usePlaybookPaneLeave.getState() !== savingRequest) {
    return;
  }
  if (Result.isError(result) || !result.value) {
    usePlaybookPaneLeave.setState(request, true);
    return;
  }
  cancelPlaybookPaneLeave();
  request.proceed();
};
