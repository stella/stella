/**
 * In-memory document-review sessions. A review can use an authored playbook,
 * reference documents, or both. Transport keeps the result groups separate so
 * reference examples can never change an authoritative playbook verdict; the
 * result UI joins them by confirmed topic into one composable review card.
 */

import { Result } from "better-result";
import { create } from "zustand";

import type { ReviewBasis } from "@/components/ai-suggestions/document-review-basis.logic";
import {
  playbookIdFromBasis,
  referencesFromBasis,
} from "@/components/ai-suggestions/document-review-basis.logic";
import { topicsFromPlaybookFindings } from "@/components/ai-suggestions/playbook-review-topics.logic";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { api } from "@/lib/api";
import type { toAPIError } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";

const REVIEW_CLIENT_TIMEOUT_MS = 130_000;

export const SEVERITY_ORDER = ["blocker", "high", "medium", "low"] as const;

export type PlaybookSeverity = (typeof SEVERITY_ORDER)[number];

const PLAYBOOK_VERDICT_POLICY = {
  compliant: { risk: "clear", negotiation: "unavailable" },
  fallback: { risk: "flagged", negotiation: "available" },
  deviation: { risk: "flagged", negotiation: "available" },
  missing: { risk: "flagged", negotiation: "unavailable" },
  // Outside the compliance ladder: the position does not pertain to this
  // document, so it is neither a pass nor a flagged gap and is excluded from
  // the compliance denominator (see `computeRiskRollup`).
  "not-applicable": { risk: "clear", negotiation: "unavailable" },
} as const satisfies Record<
  string,
  {
    risk: "clear" | "flagged";
    negotiation: "available" | "unavailable";
  }
>;

export type PlaybookVerdict = keyof typeof PLAYBOOK_VERDICT_POLICY;

export type FlaggedPlaybookVerdict = {
  [TVerdict in PlaybookVerdict]: (typeof PLAYBOOK_VERDICT_POLICY)[TVerdict]["risk"] extends "flagged"
    ? TVerdict
    : never;
}[PlaybookVerdict];

type NegotiablePlaybookVerdict = {
  [TVerdict in PlaybookVerdict]: (typeof PLAYBOOK_VERDICT_POLICY)[TVerdict]["negotiation"] extends "available"
    ? TVerdict
    : never;
}[PlaybookVerdict];

export const isFlaggedPlaybookVerdict = (
  verdict: PlaybookVerdict,
): verdict is FlaggedPlaybookVerdict =>
  PLAYBOOK_VERDICT_POLICY[verdict].risk === "flagged";

export const isNegotiablePlaybookVerdict = (
  verdict: PlaybookVerdict,
): verdict is NegotiablePlaybookVerdict =>
  PLAYBOOK_VERDICT_POLICY[verdict].negotiation === "available";

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

type WorkspaceApi = ReturnType<typeof api.workspaces>;
type ReferenceReviewResponse = Awaited<
  ReturnType<WorkspaceApi["document-reviews"]["references"]["post"]>
>;
type ReferenceReviewData = Exclude<
  NonNullable<Extract<ReferenceReviewResponse, { data: unknown }>["data"]>,
  Response
>;

export type ReferenceFinding = ReferenceReviewData["findings"][number];
export type ReferenceAssessment = ReferenceFinding["assessment"];
export type ReferenceConsensus = ReferenceFinding["consensus"];

export type ReviewFixStatus = "pending" | "applied" | "accepted";

export type ReviewFixState = {
  status: ReviewFixStatus;
  revisionIds: readonly number[] | null;
};

export type ReviewTopic =
  | {
      type: "playbook";
      topicId: string;
      positionId: string;
      title: string;
      context: string;
      included: boolean;
    }
  | {
      type: "reference" | "custom";
      topicId: string;
      title: string;
      context: string;
      included: boolean;
    };

export type ReviewStatus =
  | "idle"
  | "proposing-topics"
  | "editing-topics"
  | "reviewing"
  | "error";

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
  topics: ReviewTopic[];
  workspaceId: string;
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
  seededTopics: ReviewTopic[];
};

type State = {
  sessions: Record<string, DocumentReviewSession>;
};

type Actions = {
  startReview: (args: StartReviewArgs) => Promise<StartReviewResult>;
  confirmTopics: (
    workspaceId: string,
    entityId: string,
    fileFieldId: string,
    unexpectedErrorMessage: string,
  ) => Promise<StartReviewResult>;
  setTopics: (
    entityId: string,
    fileFieldId: string,
    topics: ReviewTopic[],
  ) => void;
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

type ExecuteReviewArgs = {
  workspaceId: string;
  basis: ReviewBasis;
  entityId: string;
  fileFieldId: string;
  topics: readonly ReviewTopic[];
};

const executeReview = async ({
  workspaceId,
  basis,
  entityId,
  fileFieldId,
  topics,
}: ExecuteReviewArgs) => {
  const playbookId = playbookIdFromBasis(basis);
  const references = referencesFromBasis(basis);
  const includedTopics = topics.filter((topic) => topic.included);
  const playbookRequest =
    playbookId === null
      ? Promise.resolve(null)
      : api
          .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .playbooks({
            playbookId: toSafeId<"playbookDefinition">(playbookId),
          })
          .review.post(
            {
              entityId: toSafeId<"entity">(entityId),
              fileFieldId: toSafeId<"field">(fileFieldId),
              ...(references.length > 0 && {
                positionIds: includedTopics.flatMap((topic) =>
                  topic.type === "playbook" ? [topic.positionId] : [],
                ),
              }),
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
          .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
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
              topics: includedTopics,
            },
            {
              fetch: {
                signal: AbortSignal.timeout(REVIEW_CLIENT_TIMEOUT_MS),
              },
            },
          );
  return await Promise.all([playbookRequest, referenceRequest]);
};

export const usePlaybookReviewStore = create<State & Actions>()((set, get) => ({
  sessions: {},

  startReview: async ({
    workspaceId,
    basis,
    entityId,
    fileFieldId,
    unexpectedErrorMessage,
    seededTopics,
  }) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    const existing = get().sessions[key];
    if (
      existing?.status === "reviewing" ||
      existing?.status === "proposing-topics"
    ) {
      return { ok: true };
    }
    const runId = crypto.randomUUID();

    set((state) => ({
      sessions: {
        ...state.sessions,
        [key]: {
          status:
            referencesFromBasis(basis).length > 0
              ? "proposing-topics"
              : "reviewing",
          basis,
          results: existing?.results ?? EMPTY_RESULTS,
          fixState: existing?.fixState ?? {},
          error: null,
          reviewedAt: existing?.reviewedAt ?? null,
          runId,
          topics: seededTopics,
          workspaceId,
        },
      },
    }));

    const references = referencesFromBasis(basis);
    if (references.length > 0) {
      const proposalResult = await Result.tryPromise(
        async () =>
          await api
            .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
            ["document-reviews"].topics.post(
              {
                target: {
                  entityId: toSafeId<"entity">(entityId),
                  fileFieldId: toSafeId<"field">(fileFieldId),
                },
                references: references.map((reference) => ({
                  entityId: toSafeId<"entity">(reference.entityId),
                  fileFieldId: toSafeId<"field">(reference.fileFieldId),
                })),
                seededTopics,
              },
              {
                fetch: {
                  signal: AbortSignal.timeout(REVIEW_CLIENT_TIMEOUT_MS),
                },
              },
            ),
      );
      const proposalError = Result.isError(proposalResult)
        ? null
        : proposalResult.value.error;
      if (Result.isError(proposalResult) || proposalError) {
        const message = proposalError
          ? userErrorMessage(proposalError, unexpectedErrorMessage)
          : unexpectedErrorMessage;
        set((state) => {
          const current = state.sessions[key];
          if (current?.runId !== runId) {
            return state;
          }
          return {
            sessions: {
              ...state.sessions,
              [key]: {
                ...current,
                status: "error",
                error: message,
                runId: null,
              },
            },
          };
        });
        return { ok: false, message, error: proposalError };
      }
      set((state) => {
        const current = state.sessions[key];
        if (current?.runId !== runId) {
          return state;
        }
        return {
          sessions: {
            ...state.sessions,
            [key]: {
              ...current,
              status: "editing-topics",
              topics: proposalResult.value.data?.topics ?? seededTopics,
              runId: null,
            },
          },
        };
      });
      return { ok: true };
    }

    const requestResult = await Result.tryPromise(
      async () =>
        await executeReview({
          workspaceId,
          basis,
          entityId,
          fileFieldId,
          topics: seededTopics,
        }),
    );

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
              topics: current.topics,
              workspaceId,
            },
          },
        };
      });
      return {
        ok: false as const,
        message: unexpectedErrorMessage,
        error: null,
      };
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
              topics: current.topics,
              workspaceId,
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
    const completedTopics =
      references.length === 0 && results.playbook !== null
        ? topicsFromPlaybookFindings(
            results.playbook,
            seededTopics.filter(
              (topic): topic is Extract<ReviewTopic, { type: "playbook" }> =>
                topic.type === "playbook",
            ),
          )
        : seededTopics;
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
            topics: completedTopics,
            workspaceId,
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

  confirmTopics: async (
    workspaceId,
    entityId,
    fileFieldId,
    unexpectedErrorMessage,
  ) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    const session = get().sessions[key];
    if (!session?.basis || session.status !== "editing-topics") {
      return { ok: true };
    }
    const basis = session.basis;
    const runId = crypto.randomUUID();
    set((state) => ({
      sessions: {
        ...state.sessions,
        [key]: { ...session, status: "reviewing", error: null, runId },
      },
    }));
    const requestResult = await Result.tryPromise(
      async () =>
        await executeReview({
          workspaceId,
          basis,
          entityId,
          fileFieldId,
          topics: session.topics,
        }),
    );
    const responseError = Result.isError(requestResult)
      ? null
      : (requestResult.value.at(0)?.error ??
        requestResult.value.at(1)?.error ??
        null);
    if (Result.isError(requestResult) || responseError) {
      const message = responseError
        ? userErrorMessage(responseError, unexpectedErrorMessage)
        : unexpectedErrorMessage;
      set((state) => {
        const current = state.sessions[key];
        if (current?.runId !== runId) {
          return state;
        }
        return {
          sessions: {
            ...state.sessions,
            [key]: {
              ...current,
              status: "editing-topics",
              error: message,
              runId: null,
            },
          },
        };
      });
      return { ok: false, message, error: responseError };
    }
    const [playbookResponse, referenceResponse] = requestResult.value;
    set((state) => {
      const current = state.sessions[key];
      if (current?.runId !== runId) {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [key]: {
            ...current,
            status: "idle",
            results: {
              playbook: playbookResponse?.data ?? null,
              references: referenceResponse?.data?.findings ?? null,
            },
            fixState: {},
            error: null,
            reviewedAt: Date.now(),
            runId: null,
          },
        },
      };
    });
    return { ok: true };
  },

  setTopics: (entityId, fileFieldId, topics) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    set((state) => {
      const current = state.sessions[key];
      if (!current || current.status !== "editing-topics") {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [key]: { ...current, topics, error: null },
        },
      };
    });
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
