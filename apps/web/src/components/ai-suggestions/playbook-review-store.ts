/**
 * Document-review sessions: a client cache over durable server runs.
 *
 * A review is a row on the server, not a promise in this tab. The store keeps
 * only what the server does not: the setup and the position list a reviewer is
 * still assembling, and the id of the run the facet is tracking. Status,
 * progress, findings and the staged redlines are read back from the run and
 * from the AI-suggestions store.
 *
 * A session key with no entry means "the facet has not decided yet" — that is
 * what lets a freshly opened facet restore the document's latest run instead of
 * starting from the launcher.
 */

import { Result } from "better-result";
import { create } from "zustand";

import { REVIEW_START_MODE } from "@/components/ai-suggestions/document-review-basis.logic";
import type {
  ReferenceFile,
  ReviewPerspective,
  ReviewSetup,
  ReviewSkippedTerm,
  ReviewStartMode,
} from "@/components/ai-suggestions/document-review-basis.logic";
import {
  mergeStreamedPosition,
  REVIEW_PROPOSAL_EVENT,
  streamReviewProposal,
} from "@/components/ai-suggestions/document-review-proposal-stream";
import type { IndexedPosition } from "@/components/ai-suggestions/document-review-proposal-stream";
import { fetchDocumentReviewRuns } from "@/components/ai-suggestions/document-review-queries";
import { resolveRunConflictAttachment } from "@/components/ai-suggestions/document-review-run.logic";
import { runSizeConfirmationDetail } from "@/components/usage/run-size-confirmation";
import type { RunSizeConfirmationDetail } from "@/components/usage/run-size-confirmation";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import type { Position } from "@/lib/knowledge/playbook-types";
import { toSafeId } from "@/lib/safe-id";

const RUN_CREATE_TIMEOUT_MS = 30_000;

/** The create endpoint answers this when the document already has a run in
 *  flight. A second run would spend twice and race the first to the same
 *  findings, so the client attaches to the active one instead. */
const RUN_ALREADY_ACTIVE_STATUS = 409;

export const reviewSessionKey = (
  entityId: string,
  fileFieldId: string,
): string => `${entityId}:${fileFieldId}`;

/**
 * Where the client-side flow stands. It deliberately does not mirror the run's
 * lifecycle: once a run exists, `runId` points at it and the server row is the
 * only source of progress, findings and failure.
 */
export type ReviewStatus =
  | "idle"
  | "proposing-positions"
  | "editing-positions"
  | "starting"
  | "error";

/**
 * Whether the facet may still adopt the document's latest server run. A
 * reviewer who goes back to the launcher has decided otherwise, and that
 * decision has to outlive the run itself — without it, the restore would
 * immediately put the finished review back on screen.
 */
export type ReviewRestoreMode = "allowed" | "dismissed";

/**
 * Which of the document's runs the facet is showing: the one this session
 * tracks (the newest, or the one it started), or an earlier run the reviewer
 * opened from the history. A history run is a record, not a workspace: the
 * facet renders it read-only and offers the way back.
 */
export type ReviewRunSelection =
  | { type: "tracked" }
  | { type: "history"; runId: string };

export const TRACKED_RUN_SELECTION: ReviewRunSelection = { type: "tracked" };

/**
 * The proposal as the stream has delivered it so far.
 *
 * Separate from the session's `positions` on purpose: this is what the model
 * proposed, in the order it proposed it, and it never changes once written —
 * `positions` is the plan the reviewer may then edit. Keeping the two apart is
 * what lets the streamed cards stay on screen while the run they started is
 * already claiming its findings.
 */
export type ReviewProposal = {
  status: "streaming" | "done" | "failed";
  /** The seeded positions, then each streamed one in the proposal's own
   *  order. */
  positions: Position[];
  /** What the pass read and deliberately did not turn into a position. */
  skipped: ReviewSkippedTerm[];
};

export type DocumentReviewSession = {
  status: ReviewStatus;
  setup: ReviewSetup | null;
  error: string | null;
  /** The durable run this facet tracks, or `null` while none has started. */
  runId: string | null;
  restore: ReviewRestoreMode;
  /** Which run is on screen: the tracked one, or one opened from history. */
  selection: ReviewRunSelection;
  /** Guards a stale response from overwriting a newer request's session. */
  requestId: string | null;
  /** The list the run will be measured by, while the reviewer confirms it. */
  positions: Position[];
  /** What the position proposal read but deliberately did not turn into a
   *  position; empty when no proposal ran (a playbook-only setup, or none
   *  started yet). */
  skipped: ReviewSkippedTerm[];
  /** The streamed proposal behind this session, or `null` when none has been
   *  asked for (a playbook-only setup, or a restored run). */
  proposal: ReviewProposal | null;
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

export type StartReviewResult =
  | { ok: true }
  | { ok: false; message: string; error: ReviewRequestError | null };

type StartReviewArgs = {
  workspaceId: string;
  setup: ReviewSetup;
  entityId: string;
  fileFieldId: string;
  unexpectedErrorMessage: string;
  /** What the proposal is followed by: the run, or the confirm step. */
  startMode: ReviewStartMode;
  /** The picked playbook's enabled positions, when there is one. */
  seededPositions: Position[];
};

/** What a run needs, flattened from whatever produced it: the launcher's
 *  setup, the confirmed position list, or a failed run being retried. */
export type StartRunArgs = {
  workspaceId: string;
  entityId: string;
  fileFieldId: string;
  playbookId: string | null;
  references: readonly Pick<
    ReferenceFile,
    "workspaceId" | "entityId" | "fileFieldId"
  >[];
  perspective: ReviewPerspective;
  positions: readonly Position[];
  /** What the proposal read and left off the checklist. Pinned on the run
   *  with the positions, so the results can still say how much of the document
   *  was never compared; empty for a run with no proposal behind it. */
  skipped: readonly ReviewSkippedTerm[];
  unexpectedErrorMessage: string;
  /** Restated size estimate after a confirmation answer. */
  confirmedUnits?: number;
};

type State = {
  sessions: Record<string, DocumentReviewSession>;
  /**
   * The side last chosen for each document, kept past the session it was
   * chosen in. Going back to the launcher blanks the session, and re-picking
   * "we act for the Purchaser" on every re-run of the same contract is the
   * kind of retyping a reviewer notices.
   */
  perspectiveByDocument: Record<string, ReviewPerspective>;
};

type Actions = {
  startReview: (args: StartReviewArgs) => Promise<StartReviewResult>;
  startRun: (args: StartRunArgs) => Promise<StartReviewResult>;
  /** Replay the parked request with its estimate restated. */
  confirmRunSize: (
    entityId: string,
    fileFieldId: string,
  ) => Promise<StartReviewResult>;
  dismissRunSize: (entityId: string, fileFieldId: string) => void;
  confirmPositions: (
    workspaceId: string,
    entityId: string,
    fileFieldId: string,
    unexpectedErrorMessage: string,
  ) => Promise<StartReviewResult>;
  setPositions: (
    entityId: string,
    fileFieldId: string,
    positions: Position[],
  ) => void;
  /** Which of the target's sides the run is judged for. Chosen on the
   *  launcher, and changeable again while the positions are confirmed;
   *  remembered for the document either way. */
  setPerspective: (
    entityId: string,
    fileFieldId: string,
    perspective: ReviewPerspective,
  ) => void;
  resetSession: (entityId: string, fileFieldId: string) => void;
  /** Open one of the document's earlier runs, read-only. */
  viewHistoricalRun: (
    entityId: string,
    fileFieldId: string,
    runId: string,
  ) => void;
  /** Back to the run this session tracks. */
  viewTrackedRun: (entityId: string, fileFieldId: string) => void;
};

const blankSession = (): DocumentReviewSession => ({
  status: "idle",
  setup: null,
  error: null,
  runId: null,
  restore: "allowed",
  selection: TRACKED_RUN_SELECTION,
  requestId: null,
  positions: [],
  skipped: [],
  proposal: null,
  sizeConfirmation: null,
});

/**
 * The in-flight proposal stream per document, held outside the store: it is a
 * connection, not state anything renders, and a component subscribing to it
 * would re-render on a value it can do nothing with. Starting a proposal
 * hangs up the previous one for the same document; so does going back to the
 * launcher, because nobody is left to read the rest of the checklist and the
 * tokens are still being paid for.
 */
const proposalStreams = new Map<string, AbortController>();

const abortProposalStream = (key: string) => {
  proposalStreams.get(key)?.abort();
  proposalStreams.delete(key);
};

const referenceRefs = (
  references: StartRunArgs["references"],
): {
  workspaceId: ReturnType<typeof toSafeId<"workspace">>;
  entityId: ReturnType<typeof toSafeId<"entity">>;
  fileFieldId: ReturnType<typeof toSafeId<"field">>;
}[] =>
  references.map((reference) => ({
    workspaceId: toSafeId<"workspace">(reference.workspaceId),
    entityId: toSafeId<"entity">(reference.entityId),
    fileFieldId: toSafeId<"field">(reference.fileFieldId),
  }));

const requestRun = async ({
  workspaceId,
  entityId,
  fileFieldId,
  playbookId,
  references,
  perspective,
  positions,
  skipped,
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
        playbookId:
          playbookId === null
            ? null
            : toSafeId<"playbookDefinition">(playbookId),
        // The whole confirmed list, disabled entries included: the run pins it
        // as its snapshot, and "Save as playbook" keeps exactly what was
        // confirmed. Grading skips the disabled ones server-side.
        positions: [...positions],
        references: referenceRefs(references),
        perspective,
        skipped: [...skipped],
        ...(confirmedUnits === undefined ? {} : { confirmedUnits }),
      },
      { fetch: { signal: AbortSignal.timeout(RUN_CREATE_TIMEOUT_MS) } },
    );
  return { data, error };
};

export const usePlaybookReviewStore = create<State & Actions>()((set, get) => ({
  sessions: {},
  perspectiveByDocument: {},

  startReview: async ({
    workspaceId,
    setup,
    entityId,
    fileFieldId,
    unexpectedErrorMessage,
    startMode,
    seededPositions,
  }) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    const existing = get().sessions[key];
    if (
      existing?.status === "starting" ||
      existing?.status === "proposing-positions"
    ) {
      return { ok: true };
    }
    set((state) => ({
      perspectiveByDocument: {
        ...state.perspectiveByDocument,
        [key]: setup.perspective,
      },
    }));

    if (setup.references.length === 0) {
      // No reference documents means no positions to agree on: the playbook's
      // enabled positions are the plan, so the run starts immediately.
      set((state) => ({
        sessions: {
          ...state.sessions,
          [key]: { ...blankSession(), setup, positions: seededPositions },
        },
      }));
      return await get().startRun({
        workspaceId,
        entityId,
        fileFieldId,
        playbookId: setup.playbookId,
        references: [],
        perspective: setup.perspective,
        positions: seededPositions,
        // No reference documents means no proposal, so nothing was read and
        // left uncompared.
        skipped: [],
        unexpectedErrorMessage,
      });
    }

    const requestId = crypto.randomUUID();
    set((state) => ({
      sessions: {
        ...state.sessions,
        [key]: {
          ...blankSession(),
          status: "proposing-positions",
          setup,
          requestId,
          positions: seededPositions,
          proposal: {
            status: "streaming",
            positions: [...seededPositions],
            skipped: [],
          },
        },
      },
    }));

    abortProposalStream(key);
    const controller = new AbortController();
    proposalStreams.set(key, controller);

    // Streamed positions are placed by the index the server states rather than
    // by arrival, and the seeds keep the front: the stream never re-sends
    // them, so the list is seeds first, proposal second, in the proposal's own
    // order.
    let streamed: IndexedPosition[] = [];
    const proposalPositions = (): Position[] => [
      ...seededPositions,
      ...streamed.map((entry) => entry.position),
    ];

    /** Fold one frame into the session, or answer `false` when this request is
     *  no longer the one the session is waiting for. */
    const applyEvent = (
      apply: (proposal: ReviewProposal) => ReviewProposal,
    ): boolean => {
      let current = false;
      set((state) => {
        const session = state.sessions[key];
        if (session?.requestId !== requestId || session.proposal === null) {
          return state;
        }
        current = true;
        return {
          sessions: {
            ...state.sessions,
            [key]: { ...session, proposal: apply(session.proposal) },
          },
        };
      });
      return current;
    };

    const streamResult = await Result.tryPromise(
      async () =>
        await streamReviewProposal({
          workspaceId,
          target: { entityId, fileFieldId },
          references: setup.references.map((reference) => ({
            workspaceId: reference.workspaceId,
            entityId: reference.entityId,
            fileFieldId: reference.fileFieldId,
          })),
          seededPositions,
          perspective: setup.perspective,
          signal: controller.signal,
          onEvent: (event) => {
            switch (event.type) {
              case REVIEW_PROPOSAL_EVENT.PARTIES:
                // The launcher asked the same question before the reviewer
                // picked a side, and the side is already in the request this
                // stream is answering. Restating it changes nothing.
                return true;
              case REVIEW_PROPOSAL_EVENT.POSITION: {
                streamed = mergeStreamedPosition(streamed, event);
                return applyEvent((proposal) => ({
                  ...proposal,
                  positions: proposalPositions(),
                }));
              }
              case REVIEW_PROPOSAL_EVENT.SKIPPED:
                return applyEvent((proposal) => ({
                  ...proposal,
                  skipped: [...proposal.skipped, event.skipped],
                }));
              case REVIEW_PROPOSAL_EVENT.DONE:
                return applyEvent((proposal) => ({
                  ...proposal,
                  status: "done",
                }));
              case REVIEW_PROPOSAL_EVENT.ERROR:
                // Whatever already streamed stays valid; the list is simply
                // not complete, and the reviewer decides what to do with it.
                applyEvent((proposal) => ({ ...proposal, status: "failed" }));
                return false;
              default:
                event satisfies never;
                return true;
            }
          },
        }),
    );

    if (proposalStreams.get(key) === controller) {
      proposalStreams.delete(key);
    }

    const session = get().sessions[key];
    if (session?.requestId !== requestId) {
      // Superseded: the reviewer went back to the launcher, or started
      // another proposal for the same document.
      return { ok: true };
    }

    const refusal =
      !Result.isError(streamResult) && !streamResult.value.ok
        ? streamResult.value.error
        : null;
    const proposalStatus = session.proposal?.status ?? "failed";
    if (
      Result.isError(streamResult) ||
      refusal !== null ||
      proposalStatus === "failed"
    ) {
      const message =
        refusal === null
          ? unexpectedErrorMessage
          : userErrorMessage(refusal, unexpectedErrorMessage);
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
              proposal:
                current.proposal === null
                  ? null
                  : { ...current.proposal, status: "failed" },
            },
          },
        };
      });
      return { ok: false, message, error: refusal };
    }

    const proposed = session.proposal?.positions ?? seededPositions;
    if (startMode === REVIEW_START_MODE.confirmFirst) {
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
              status: "editing-positions",
              positions: proposed,
              skipped: current.proposal?.skipped ?? [],
              requestId: null,
            },
          },
        };
      });
      return { ok: true };
    }

    // Start immediately. The streamed cards stay on screen until the run's own
    // progress replaces them, so the reviewer never watches the list they were
    // reading get taken away for a spinner.
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
            skipped: current.proposal?.skipped ?? [],
            requestId: null,
          },
        },
      };
    });
    return await get().startRun({
      workspaceId,
      entityId,
      fileFieldId,
      playbookId: setup.playbookId,
      references: setup.references,
      perspective: setup.perspective,
      positions: proposed.filter((position) => position.enabled),
      skipped: session.proposal?.skipped ?? [],
      unexpectedErrorMessage,
    });
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
    perspective,
    positions,
    skipped,
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
            selection: TRACKED_RUN_SELECTION,
            requestId,
            positions: [...positions],
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
          perspective,
          positions,
          skipped,
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
                    perspective,
                    positions,
                    skipped,
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
            runId,
            requestId: null,
          },
        },
      };
    });
    return { ok: true };
  },

  confirmPositions: async (
    workspaceId,
    entityId,
    fileFieldId,
    unexpectedErrorMessage,
  ) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    const session = get().sessions[key];
    if (!session?.setup || session.status !== "editing-positions") {
      return { ok: true };
    }
    return await get().startRun({
      workspaceId,
      entityId,
      fileFieldId,
      playbookId: session.setup.playbookId,
      references: session.setup.references,
      perspective: session.setup.perspective,
      positions: session.positions,
      skipped: session.skipped,
      unexpectedErrorMessage,
    });
  },

  setPerspective: (entityId, fileFieldId, perspective) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    set((state) => {
      const current = state.sessions[key];
      const remembered = {
        perspectiveByDocument: {
          ...state.perspectiveByDocument,
          [key]: perspective,
        },
      };
      // A run is already measuring by the side it was given; changing it here
      // would only disagree with the row.
      if (!current?.setup || current.status !== "editing-positions") {
        return remembered;
      }
      return {
        ...remembered,
        sessions: {
          ...state.sessions,
          [key]: { ...current, setup: { ...current.setup, perspective } },
        },
      };
    });
  },

  setPositions: (entityId, fileFieldId, positions) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    set((state) => {
      const current = state.sessions[key];
      if (!current || current.status !== "editing-positions") {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [key]: { ...current, positions, error: null },
        },
      };
    });
  },

  /**
   * Back to the launcher. The blank session stays in the map with the restore
   * dismissed: choosing a new setup is a decision the facet must remember, or
   * the document's finished run would be put straight back on screen.
   */
  resetSession: (entityId, fileFieldId) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    abortProposalStream(key);
    set((state) => ({
      sessions: {
        ...state.sessions,
        [key]: { ...blankSession(), restore: "dismissed" },
      },
    }));
  },

  /**
   * Show an earlier run. Only the selection moves: the tracked run, the
   * restore decision and any half-assembled setup stay exactly as they were,
   * so "Back to latest" is a return rather than a reconstruction.
   */
  viewHistoricalRun: (entityId, fileFieldId, runId) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    set((state) => {
      const current = state.sessions[key] ?? blankSession();
      return {
        sessions: {
          ...state.sessions,
          [key]: { ...current, selection: { type: "history", runId } },
        },
      };
    });
  },

  viewTrackedRun: (entityId, fileFieldId) => {
    const key = reviewSessionKey(entityId, fileFieldId);
    set((state) => {
      const current = state.sessions[key];
      if (current === undefined) {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [key]: { ...current, selection: TRACKED_RUN_SELECTION },
        },
      };
    });
  },
}));
