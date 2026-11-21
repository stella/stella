import { panic } from "better-result";

import { Temporal } from "@stll/time";

import {
  draftToAdopt,
  resolveSavedPlaybookState,
} from "./playbook-editor-sync.logic";
import type { PlaybookSnapshot } from "./playbook-editor-sync.logic";
import {
  createPlaybookBaseline,
  hasPlaybookDraftChanges,
} from "./playbook-editor.logic";
import type { PlaybookDraft } from "./playbook-editor.logic";
import {
  resolvePaneDraftState,
  updateOwnedParkedPlaybookPane,
} from "./playbook-pane-parking";
import type { ParkedPlaybookPane } from "./playbook-pane-parking";

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
  updateOwnedParkedPlaybookPane({
    tabId,
    parkedState,
    update: (entry) => {
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
        state: savedState,
        write: "settled",
      };
    },
  });
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
  updateOwnedParkedPlaybookPane({
    tabId,
    parkedState,
    update: (entry) => {
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
        unacknowledgedDrafts.length ===
          entry.state.unacknowledgedDrafts.length &&
        entry.write !== "awaiting-ack"
      ) {
        return entry;
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
        state,
        write: entry.write === "awaiting-ack" ? "settled" : entry.write,
      };
    },
  });
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
  updateOwnedParkedPlaybookPane({
    tabId,
    parkedState,
    update: (entry) => {
      if (mode === "ack" && entry.write !== "awaiting-ack") {
        return entry;
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
          freshServer === null
            ? entry.state.approvedAt
            : freshServer.approvedAt,
        leaveState: resolvePaneDraftState({
          isDirty:
            freshServer === null ||
            hasPlaybookDraftChanges({ baseline, current: draft }),
          canAutosave: false,
          saveFailed: true,
        }),
      } satisfies ParkedPlaybookPane;
      return {
        state: failedState,
        write: "settled",
      };
    },
  });
};
