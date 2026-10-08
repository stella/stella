import { create } from "zustand";

import type {
  PlaybookBaseline,
  PlaybookDraft,
} from "@/features/knowledge/playbook-editor/playbook-editor.logic";
import type { PlaybookApprovalStatus } from "@/lib/knowledge/playbook-types";

import { resolveSavedPlaybookState } from "./playbook-editor-sync.logic";

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
  requiresLeaveConfirmation: boolean;
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
      requiresLeaveConfirmation: false,
    } satisfies ParkedPlaybookPane;
    return {
      ...current,
      [tabId]: { ...tab, [parkedState.playbookId]: savedState },
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
  shouldConfirm: () => boolean;
};

const leaveGuards = new Map<string, Map<string, () => boolean>>();

export const registerPlaybookPaneLeaveGuard = ({
  tabId,
  playbookId,
  shouldConfirm,
}: PaneLeaveGuardArgs) => {
  const guards = leaveGuards.get(tabId) ?? new Map<string, () => boolean>();
  guards.set(playbookId, shouldConfirm);
  leaveGuards.set(tabId, guards);
  return () => {
    if (guards.get(playbookId) === shouldConfirm) {
      guards.delete(playbookId);
    }
    if (guards.size === 0 && leaveGuards.get(tabId) === guards) {
      leaveGuards.delete(tabId);
    }
  };
};

type PaneLeaveRequest = {
  tabId: string;
  playbookId: string;
  proceed: () => void;
};

type PaneLeaveState =
  | { type: "idle" }
  | ({ type: "confirm" } & PaneLeaveRequest);

export const usePlaybookPaneLeave = create<PaneLeaveState>(() => ({
  type: "idle",
}));

export const requestPlaybookPaneLeave = ({
  tabId,
  playbookId,
  proceed,
}: PaneLeaveRequest) => {
  const liveGuard = leaveGuards.get(tabId)?.get(playbookId);
  const shouldConfirm = liveGuard
    ? liveGuard()
    : (readParkedPlaybookPane(tabId, playbookId)?.requiresLeaveConfirmation ??
      false);
  if (!shouldConfirm) {
    proceed();
    return;
  }
  usePlaybookPaneLeave.setState(
    { type: "confirm", tabId, playbookId, proceed },
    true,
  );
};

export const cancelPlaybookPaneLeave = () => {
  usePlaybookPaneLeave.setState({ type: "idle" }, true);
};

export const confirmPlaybookPaneLeave = () => {
  const request = usePlaybookPaneLeave.getState();
  cancelPlaybookPaneLeave();
  if (request.type === "confirm") {
    request.proceed();
  }
};
