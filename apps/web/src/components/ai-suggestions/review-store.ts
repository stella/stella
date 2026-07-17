/**
 * Review store — holds pending AI-edit suggestions per active
 * document while the user reviews them in the side panel.
 *
 * Lives in memory only (no persistence): a thread reset, document
 * close, or page reload clears the session, matching the user
 * preference that rejected items stay struck-through "until thread
 * reset".
 */

import { create } from "zustand";

import type {
  FolioAIBlockPreviewRun,
  FolioAIEditApplyMode,
  FolioAIEditOperation,
  FolioAIEditSeverity,
  FolioAIEditSnapshot,
  DocxEditorRef,
} from "@stll/folio-react";

type DocumentOperationUndoHandle = NonNullable<
  ReturnType<DocxEditorRef["applyDocumentOperations"]>["undoHandle"]
>;

export const REVIEW_UNSPECIFIED_AREA = "Unspecified";
export type ReviewSeverityKey = FolioAIEditSeverity | "unspecified";

export type ReviewSuggestionStatus =
  | "pending"
  | "applying"
  | "accepted"
  | "rejected"
  | "skipped";

/**
 * Redline preview captured at queue time so the inspector panel
 * can render an in-place mini-diff per suggestion without touching
 * the document. Carries just enough surrounding text for the
 * reviewer to recognise where the change lands; the source of
 * truth for "what will actually happen" is `pendingOperation`.
 */
export type ReviewSuggestionPreview =
  | {
      type: "replaceInBlock";
      contextBefore: string;
      before: string;
      after: string;
      contextAfter: string;
      sourceRuns?: readonly FolioAIBlockPreviewRun[];
      contextStart?: number;
      matchStart?: number;
      matchEnd?: number;
      contextEnd?: number;
    }
  | {
      type: "replaceBlock";
      before: string;
      after: string;
      sourceRuns?: readonly FolioAIBlockPreviewRun[];
    }
  | {
      type: "deleteBlock";
      before: string;
      sourceRuns?: readonly FolioAIBlockPreviewRun[];
    }
  | {
      type: "insertBeforeBlock" | "insertAfterBlock";
      /** Short excerpt of the adjacent block to anchor the insertion. */
      anchor: string;
      after: string;
      anchorRuns?: readonly FolioAIBlockPreviewRun[];
      anchorEnd?: number;
    }
  | {
      type: "commentOnBlock";
      /** Block excerpt the comment hangs off (or the optional quote). */
      anchor: string;
      anchorRuns?: readonly FolioAIBlockPreviewRun[];
      anchorEnd?: number;
    }
  | {
      type: "insertSignatureTable";
      /** Short excerpt of the anchor block the table will sit beside. */
      anchor: string;
      anchorRuns?: readonly FolioAIBlockPreviewRun[];
      anchorEnd?: number;
      /** Party names rendered in the preview, in column order. */
      parties: readonly { name: string; signatory?: string; title?: string }[];
      /** "after" (default) or "before" the anchor block. */
      position: "after" | "before";
    };

export type ReviewSuggestion = {
  /** Operation id from the AI tool call (uuid). */
  id: string;
  /** Block id the suggestion targets. */
  blockId: string;
  /**
   * Human label for the block (e.g. "čl. 2.3", "7.1") taken from
   * the snapshot the AI saw. Used in the card's meta row to anchor
   * the suggestion in the document; absent when the block had no
   * label set.
   */
  blockLabel?: string | undefined;
  /** Operation type (replaceInBlock, deleteBlock, ...). */
  type: string;
  /** Pre-formatted human summary, e.g. `Replace "30 days" with "45 days"`. */
  summary: string;
  /**
   * Redline-shaped preview the panel renders inline. Captured at
   * queue time from the snapshot we sent to the AI; immutable
   * afterwards (the document may have moved on, but the preview
   * still represents what the AI proposed against the snapshot
   * the user saw).
   */
  preview: ReviewSuggestionPreview;
  /** Optional reviewer comment text from the AI. */
  comment?: string | undefined;
  severity: ReviewSeverityKey;
  area: string;
  status: ReviewSuggestionStatus;
  /**
   * Apply mode actually used for this op. `null` until the op is
   * applied (or skipped); thereafter immutable.
   */
  applyMode: FolioAIEditApplyMode | null;
  /**
   * Tracked-change revision ids from the editor. Present when the
   * op has been applied in `tracked-changes` mode. Replace
   * operations carry two ids (deletion side + insertion side); a
   * plain insert/delete carries one. Pass the whole list to
   * accept/reject so every mark belonging to this op is cleared
   * together.
   */
  revisionIds: readonly number[] | null;
  /** Transactional handle for reversing the committed operation batch. */
  undoHandle: DocumentOperationUndoHandle | null;
  /**
   * The editor-shaped operation, kept on the suggestion for the
   * lifetime of the session. The panel feeds this to
   * `editor.applyDocumentOperations` when the user accepts. Retained
   * after Accept / Reject so a later "Revert" can put the
   * suggestion back into the pending queue without losing the
   * original op spec.
   */
  pendingOperation: FolioAIEditOperation | null;
  /**
   * The snapshot the AI saw when it generated this op. Stored per
   * batch (suggestions from the same tool call share the
   * reference), used by the apply path so the resolver always
   * looks up blockIds against the snapshot they were generated
   * for. Recomputing the snapshot from the live editor on each
   * Accept would break anchors after earlier accepts shift block
   * positions or insert new blocks.
   */
  snapshot: FolioAIEditSnapshot | null;
  /** Reason a `skipped` suggestion failed to apply. */
  skipReason?: string | undefined;
  /**
   * `true` once a server-side row exists for this suggestion (set by
   * `reconcileServerIds` after the background create, or by
   * `hydrateSuggestions` on reload). Gates every persistence call:
   * accept / reject / revert only hit the server when `persisted` is
   * `true`. Absent / `false` means the suggestion is in-memory only
   * (persistence unavailable or the create failed), so it behaves
   * exactly like the pre-persistence flow — the graceful-degradation
   * guarantee.
   */
  persisted?: boolean | undefined;
};

type ReviewState = {
  /** Per-entity (per-document) sessions, keyed by entity id. */
  sessions: Record<string, ReviewSuggestion[]>;
  /** Per-entity apply mode preference; defaults to tracked-changes. */
  applyMode: Record<string, FolioAIEditApplyMode>;
  /** Per-entity panel visibility (manual dismiss). */
  panelDismissed: Record<string, boolean>;
  /**
   * Per-entity focused suggestion id — the one the review bar's
   * prev/next stepper is currently parked on and the panel scrolls
   * into view / highlights. Shared so the floating bar and the
   * inspector panel can never disagree about which suggestion is
   * "current". `null` (or absent) when nothing is focused yet.
   */
  focusedId: Record<string, string | null>;
  /**
   * Per-entity monotonic counter bumped whenever the user clicks
   * the AI-suggestions facet chip. The chat input bar subscribes
   * and plays a one-shot glow so the user sees that the suggestions
   * they're looking at come from the chat right below — closing
   * the loop between panel and producer.
   */
  chatInputPulse: Record<string, number>;
  /**
   * Hide accepted / rejected / skipped items from the panel list so
   * the reviewer's eye stays on the pending queue. Hidden items
   * still live in the store (revert keeps working) — they're
   * filtered out at render time only. Global preference, applies
   * across all open documents.
   */
  hideAccepted: boolean;
};

type ReviewActions = {
  appendSuggestions: (entityId: string, items: ReviewSuggestion[]) => void;
  /**
   * Adopt server ids for suggestions the background create just
   * persisted. For each suggestion whose current (client) `id` is a key
   * in `refToId`, swap in the mapped server id and mark it `persisted`.
   * The entity's `focusedId` is remapped too if it pointed at a
   * reconciled client id. No-op when the entity/session is absent.
   */
  reconcileServerIds: (
    entityId: string,
    refToId: Record<string, string>,
  ) => void;
  /**
   * Merge server-loaded suggestions into the session on reload. Dedups
   * by `id` (only ids not already present are added) and never touches
   * `panelDismissed`, so hydration cannot force the panel back open.
   * Seeds a fresh session when none exists yet.
   */
  hydrateSuggestions: (entityId: string, items: ReviewSuggestion[]) => void;
  updateSuggestion: (
    entityId: string,
    id: string,
    patch: Partial<ReviewSuggestion>,
  ) => void;
  setStatusBatch: (
    entityId: string,
    ids: readonly string[],
    status: ReviewSuggestionStatus,
  ) => void;
  setApplyMode: (entityId: string, mode: FolioAIEditApplyMode) => void;
  setFocusedId: (entityId: string, id: string | null) => void;
  dismissPanel: (entityId: string) => void;
  resetSession: (entityId: string) => void;
  pulseChatInput: (entityId: string) => void;
  setHideAccepted: (value: boolean) => void;
};

/**
 * Apply the panel's filter rules to a session's suggestions, in
 * order:
 *
 * 1. `hideAccepted` drops everything except `pending` and
 *    `applying`. The "applying" status stays so the loading
 *    indicator doesn't flicker out from under the user mid-apply.
 * 2. `filter` (severity or area key, when set) keeps only
 *    matching items. `groupAxis` tells us which field to compare.
 *
 * Pulled out as a pure helper so the panel's useMemo body stays
 * thin and so the rules can be unit-tested without React.
 */
export const filterReviewSuggestions = (
  suggestions: readonly ReviewSuggestion[],
  options: {
    hideAccepted: boolean;
    filter: string | null;
    groupAxis: "severity" | "area";
  },
): readonly ReviewSuggestion[] => {
  let next: readonly ReviewSuggestion[] = suggestions;
  if (options.hideAccepted) {
    next = next.filter(
      (item) => item.status === "pending" || item.status === "applying",
    );
  }
  if (options.filter !== null) {
    next = next.filter((item) =>
      options.groupAxis === "severity"
        ? item.severity === options.filter
        : item.area === options.filter,
    );
  }
  return next;
};

/**
 * Compute initials from a display name as a fallback when the user
 * hasn't set their own in account settings. Word convention: up to
 * 3 uppercase chars taken from the leading letter of each word.
 */
export const computeInitialsFrom = (name: string): string => {
  const parts = name
    .trim()
    .split(/\s+/u)
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return "";
  }
  return parts
    .slice(0, 3)
    .map((part) => part[0]?.toLocaleUpperCase() ?? "")
    .join("");
};

export const useReviewStore = create<ReviewState & ReviewActions>()((set) => ({
  sessions: {},
  applyMode: {},
  panelDismissed: {},
  focusedId: {},
  chatInputPulse: {},
  hideAccepted: false,

  setHideAccepted: (value) => {
    set({ hideAccepted: value });
  },

  pulseChatInput: (entityId) => {
    set((state) => ({
      chatInputPulse: {
        ...state.chatInputPulse,
        [entityId]: (state.chatInputPulse[entityId] ?? 0) + 1,
      },
    }));
  },

  appendSuggestions: (entityId, items) => {
    if (items.length === 0) {
      return;
    }
    set((state) => {
      const existing = state.sessions[entityId];
      if (!existing) {
        return {
          sessions: { ...state.sessions, [entityId]: items },
        };
      }
      const existingIds = new Set(existing.map((s) => s.id));
      const fresh = items.filter((item) => !existingIds.has(item.id));
      if (fresh.length === 0) {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [entityId]: [...existing, ...fresh],
        },
        // Re-show the panel on every new batch even if previously
        // dismissed — the user just got new content to review.
        panelDismissed: {
          ...state.panelDismissed,
          [entityId]: false,
        },
      };
    });
  },

  reconcileServerIds: (entityId, refToId) => {
    set((state) => {
      const existing = state.sessions[entityId];
      if (!existing) {
        return state;
      }
      let changed = false;
      const next: ReviewSuggestion[] = [];
      for (const item of existing) {
        const serverId = refToId[item.id];
        if (serverId === undefined) {
          next.push(item);
          continue;
        }
        changed = true;
        next.push({ ...item, id: serverId, persisted: true });
      }
      if (!changed) {
        return state;
      }
      const nextState: Partial<ReviewState> = {
        sessions: { ...state.sessions, [entityId]: next },
      };
      // Keep the stepper parked on the same suggestion after its id
      // changes underneath it.
      const focused = state.focusedId[entityId];
      const remappedFocus =
        focused === null || focused === undefined
          ? undefined
          : refToId[focused];
      if (remappedFocus !== undefined) {
        nextState.focusedId = {
          ...state.focusedId,
          [entityId]: remappedFocus,
        };
      }
      return nextState;
    });
  },

  hydrateSuggestions: (entityId, items) => {
    if (items.length === 0) {
      return;
    }
    set((state) => {
      const existing = state.sessions[entityId];
      if (!existing) {
        // Seed a fresh session. Deliberately does NOT set
        // `panelDismissed` (unlike `appendSuggestions`): hydration on
        // reload must not force the review panel open.
        return {
          sessions: { ...state.sessions, [entityId]: items },
        };
      }
      const existingIds = new Set(existing.map((s) => s.id));
      const fresh = items.filter((item) => !existingIds.has(item.id));
      if (fresh.length === 0) {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [entityId]: [...existing, ...fresh],
        },
      };
    });
  },

  updateSuggestion: (entityId, id, patch) => {
    set((state) => {
      const existing = state.sessions[entityId];
      if (!existing) {
        return state;
      }
      const next: ReviewSuggestion[] = [];
      let changed = false;
      for (const item of existing) {
        if (item.id === id) {
          changed = true;
          next.push({ ...item, ...patch });
        } else {
          next.push(item);
        }
      }
      if (!changed) {
        return state;
      }
      return {
        sessions: { ...state.sessions, [entityId]: next },
      };
    });
  },

  setStatusBatch: (entityId, ids, status) => {
    if (ids.length === 0) {
      return;
    }
    set((state) => {
      const existing = state.sessions[entityId];
      if (!existing) {
        return state;
      }
      const idSet = new Set(ids);
      const next: ReviewSuggestion[] = [];
      let changed = false;
      for (const item of existing) {
        if (idSet.has(item.id) && item.status !== status) {
          changed = true;
          next.push({ ...item, status });
        } else {
          next.push(item);
        }
      }
      if (!changed) {
        return state;
      }
      return {
        sessions: { ...state.sessions, [entityId]: next },
      };
    });
  },

  setApplyMode: (entityId, mode) => {
    set((state) => ({
      applyMode: { ...state.applyMode, [entityId]: mode },
    }));
  },

  setFocusedId: (entityId, id) => {
    set((state) => {
      if ((state.focusedId[entityId] ?? null) === id) {
        return state;
      }
      return {
        focusedId: { ...state.focusedId, [entityId]: id },
      };
    });
  },

  dismissPanel: (entityId) => {
    set((state) => ({
      panelDismissed: { ...state.panelDismissed, [entityId]: true },
    }));
  },

  resetSession: (entityId) => {
    set((state) => {
      const { [entityId]: _, ...restSessions } = state.sessions;
      const { [entityId]: __, ...restDismissed } = state.panelDismissed;
      const { [entityId]: ___, ...restFocused } = state.focusedId;
      return {
        sessions: restSessions,
        panelDismissed: restDismissed,
        focusedId: restFocused,
      };
    });
  },
}));

export const getReviewFocusedId = (
  state: ReviewState,
  entityId: string,
): string | null => state.focusedId[entityId] ?? null;

export const getReviewApplyMode = (
  state: ReviewState,
  entityId: string,
): FolioAIEditApplyMode => state.applyMode[entityId] ?? "tracked-changes";

export const SEVERITY_ORDER: readonly ReviewSeverityKey[] = [
  "high",
  "medium",
  "low",
  "unspecified",
] as const;
