/**
 * Document-review sessions: a client cache over durable server runs.
 *
 * A review is a row on the server, not a promise in this tab. The store keeps
 * only what the server does not: the basis and topics a reviewer is still
 * assembling, the id of the run the facet is tracking, and the fix/comment
 * state of the open editor session (revision ids are editor-scoped and mean
 * nothing after a reload, so they never leave the client). Status, progress
 * and findings are read back from the run itself.
 *
 * A session key with no entry means "the facet has not decided yet" — that is
 * what lets a freshly opened facet restore the document's latest run instead of
 * starting from the launcher.
 */

import { Result } from "better-result";
import { create } from "zustand";

import type {
  ReviewBasis,
  ReviewPerspective,
} from "@/components/ai-suggestions/document-review-basis.logic";
import {
  perspectiveFromBasis,
  playbookIdFromBasis,
  referencesFromBasis,
} from "@/components/ai-suggestions/document-review-basis.logic";
import { fetchDocumentReviewRuns } from "@/components/ai-suggestions/document-review-queries";
import type { DocumentReviewFindingRow } from "@/components/ai-suggestions/document-review-queries";
import { resolveRunConflictAttachment } from "@/components/ai-suggestions/document-review-run.logic";
import { runSizeConfirmationDetail } from "@/components/usage/run-size-confirmation";
import type { RunSizeConfirmationDetail } from "@/components/usage/run-size-confirmation";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";

const TOPIC_PROPOSAL_TIMEOUT_MS = 130_000;
const RUN_CREATE_TIMEOUT_MS = 30_000;

/** The create endpoint answers this when the document already has a run in
 *  flight. A second run would spend twice and race the first to the same
 *  findings, so the client attaches to the active one instead. */
const RUN_ALREADY_ACTIVE_STATUS = 409;

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

/** The reference-comparison finding as the run persisted it. Inferred from the
 *  run read rather than restated here, so the card cannot drift from the shape
 *  the engine writes. */
export type ReferenceFinding = Extract<
  DocumentReviewFindingRow["payload"],
  { checkKind: "reference" }
>["finding"];
export type ReferenceAssessment = ReferenceFinding["assessment"];
export type ReferenceConsensus = ReferenceFinding["consensus"];

export type ReviewFixStatus = "pending" | "applied" | "accepted";

export type ReviewFixState = {
  status: ReviewFixStatus;
  revisionIds: readonly number[] | null;
};

export type ReviewCommentState = { status: "applying" } | { status: "applied" };

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

/**
 * Where the client-side flow stands. It deliberately does not mirror the run's
 * lifecycle: once a run exists, `runId` points at it and the server row is the
 * only source of progress, findings and failure.
 */
export type ReviewStatus =
  | "idle"
  | "proposing-topics"
  | "editing-topics"
  | "starting"
  | "error";

export type ReviewResults = {
  playbook: PlaybookFinding[] | null;
  references: ReferenceFinding[] | null;
};

/**
 * Whether the facet may still adopt the document's latest server run. A
 * reviewer who goes back to the launcher has decided otherwise, and that
 * decision has to outlive the run itself — without it, the restore would
 * immediately put the finished review back on screen.
 */
export type ReviewRestoreMode = "allowed" | "dismissed";

export type DocumentReviewSession = {
  status: ReviewStatus;
  basis: ReviewBasis | null;
  fixState: Record<string, ReviewFixState>;
  commentState: Record<string, ReviewCommentState>;
  error: string | null;
  /** The durable run this facet tracks, or `null` while none has started. */
  runId: string | null;
  restore: ReviewRestoreMode;
  /** Guards a stale response from overwriting a newer request's session. */
  requestId: string | null;
  topics: ReviewTopic[];
  /**
   * A refused start whose estimated size needs the reviewer's explicit
   * go-ahead; the dialog re-issues the stored request with the estimate
   * restated. `null` while no confirmation is pending.
   */
  sizeConfirmation: RunSizeConfirmation | null;
};

type ReviewRequestError = Parameters<typeof toAPIError>[0];

/** Whether a rejected create was refused because the document already has a
 *  run in flight, read through the normalized error so the check does not
 *  depend on how narrowly the transport types a status. */
const isRunAlreadyActive = (error: ReviewRequestError): boolean =>
  toAPIError(error).status === RUN_ALREADY_ACTIVE_STATUS;

export type RunSizeConfirmation = RunSizeConfirmationDetail & {
  /** The refused request, replayed verbatim once the reviewer confirms. */
  args: StartRunArgs;
};

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

/** What a run needs, flattened from whatever produced it: the launcher's
 *  basis, the confirmed topic editor, or a failed run being retried. */
export type StartRunArgs = {
  workspaceId: string;
  entityId: string;
  fileFieldId: string;
  playbookId: string | null;
  references: readonly {
    workspaceId: string;
    entityId: string;
    fileFieldId: string;
  }[];
  perspective: ReviewPerspective;
  topics: readonly ReviewTopic[];
  unexpectedErrorMessage: string;
  /** Restated size estimate after a confirmation answer. */
  confirmedUnits?: number;
};

type State = {
  sessions: Record<string, DocumentReviewSession>;
};

type Actions = {
  beginComment: (
    entityId: string,
    fileFieldId: string,
    findingId: string,
  ) => boolean;
  completeComment: (
    entityId: string,
    fileFieldId: string,
    findingId: string,
  ) => void;
  cancelComment: (
    entityId: string,
    fileFieldId: string,
    findingId: string,
  ) => void;
  startReview: (args: StartReviewArgs) => Promise<StartReviewResult>;
  startRun: (args: StartRunArgs) => Promise<StartReviewResult>;
  /** Replay the parked request with its estimate restated. */
  confirmRunSize: (
    entityId: string,
    fileFieldId: string,
  ) => Promise<StartReviewResult>;
  dismissRunSize: (entityId: string, fileFieldId: string) => void;
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

const blankSession = (): DocumentReviewSession => ({
  status: "idle",
  basis: null,
  fixState: {},
  commentState: {},
  error: null,
  runId: null,
  restore: "allowed",
  requestId: null,
  topics: [],
  sizeConfirmation: null,
});

const requestRun = async ({
  workspaceId,
  entityId,
  fileFieldId,
  playbookId,
  references,
  perspective,
  topics,
  confirmedUnits,
}: Omit<StartRunArgs, "unexpectedErrorMessage">) => {
  // Both channels are read here rather than handed on as one response: the
  // caller decides between attaching to an already active run and surfacing
  // the failure, and neither decision may depend on an unexamined `.data`.
  const { data, error } = await api
    .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
    ["document-reviews"].runs.post(
      {
        target: {
          entityId: toSafeId<"entity">(entityId),
          fileFieldId: toSafeId<"field">(fileFieldId),
        },
        ...(playbookId === null
          ? {}
          : { playbookId: toSafeId<"playbookDefinition">(playbookId) }),
        references: references.map((reference) => ({
          workspaceId: toSafeId<"workspace">(reference.workspaceId),
          entityId: toSafeId<"entity">(reference.entityId),
          fileFieldId: toSafeId<"field">(reference.fileFieldId),
        })),
        perspective,
        // The run stores the confirmed plan, and the endpoint rejects an
        // unconfirmed topic: send exactly what the reviewer approved.
        topics: topics.filter((topic) => topic.included),
        ...(confirmedUnits === undefined ? {} : { confirmedUnits }),
      },
      { fetch: { signal: AbortSignal.timeout(RUN_CREATE_TIMEOUT_MS) } },
    );
  return { data, error };
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
      existing?.status === "starting" ||
      existing?.status === "proposing-topics"
    ) {
      return { ok: true };
    }

    const references = referencesFromBasis(basis);
    const playbookId = playbookIdFromBasis(basis);
    if (references.length === 0) {
      // No reference documents means no topics to agree on: the playbook's
      // enabled positions are the plan, so the run starts immediately.
      set((state) => ({
        sessions: {
          ...state.sessions,
          [key]: {
            ...blankSession(),
            ...(existing === undefined
              ? {}
              : {
                  fixState: existing.fixState,
                  commentState: existing.commentState,
                }),
            basis,
            topics: seededTopics,
          },
        },
      }));
      return await get().startRun({
        workspaceId,
        entityId,
        fileFieldId,
        playbookId,
        references: [],
        perspective: perspectiveFromBasis(basis),
        topics: seededTopics,
        unexpectedErrorMessage,
      });
    }

    const requestId = crypto.randomUUID();
    set((state) => ({
      sessions: {
        ...state.sessions,
        [key]: {
          ...blankSession(),
          ...(existing === undefined
            ? {}
            : {
                fixState: existing.fixState,
                commentState: existing.commentState,
              }),
          status: "proposing-topics",
          basis,
          requestId,
          topics: seededTopics,
        },
      },
    }));

    const proposalResult = await Result.tryPromise(async () => {
      const { data, error } = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["document-reviews"].topics.post(
          {
            target: {
              entityId: toSafeId<"entity">(entityId),
              fileFieldId: toSafeId<"field">(fileFieldId),
            },
            references: references.map((reference) => ({
              workspaceId: toSafeId<"workspace">(reference.workspaceId),
              entityId: toSafeId<"entity">(reference.entityId),
              fileFieldId: toSafeId<"field">(reference.fileFieldId),
            })),
            perspective: perspectiveFromBasis(basis),
            seededTopics,
          },
          {
            fetch: {
              signal: AbortSignal.timeout(TOPIC_PROPOSAL_TIMEOUT_MS),
            },
          },
        );
      return { data, error };
    });
    const proposalError = Result.isError(proposalResult)
      ? null
      : proposalResult.value.error;
    if (Result.isError(proposalResult) || proposalError) {
      const message = proposalError
        ? userErrorMessage(proposalError, unexpectedErrorMessage)
        : unexpectedErrorMessage;
      set((state) => {
        const current = state.sessions[key];
        if (current?.requestId !== requestId) {
          return state;
        }
        return {
          sessions: {
            ...state.sessions,
            [key]: {
              ...current,
              status: "error",
              error: message,
              requestId: null,
            },
          },
        };
      });
      return { ok: false, message, error: proposalError };
    }

    set((state) => {
      const current = state.sessions[key];
      if (current?.requestId !== requestId) {
        return state;
      }
      const proposed = proposalResult.value.data;
      return {
        sessions: {
          ...state.sessions,
          [key]: {
            ...current,
            status: "editing-topics",
            topics: proposed === null ? seededTopics : proposed.topics,
            requestId: null,
          },
        },
      };
    });
    return { ok: true };
  },

  confirmRunSize: async (entityId, fileFieldId) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    const confirmation = get().sessions[key]?.sizeConfirmation;
    if (!confirmation) {
      return { ok: true };
    }
    return await get().startRun({
      ...confirmation.args,
      confirmedUnits: confirmation.estimatedUnits,
    });
  },

  dismissRunSize: (entityId, fileFieldId) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    set((state) => {
      const current = state.sessions[key];
      if (!current?.sizeConfirmation) {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [key]: { ...current, sizeConfirmation: null },
        },
      };
    });
  },

  startRun: async ({
    workspaceId,
    entityId,
    fileFieldId,
    playbookId,
    references,
    topics,
    unexpectedErrorMessage,
    confirmedUnits,
  }) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    const requestId = crypto.randomUUID();
    set((state) => {
      const current = state.sessions[key];
      return {
        sessions: {
          ...state.sessions,
          [key]: {
            ...(current ?? blankSession()),
            status: "starting",
            error: null,
            runId: null,
            requestId,
            topics: [...topics],
            sizeConfirmation: null,
          },
        },
      };
    });

    const requestResult = await Result.tryPromise(
      async () =>
        await requestRun({
          workspaceId,
          entityId,
          fileFieldId,
          playbookId,
          references,
          topics,
          ...(confirmedUnits === undefined ? {} : { confirmedUnits }),
        }),
    );

    const responseError = Result.isError(requestResult)
      ? null
      : requestResult.value.error;

    if (responseError) {
      const confirmationDetail = runSizeConfirmationDetail(responseError);
      if (confirmationDetail) {
        // Not a failure: the server wants the size restated. Park the
        // request on the session; the dialog replays it on confirm.
        set((state) => {
          const current = state.sessions[key];
          if (current?.requestId !== requestId) {
            return state;
          }
          return {
            sessions: {
              ...state.sessions,
              [key]: {
                ...current,
                status: "idle",
                error: null,
                requestId: null,
                sizeConfirmation: {
                  ...confirmationDetail,
                  args: {
                    workspaceId,
                    entityId,
                    fileFieldId,
                    playbookId,
                    references,
                    topics,
                    unexpectedErrorMessage,
                  },
                },
              },
            },
          };
        });
        return { ok: true };
      }
    }

    if (responseError && isRunAlreadyActive(responseError)) {
      // Another tab (or a reload that raced this click) already started a run
      // for this document. Attach to it: it is executing the same document,
      // and a second run is exactly what the server refused to create.
      const attached = await Result.tryPromise(
        async () =>
          await fetchDocumentReviewRuns({ workspaceId, entityId, fileFieldId }),
      );
      const attachedRunId = Result.isError(attached)
        ? null
        : resolveRunConflictAttachment(attached.value.items);
      if (attachedRunId !== null) {
        set((state) => {
          const current = state.sessions[key];
          if (current?.requestId !== requestId) {
            return state;
          }
          return {
            sessions: {
              ...state.sessions,
              [key]: {
                ...current,
                status: "idle",
                error: null,
                runId: attachedRunId,
                requestId: null,
              },
            },
          };
        });
        return { ok: true };
      }
    }

    if (Result.isError(requestResult) || responseError) {
      const message = responseError
        ? userErrorMessage(responseError, unexpectedErrorMessage)
        : unexpectedErrorMessage;
      set((state) => {
        const current = state.sessions[key];
        if (current?.requestId !== requestId) {
          return state;
        }
        return {
          sessions: {
            ...state.sessions,
            [key]: {
              ...current,
              status: "error",
              error: message,
              requestId: null,
            },
          },
        };
      });
      return { ok: false, message, error: responseError };
    }

    const created = requestResult.value.data;
    if (created === null) {
      set((state) => {
        const current = state.sessions[key];
        if (current?.requestId !== requestId) {
          return state;
        }
        return {
          sessions: {
            ...state.sessions,
            [key]: {
              ...current,
              status: "error",
              error: unexpectedErrorMessage,
              requestId: null,
            },
          },
        };
      });
      return { ok: false, message: unexpectedErrorMessage, error: null };
    }

    const runId = created.runId;
    set((state) => {
      const current = state.sessions[key];
      if (current?.requestId !== requestId) {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [key]: {
            ...current,
            status: "idle",
            error: null,
            // A new run supersedes whatever the previous one left applied: the
            // fixes it proposes are keyed by its own findings.
            fixState: {},
            commentState: {},
            runId,
            requestId: null,
          },
        },
      };
    });
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
    return await get().startRun({
      workspaceId,
      entityId,
      fileFieldId,
      playbookId: playbookIdFromBasis(session.basis),
      references: referencesFromBasis(session.basis),
      perspective: perspectiveFromBasis(session.basis),
      topics: session.topics,
      unexpectedErrorMessage,
    });
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

  // Fix and comment state can be the first thing a restored review writes:
  // the facet adopts a server run without a session, so these upsert one
  // rather than dropping the reviewer's edit on the floor.
  setFixState: (entityId, fileFieldId, findingId, next) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    set((state) => {
      const current = state.sessions[key] ?? blankSession();
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

  beginComment: (entityId, fileFieldId, findingId) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    if (get().sessions[key]?.commentState[findingId] !== undefined) {
      return false;
    }
    set((state) => {
      const session = state.sessions[key] ?? blankSession();
      return {
        sessions: {
          ...state.sessions,
          [key]: {
            ...session,
            commentState: {
              ...session.commentState,
              [findingId]: { status: "applying" },
            },
          },
        },
      };
    });
    return true;
  },

  completeComment: (entityId, fileFieldId, findingId) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    set((state) => {
      const current = state.sessions[key];
      if (current?.commentState[findingId]?.status !== "applying") {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [key]: {
            ...current,
            commentState: {
              ...current.commentState,
              [findingId]: { status: "applied" },
            },
          },
        },
      };
    });
  },

  cancelComment: (entityId, fileFieldId, findingId) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    set((state) => {
      const current = state.sessions[key];
      if (current?.commentState[findingId]?.status !== "applying") {
        return state;
      }
      const { [findingId]: _cancelled, ...commentState } = current.commentState;
      return {
        sessions: {
          ...state.sessions,
          [key]: { ...current, commentState },
        },
      };
    });
  },

  /**
   * Back to the launcher. The blank session stays in the map with the restore
   * dismissed: choosing a new basis is a decision the facet must remember, or
   * the document's finished run would be put straight back on screen.
   */
  resetSession: (entityId, fileFieldId) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    set((state) => ({
      sessions: {
        ...state.sessions,
        [key]: { ...blankSession(), restore: "dismissed" },
      },
    }));
  },
}));
