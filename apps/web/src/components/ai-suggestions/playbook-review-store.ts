/**
 * In-memory document-review sessions. A review can use an authored playbook,
 * reference documents, or both. The two result groups stay separate so
 * reference examples can never change an authoritative playbook verdict.
 */

import { Result } from "better-result";
import { create } from "zustand";

import type { ReviewBasis } from "@/components/ai-suggestions/document-review-basis.logic";
import {
  playbookIdFromBasis,
  referencesFromBasis,
} from "@/components/ai-suggestions/document-review-basis.logic";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { api } from "@/lib/api";
import type { toAPIError } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";

const REVIEW_CLIENT_TIMEOUT_MS = 130_000;

export type PlaybookSeverity = "blocker" | "high" | "medium" | "low";
export type PlaybookVerdict =
  | "compliant"
  | "fallback"
  | "deviation"
  | "missing"
  | "not-applicable";

export type PlaybookCitation = { blockId: string; text: string };
export type ReviewFindingFix = {
  kind: "replaceBlock" | "insertAfterBlock";
  blockId: string;
  text: string;
};

export type PlaybookMatchedRef =
  | { kind: "fallback"; label?: string; text: string }
  | { kind: "redLine"; ruleId: string; text: string };

export type PlaybookFinding = {
  positionId: string;
  issue: string;
  severity: PlaybookSeverity;
  verdict: PlaybookVerdict | null;
  extracted: { value: string; text: string } | null;
  rationale: string | null;
  citations: PlaybookCitation[];
  fix: ReviewFindingFix | null;
  matchedRef?: PlaybookMatchedRef | null;
};

export type ReferenceAssessment =
  | "aligned"
  | "different"
  | "missing-from-target"
  | "additional-in-target"
  | "deal-specific"
  | "not-comparable";
export type ReferenceConsensus = "single" | "consistent" | "mixed";

export type ReferenceFinding = {
  findingId: string;
  issue: string;
  assessment: ReferenceAssessment;
  consensus: ReferenceConsensus;
  rationale: string;
  targetCitations: PlaybookCitation[];
  referenceCitations: {
    fileFieldId: string;
    citations: PlaybookCitation[];
  }[];
  fix: ReviewFindingFix | null;
};

export type ReviewFixStatus = "pending" | "applied" | "accepted";

export type ReviewFixState = {
  status: ReviewFixStatus;
  revisionIds: readonly number[] | null;
};

export type ReviewStatus = "idle" | "reviewing" | "error";

export type ReviewResults = {
  playbook: PlaybookFinding[] | null;
  references: ReferenceFinding[] | null;
};

export type DocumentReviewSession = {
  status: ReviewStatus;
  basis: ReviewBasis | null;
  results: ReviewResults;
  fixState: Record<string, ReviewFixState>;
  error: string | null;
  reviewedAt: number | null;
  runId: string | null;
};

type ReviewRequestError = Parameters<typeof toAPIError>[0];

export const reviewSessionKey = (
  entityId: string,
  fileFieldId: string,
): string => `${entityId}:${fileFieldId}`;

export type StartReviewResult =
  | { ok: true }
  | { ok: false; message: string; error: ReviewRequestError | null };

type StartReviewArgs = {
  workspaceId: string;
  basis: ReviewBasis;
  entityId: string;
  fileFieldId: string;
  unexpectedErrorMessage: string;
};

type State = {
  sessions: Record<string, DocumentReviewSession>;
};

type Actions = {
  startReview: (args: StartReviewArgs) => Promise<StartReviewResult>;
  setFixState: (
    entityId: string,
    fileFieldId: string,
    findingId: string,
    next: ReviewFixState,
  ) => void;
  resetSession: (entityId: string, fileFieldId: string) => void;
};

const EMPTY_RESULTS: ReviewResults = {
  playbook: null,
  references: null,
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
    basis,
    entityId,
    fileFieldId,
    unexpectedErrorMessage,
  }) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    const existing = get().sessions[key];
    if (existing?.status === "reviewing") {
      return { ok: true };
    }
    const runId = crypto.randomUUID();

    set((state) => ({
      sessions: {
        ...state.sessions,
        [key]: {
          status: "reviewing",
          basis,
          results: existing?.results ?? EMPTY_RESULTS,
          fixState: existing?.fixState ?? {},
          error: null,
          reviewedAt: existing?.reviewedAt ?? null,
          runId,
        },
      },
    }));

    const playbookId = playbookIdFromBasis(basis);
    const references = referencesFromBasis(basis);
    const requestResult = await Result.tryPromise(async () => {
      const playbookRequest =
        playbookId === null
          ? Promise.resolve(null)
          : api
              .workspaces({
                workspaceId: toSafeId<"workspace">(workspaceId),
              })
              .playbooks({
                playbookId: toSafeId<"playbookDefinition">(playbookId),
              })
              .review.post(
                {
                  entityId: toSafeId<"entity">(entityId),
                  fileFieldId: toSafeId<"field">(fileFieldId),
                },
                {
                  fetch: {
                    signal: AbortSignal.timeout(REVIEW_CLIENT_TIMEOUT_MS),
                  },
                },
              );
      const referenceRequest =
        references.length === 0
          ? Promise.resolve(null)
          : api
              .workspaces({
                workspaceId: toSafeId<"workspace">(workspaceId),
              })
              ["document-reviews"].references.post(
                {
                  target: {
                    entityId: toSafeId<"entity">(entityId),
                    fileFieldId: toSafeId<"field">(fileFieldId),
                  },
                  references: references.map((reference) => ({
                    entityId: toSafeId<"entity">(reference.entityId),
                    fileFieldId: toSafeId<"field">(reference.fileFieldId),
                  })),
                },
                {
                  fetch: {
                    signal: AbortSignal.timeout(REVIEW_CLIENT_TIMEOUT_MS),
                  },
                },
              );

      return await Promise.all([playbookRequest, referenceRequest]);
    });

    if (Result.isError(requestResult)) {
      set((state) => {
        const current = state.sessions[key];
        if (current?.runId !== runId) {
          return state;
        }
        return {
          sessions: {
            ...state.sessions,
            [key]: {
              status: "error",
              basis,
              results: current.results,
              fixState: current.fixState,
              error: unexpectedErrorMessage,
              reviewedAt: current.reviewedAt,
              runId: null,
            },
          },
        };
      });
      return { ok: false, message: unexpectedErrorMessage, error: null };
    }

    const [playbookResponse, referenceResponse] = requestResult.value;
    const responseError = playbookResponse?.error ?? referenceResponse?.error;
    if (responseError) {
      const message = userErrorMessage(responseError, unexpectedErrorMessage);
      set((state) => {
        const current = state.sessions[key];
        if (current?.runId !== runId) {
          return state;
        }
        return {
          sessions: {
            ...state.sessions,
            [key]: {
              status: "error",
              basis,
              results: current.results,
              fixState: current.fixState,
              error: message,
              reviewedAt: current.reviewedAt,
              runId: null,
            },
          },
        };
      });
      return { ok: false, message, error: responseError };
    }

    const results: ReviewResults = {
      playbook: playbookResponse?.data ?? null,
      references: referenceResponse?.data?.findings ?? null,
    };
    set((state) => {
      if (state.sessions[key]?.runId !== runId) {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [key]: {
            status: "idle",
            basis,
            results,
            fixState: {},
            error: null,
            reviewedAt: Date.now(),
            runId: null,
          },
        },
      };
    });

    const inspectorState = useInspectorTabsStore.getState();
    const tab = inspectorState.tabs.find(
      (candidate) =>
        candidate.type === "pdf" && candidate.entityId === entityId,
    );
    if (tab) {
      inspectorState.setFileFacet(tab.id, "playbook", { pulse: true });
    }

    return { ok: true };
  },

  setFixState: (entityId, fileFieldId, findingId, next) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    set((state) => {
      const current = state.sessions[key];
      if (!current) {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [key]: {
            ...current,
            fixState: { ...current.fixState, [findingId]: next },
          },
        },
      };
    });
  },

  resetSession: (entityId, fileFieldId) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    set((state) => {
      const { [key]: _removed, ...rest } = state.sessions;
      return { sessions: rest };
    });
  },
}));
