import { Result, panic } from "better-result";
import { create } from "zustand";

import { Temporal } from "@stll/time";

import { createPlaybookBaseline } from "@/features/knowledge/playbook-editor/playbook-editor.logic";
import type {
  PlaybookBaseline,
  PlaybookDraft,
} from "@/features/knowledge/playbook-editor/playbook-editor.logic";
import { detached } from "@/lib/detached";
import type { PlaybookApprovalStatus } from "@/lib/knowledge/playbook-types";

import {
  draftToAdopt,
  resolveSavedPlaybookState,
} from "./playbook-editor-sync.logic";
import type { PlaybookSnapshot } from "./playbook-editor-sync.logic";
import { hasPlaybookDraftChanges } from "./playbook-editor.logic";

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
  unacknowledgedDrafts: readonly PlaybookDraft[];
  updatedAt: string | null;
  baseline: PlaybookBaseline;
  status: PlaybookApprovalStatus;
  approvedAt: string | null;
  openIds: ReadonlySet<string>;
  revealedIds: ReadonlySet<string>;
  scrollTop: number;
  leaveState: PaneDraftState;
};

type ParkedPaneEntry = {
  owner: ParkedPlaybookPane;
  state: ParkedPlaybookPane;
  write: "waiting" | "awaiting-ack" | "settled";
};

const useParkedPlaybookPanes = create<
  Readonly<Record<string, Readonly<Record<string, ParkedPaneEntry>>>>
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
      [tabId]: {
        ...current[tabId],
        [state.playbookId]: { owner: state, state, write: "settled" },
      },
    }),
    true,
  );
};

/** The state parked for this tab, if it was parked for the same playbook. */
export const readParkedPlaybookPane = (
  tabId: string,
  playbookId: string,
): ParkedPlaybookPane | null =>
  useParkedPlaybookPanes.getState()[tabId]?.[playbookId]?.state ?? null;

export const useParkedPlaybookPaneSavePending = (
  tabId: string | null,
  playbookId: string,
) =>
  useParkedPlaybookPanes(
    (tabs) =>
      tabId !== null &&
      tabs[tabId]?.[playbookId] !== undefined &&
      tabs[tabId][playbookId].write !== "settled",
  );

type BeginParkedPlaybookPaneSaveArgs = {
  tabId: string;
  parkedState: ParkedPlaybookPane;
  mode?: "flush" | "ack" | undefined;
};

export const beginParkedPlaybookPaneSave = ({
  tabId,
  parkedState,
  mode = "flush",
}: BeginParkedPlaybookPaneSaveArgs) => {
  useParkedPlaybookPanes.setState((current) => {
    const tab = current[tabId];
    const entry = tab?.[parkedState.playbookId];
    if (entry?.owner !== parkedState) {
      return current;
    }
    return {
      ...current,
      [tabId]: {
        ...tab,
        [parkedState.playbookId]: {
          owner: entry.owner,
          state: entry.state,
          write: mode === "ack" ? "awaiting-ack" : "waiting",
        },
      },
    };
  }, true);
};

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
    const entry = tab?.[parkedState.playbookId];
    if (entry?.owner !== parkedState) {
      return current;
    }
    const persisted = resolveSavedPlaybookState({
      current: entry.state,
      savedAt: updatedAt,
      savedDraft: entry.state.draft,
    });
    const savedState = {
      ...entry.state,
      unacknowledgedDrafts: [],
      updatedAt: persisted.updatedAt,
      baseline: persisted.baseline,
      status: "draft",
      approvedAt: null,
      leaveState: "saved",
    } satisfies ParkedPlaybookPane;
    return {
      ...current,
      [tabId]: {
        ...tab,
        [parkedState.playbookId]: {
          owner: entry.owner,
          state: savedState,
          write: "settled",
        },
      },
    };
  }, true);
};

type RecordParkedPlaybookPaneSaveArgs = {
  tabId: string;
  parkedState: ParkedPlaybookPane;
  savedDraft: PlaybookDraft;
  updatedAt: string | null;
};

/** Advance the baseline of the same parked owner while its final write waits. */
export const recordParkedPlaybookPaneSave = ({
  tabId,
  parkedState,
  savedDraft,
  updatedAt,
}: RecordParkedPlaybookPaneSaveArgs) => {
  useParkedPlaybookPanes.setState((current) => {
    const tab = current[tabId];
    const entry = tab?.[parkedState.playbookId];
    if (entry?.owner !== parkedState) {
      return current;
    }
    const persisted = resolveSavedPlaybookState({
      current: entry.state,
      savedAt: updatedAt,
      savedDraft,
    });
    const acknowledged = entry.state.unacknowledgedDrafts.indexOf(savedDraft);
    const unacknowledgedDrafts =
      acknowledged === -1
        ? []
        : entry.state.unacknowledgedDrafts.slice(acknowledged + 1);
    if (
      persisted === entry.state &&
      unacknowledgedDrafts.length === entry.state.unacknowledgedDrafts.length &&
      entry.write !== "awaiting-ack"
    ) {
      return current;
    }
    const state = {
      ...entry.state,
      unacknowledgedDrafts,
      updatedAt: persisted.updatedAt,
      baseline: persisted.baseline,
      status: "draft",
      approvedAt: null,
      leaveState: resolvePaneDraftState({
        isDirty:
          entry.write === "waiting" ||
          hasPlaybookDraftChanges({
            baseline: persisted.baseline,
            current: entry.state.draft,
          }),
        canAutosave: entry.state.leaveState === "dirty-autosaveable",
        saveFailed: entry.state.leaveState === "save-failed",
      }),
    } satisfies ParkedPlaybookPane;
    return {
      ...current,
      [tabId]: {
        ...tab,
        [parkedState.playbookId]: {
          owner: entry.owner,
          state,
          write: entry.write === "awaiting-ack" ? "settled" : entry.write,
        },
      },
    };
  }, true);
};

type MarkParkedPlaybookPaneSaveFailedArgs = {
  tabId: string;
  parkedState: ParkedPlaybookPane;
  server: PlaybookSnapshot | null;
  mode?: "flush" | "ack" | undefined;
};

export const markParkedPlaybookPaneSaveFailed = ({
  tabId,
  parkedState,
  server,
  mode = "flush",
}: MarkParkedPlaybookPaneSaveFailedArgs) => {
  useParkedPlaybookPanes.setState((current) => {
    const tab = current[tabId];
    const entry = tab?.[parkedState.playbookId];
    if (
      entry?.owner !== parkedState ||
      (mode === "ack" && entry.write !== "awaiting-ack")
    ) {
      return current;
    }
    const freshServer =
      server !== null &&
      (entry.state.updatedAt === null ||
        (server.updatedAt !== null &&
          Temporal.Instant.compare(
            Temporal.Instant.from(server.updatedAt),
            Temporal.Instant.from(entry.state.updatedAt),
          ) >= 0))
        ? server
        : null;
    const draft =
      freshServer === null
        ? entry.state.draft
        : draftToAdopt({
            follow: "behind",
            whenBehind: "rebase",
            baseline: entry.state.baseline.draft,
            local: entry.state.draft,
            server: freshServer.draft,
            unacknowledgedDrafts: entry.state.unacknowledgedDrafts,
          });
    if (draft === null) {
      return panic("A parked rebase must produce a draft");
    }
    const baseline =
      freshServer === null
        ? entry.state.baseline
        : createPlaybookBaseline(freshServer.draft);
    const failedState = {
      ...entry.state,
      draft,
      baseline,
      updatedAt:
        freshServer === null ? entry.state.updatedAt : freshServer.updatedAt,
      unacknowledgedDrafts:
        freshServer === null ? entry.state.unacknowledgedDrafts : [],
      status: freshServer === null ? entry.state.status : freshServer.status,
      approvedAt:
        freshServer === null ? entry.state.approvedAt : freshServer.approvedAt,
      leaveState: resolvePaneDraftState({
        isDirty:
          freshServer === null ||
          hasPlaybookDraftChanges({ baseline, current: draft }),
        canAutosave: false,
        saveFailed: true,
      }),
    } satisfies ParkedPlaybookPane;
    return {
      ...current,
      [tabId]: {
        ...tab,
        [parkedState.playbookId]: {
          owner: entry.owner,
          state: failedState,
          write: "settled",
        },
      },
    };
  }, true);
};

type PaneDraftId = { tabId: string; playbookId: string };
type PaneDraftRegistry<T> = Readonly<
  Record<string, Readonly<Record<string, T>>>
>;

const removePaneDraft = <T>(
  current: PaneDraftRegistry<T>,
  { tabId, playbookId }: PaneDraftId,
): PaneDraftRegistry<T> => {
  const tab = current[tabId];
  if (tab?.[playbookId] === undefined) {
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
};

export const discardParkedPlaybookDraft = (id: PaneDraftId) => {
  useParkedPlaybookPanes.setState(
    (current) => removePaneDraft(current, id),
    true,
  );
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

export const clearPlaybookPaneDraft = (id: PaneDraftId) => {
  const request = usePlaybookPaneLeave.getState();
  if (
    request.type !== "idle" &&
    request.tabId === id.tabId &&
    request.playbookId === id.playbookId
  ) {
    cancelPlaybookPaneLeave();
  }
  usePaneLeaveGuards.setState((current) => removePaneDraft(current, id), true);
  discardParkedPlaybookDraft(id);
};

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
      Object.values(panes).some(({ state }) => state.leaveState !== "saved"),
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
