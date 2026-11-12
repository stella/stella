/**
 * How one review history entry reads: what the reviewer did, in words, and
 * what it changed. The server folds where the claim stood before and after
 * each action; this only decides which of those changes to show.
 */

import { panic } from "better-result";

import type {
  ClaimDisposition,
  ClaimReviewStatus,
  ClaimState,
  ReviewHistoryEntry,
} from "@/features/avt/types";
import type { TranslationKey } from "@/i18n/types";

/** The verdict a reviewer reads: their override when they gave one, else the
 *  verdict their decisions lead to. */
const shownVerdict = ({ verdict, override }: ClaimDisposition): ClaimState =>
  override ?? verdict;

export type HistoryChange =
  | { type: "verdict"; before: ClaimState; after: ClaimState }
  | {
      type: "status";
      before: ClaimReviewStatus | null;
      after: ClaimReviewStatus | null;
    };

/** The verdict and status an action moved, in that order; nothing for an
 *  action that left both where they were (a note). */
export const historyChanges = ({
  before,
  after,
}: Pick<ReviewHistoryEntry, "before" | "after">): HistoryChange[] => {
  const changes: HistoryChange[] = [];
  if (shownVerdict(before) !== shownVerdict(after)) {
    changes.push({
      type: "verdict",
      before: shownVerdict(before),
      after: shownVerdict(after),
    });
  }
  if (before.status !== after.status) {
    changes.push({
      type: "status",
      before: before.status,
      after: after.status,
    });
  }
  return changes;
};

/** Every sentence an action can read as, so a caller's `t` sees a small
 *  union of keys rather than the whole catalogue. */
const ACTION_KEYS = {
  statusReviewed: "avt.history.actions.statusReviewed",
  statusDisputed: "avt.history.actions.statusDisputed",
  statusNeedsEvidence: "avt.history.actions.statusNeedsEvidence",
  statusCleared: "avt.history.actions.statusCleared",
  acceptedRoutine: "avt.history.actions.acceptedRoutine",
  overridden: "avt.history.actions.overridden",
  overrideWithdrawn: "avt.history.actions.overrideWithdrawn",
  noteSaved: "avt.history.actions.noteSaved",
  noteCleared: "avt.history.actions.noteCleared",
  reopened: "avt.history.actions.reopened",
  governed: "avt.history.actions.governed",
  escalated: "avt.history.actions.escalated",
  conflictReopened: "avt.history.actions.conflictReopened",
  factLinked: "avt.history.actions.factLinked",
  factUnlinked: "avt.history.actions.factUnlinked",
  rechecked: "avt.history.actions.rechecked",
} as const satisfies Record<string, TranslationKey>;

type HistoryActionKey = (typeof ACTION_KEYS)[keyof typeof ACTION_KEYS];

const STATUS_ACTION_KEYS = {
  reviewed: ACTION_KEYS.statusReviewed,
  disputed: ACTION_KEYS.statusDisputed,
  "needs-evidence": ACTION_KEYS.statusNeedsEvidence,
} as const satisfies Record<ClaimReviewStatus, HistoryActionKey>;

/** What the reviewer did, as one sentence. */
export const historyActionKey = ({
  action,
}: Pick<ReviewHistoryEntry, "action">): HistoryActionKey => {
  switch (action.kind) {
    case "status": {
      if (action.origin === "bulk") {
        return ACTION_KEYS.acceptedRoutine;
      }
      return action.status === null
        ? ACTION_KEYS.statusCleared
        : STATUS_ACTION_KEYS[action.status];
    }
    case "override": {
      return action.state === null
        ? ACTION_KEYS.overrideWithdrawn
        : ACTION_KEYS.overridden;
    }
    case "note": {
      return action.note === ""
        ? ACTION_KEYS.noteCleared
        : ACTION_KEYS.noteSaved;
    }
    case "reopen": {
      return ACTION_KEYS.reopened;
    }
    case "record-conflict": {
      const resolution = action.resolution;
      if (resolution === null) {
        return ACTION_KEYS.conflictReopened;
      }
      switch (resolution.kind) {
        case "governed": {
          return ACTION_KEYS.governed;
        }
        case "escalated": {
          return ACTION_KEYS.escalated;
        }
        default: {
          resolution satisfies never;
          return panic(`Unhandled resolution: ${String(resolution)}`);
        }
      }
    }
    case "fact-link": {
      return action.change === "link"
        ? ACTION_KEYS.factLinked
        : ACTION_KEYS.factUnlinked;
    }
    case "recheck": {
      return ACTION_KEYS.rechecked;
    }
    default: {
      action satisfies never;
      return panic(`Unhandled review action: ${String(action)}`);
    }
  }
};
