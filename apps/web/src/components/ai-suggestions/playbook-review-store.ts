/**
 * Playbook-review store — holds the Findings of a "Review this
 * document with a playbook" run per active document, plus the
 * per-finding state of any one-click "Insert preferred clause" fix
 * the reviewer has applied.
 *
 * The review POST is synchronous server-side and can take up to
 * ~120s; running it from a zustand action (rather than a React
 * Query mutation tied to the facet component) keeps the in-flight
 * "Reviewing…" state alive when the reviewer switches inspector
 * facets mid-run. Mirrors the chat review pipeline's
 * `review-store.ts`: in-memory only (no persistence), keyed by
 * entity id, cleared on document close / reload.
 */

import { create } from "zustand";

import { useInspectorStore } from "@/components/inspector/inspector-store";
import { api } from "@/lib/api";
import { type toAPIError, userErrorMessage } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";

// Bound the client wait slightly above the server's 120s cap so a
// stalled connection can't hang the panel forever.
const REVIEW_CLIENT_TIMEOUT_MS = 130_000;

export type PlaybookSeverity = "blocker" | "high" | "medium" | "low";
export type PlaybookVerdict =
  | "compliant"
  | "fallback"
  | "deviation"
  | "missing";

export type PlaybookCitation = { blockId: string; text: string };
export type PlaybookFindingFix = {
  kind: "replaceBlock" | "insertAfterBlock";
  blockId: string;
  text: string;
};

export type PlaybookFinding = {
  positionId: string;
  issue: string;
  severity: PlaybookSeverity;
  verdict: PlaybookVerdict | null;
  extracted: { value: string; text: string } | null;
  rationale: string | null;
  citations: PlaybookCitation[];
  fix: PlaybookFindingFix | null;
};

/** Lifecycle of an inserted "preferred clause" tracked change. */
export type PlaybookFixStatus = "pending" | "applied" | "accepted";

export type PlaybookFixState = {
  status: PlaybookFixStatus;
  /**
   * Tracked-change revision ids returned by the editor when the fix
   * was applied. A replace carries two (deletion + insertion side),
   * an insert carries one; pass the whole list to accept/reject so
   * every mark for the fix is resolved together. Null until applied.
   */
  revisionIds: readonly number[] | null;
};

export type PlaybookReviewStatus = "idle" | "reviewing" | "error";

export type PlaybookReviewSession = {
  status: PlaybookReviewStatus;
  /** Playbook the latest run used (or is using). Null before any run. */
  playbookId: string | null;
  findings: PlaybookFinding[];
  /** Per-finding fix state, keyed by `positionId`. */
  fixState: Record<string, PlaybookFixState>;
  /** User-safe error message from the most recent failed run. */
  error: string | null;
  /** Epoch ms of the last successful run; null until one completes. */
  reviewedAt: number | null;
};

type ReviewRequestError = Parameters<typeof toAPIError>[0];

export type StartReviewResult =
  | { ok: true }
  | { ok: false; message: string; error: ReviewRequestError };

type StartReviewArgs = {
  workspaceId: string;
  playbookId: string;
  entityId: string;
  /** i18n fallback shown when a 5xx hides the raw server message. */
  unexpectedErrorMessage: string;
};

type State = {
  sessions: Record<string, PlaybookReviewSession>;
};

type Actions = {
  startReview: (args: StartReviewArgs) => Promise<StartReviewResult>;
  setFixState: (
    entityId: string,
    positionId: string,
    next: PlaybookFixState,
  ) => void;
  resetSession: (entityId: string) => void;
};

const EMPTY_SESSION: PlaybookReviewSession = {
  status: "idle",
  playbookId: null,
  findings: [],
  fixState: {},
  error: null,
  reviewedAt: null,
};

export const SEVERITY_ORDER: readonly PlaybookSeverity[] = [
  "blocker",
  "high",
  "medium",
  "low",
] as const;

export const usePlaybookReviewStore = create<State & Actions>()((set, get) => ({
  sessions: {},

  startReview: async ({
    workspaceId,
    playbookId,
    entityId,
    unexpectedErrorMessage,
  }) => {
    const existing = get().sessions[entityId];
    if (existing?.status === "reviewing") {
      return { ok: true };
    }

    set((state) => ({
      sessions: {
        ...state.sessions,
        [entityId]: {
          status: "reviewing",
          playbookId,
          findings: existing?.findings ?? [],
          fixState: existing?.fixState ?? {},
          error: null,
          reviewedAt: existing?.reviewedAt ?? null,
        },
      },
    }));

    const response = await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .playbooks({ playbookId: toSafeId<"playbookDefinition">(playbookId) })
      .review.post(
        { entityId: toSafeId<"entity">(entityId) },
        { fetch: { signal: AbortSignal.timeout(REVIEW_CLIENT_TIMEOUT_MS) } },
      );

    if (response.error) {
      const message = userErrorMessage(response.error, unexpectedErrorMessage);
      set((state) => {
        const current = state.sessions[entityId] ?? EMPTY_SESSION;
        return {
          sessions: {
            ...state.sessions,
            [entityId]: {
              status: "error",
              playbookId,
              findings: current.findings,
              fixState: current.fixState,
              error: message,
              reviewedAt: current.reviewedAt,
            },
          },
        };
      });
      return { ok: false, message, error: response.error };
    }

    set((state) => ({
      sessions: {
        ...state.sessions,
        [entityId]: {
          status: "idle",
          playbookId,
          findings: response.data,
          // A fresh run supersedes prior fixes — old revision ids
          // belong to a stale set of findings.
          fixState: {},
          error: null,
          reviewedAt: Date.now(),
        },
      },
    }));

    // Surface where the results landed (mirrors the chat review's
    // auto-switch to the Suggestions facet). Locating the tab by
    // entity id keeps this store ignorant of inspector tab internals.
    const inspectorState = useInspectorStore.getState();
    const tab = inspectorState.tabs.find(
      (candidate) =>
        candidate.type === "pdf" && candidate.entityId === entityId,
    );
    if (tab) {
      inspectorState.setFileFacet(tab.id, "playbook", { pulse: true });
    }

    return { ok: true };
  },

  setFixState: (entityId, positionId, next) => {
    set((state) => {
      const current = state.sessions[entityId];
      if (!current) {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [entityId]: {
            ...current,
            fixState: { ...current.fixState, [positionId]: next },
          },
        },
      };
    });
  },

  resetSession: (entityId) => {
    set((state) => {
      const { [entityId]: _removed, ...rest } = state.sessions;
      return { sessions: rest };
    });
  },
}));
