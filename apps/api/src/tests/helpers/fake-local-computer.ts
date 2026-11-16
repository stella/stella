import { EventType } from "@tanstack/ai";
import type { RunAgentResumeItem, StreamChunk } from "@tanstack/ai";
import { panic, Result } from "better-result";

import { type HarnessEvent, harnessEventsToChunks } from "@stll/agent-engine";
import { DESKTOP_RUNNER_DESKTOP_MESSAGE } from "@stll/api-contract/desktop-runner";

import { createLocalChatRun } from "@/api/handlers/chat/local-run-chunks";
import type { LocalRunContext } from "@/api/handlers/chat/local-run-chunks";
import { toSafeId } from "@/api/lib/branded-types";
import { createLocalRunBell } from "@/api/lib/desktop-runner/doorbell";
import type {
  DesktopRunnerRunView,
  StoredRunEvent,
} from "@/api/lib/desktop-runner/store";

const RUNNER_RUN_ID = "0198c0de-0000-7000-8000-000000000001";
export const REQUEST_ID = "0198c0de-0000-7000-8000-000000000002";
export const THREAD_ID = toSafeId<"chatThread">("thread_bound");
export const TURN_ID = toSafeId<"chatTurn">("turn_bound");
const DESTINATION = {
  desktopId: "0198c0de-0000-7000-8000-000000000003",
  harness: "codex",
  harnessVersion: "1.0.0",
  model: "local-model",
  reasoningEffort: null,
  approvals: "ask",
  linkedFolderId: null,
} as const;

/** The chunks the desktop's own mapper makes of a harness turn. */
export const harnessChunks = async (events: HarnessEvent[]) => {
  let generated = 0;
  const chunks: StreamChunk[] = [];
  for await (const chunk of harnessEventsToChunks(
    (async function* () {
      yield* events;
    })(),
    {
      harness: "codex",
      model: DESTINATION.model,
      runId: RUNNER_RUN_ID,
      threadId: "desktop-thread",
      workspaceDir: "/workspace",
      generateId: () => {
        generated += 1;
        return `generated-${String(generated)}`;
      },
      now: () => 0,
    },
  )) {
    chunks.push(chunk);
  }
  return chunks;
};

export const isPause = (chunk: StreamChunk) =>
  chunk.type === EventType.RUN_FINISHED && chunk.outcome?.type === "interrupt";

/**
 * The member's computer as the turn reads it: the run's stored messages, its
 * state as the runner gateway keeps it, and the commands the turn queued.
 */
export const createComputer = () => {
  const runBell = createLocalRunBell();
  const stored: StoredRunEvent[] = [];
  const queued = { interrupts: 0, approvals: 0 };
  let state: DesktopRunnerRunView["state"] = "running";
  let chatReadSeq = 0;
  let approvalRequest: StoredRunEvent | undefined;
  const store = (message: (seq: number) => Record<string, unknown>) => {
    const seq = stored.length + 1;
    const event = { seq, message: { ...message(seq), runId: RUNNER_RUN_ID } };
    stored.push(event);
    runBell.ring(RUNNER_RUN_ID);
    return event;
  };
  const control: LocalRunContext["control"] = {
    pickDesktop: async () =>
      Result.ok({
        type: "available",
        desktopId: DESTINATION.desktopId,
        harness: {
          id: DESTINATION.harness,
          state: "ready",
          version: DESTINATION.harnessVersion,
          capabilities: [],
          approvalModes: [DESTINATION.approvals],
          models: [
            { id: DESTINATION.model, label: "Local", reasoningEfforts: [] },
          ],
        },
        linkedFolders: [],
        approvedFolderIds: [],
      }),
    readChatRunSession: async () => Result.ok({ type: "fresh" }),
    startRun: async () => Result.ok({ type: "assigned", runId: RUNNER_RUN_ID }),
    readEvents: async ({ afterSeq }) =>
      Result.ok({
        items: stored.filter(({ seq }) => seq > afterSeq),
        nextAfterSeq: null,
      }),
    readRun: async () =>
      Result.ok({
        runId: RUNNER_RUN_ID,
        desktopId: DESTINATION.desktopId,
        harness: DESTINATION.harness,
        harnessVersion: DESTINATION.harnessVersion,
        state,
        outcome: null,
        rejectReason: null,
        harnessSessionId: null,
        ackSeq: stored.length,
        leaseExpiresAt: new Date(0),
        createdAt: new Date(0),
        deliveredAt: new Date(0),
        lostReason: null,
        acceptedAt: new Date(0),
      }),
    interruptRun: async () => {
      queued.interrupts += 1;
      return Result.ok({ type: "queued" });
    },
    recordChatReadSeq: async ({ seq }) => {
      chatReadSeq = seq;
      return Result.ok(undefined);
    },
    readChatRunForRequest: async () =>
      Result.ok(
        approvalRequest === undefined
          ? null
          : {
              runId: RUNNER_RUN_ID,
              harness: DESTINATION.harness,
              state,
              chatReadSeq,
              askedBy: DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest,
              request: approvalRequest.message,
            },
      ),
    answerApproval: async () => {
      queued.approvals += 1;
      return Result.ok({ type: "queued" });
    },
    answerQuestion: async () => panic("No question is asked here"),
    pairAppCall: async () => panic("No app call is reported here"),
    readRunOutputFile: async () => panic("No output file is reported here"),
    readRunInputText: async () => panic("No steer is reported here"),
  };
  const context: LocalRunContext = {
    control,
    runBell,
    owner: {
      userId: toSafeId<"user">("user_bound"),
      organizationId: toSafeId<"organization">("org_bound"),
    },
    chatThreadId: THREAD_ID,
    workspaceIds: [],
    mcp: { serverName: "stella", url: "https://stella.test/mcp" },
    // Every change rings; the poll only bounds a missed ring.
    pollMs: 20,
  };
  return {
    context,
    queued,
    chatReadSeq: () => chatReadSeq,
    events: (chunks: readonly StreamChunk[]) => {
      for (const chunk of chunks) {
        store((seq) => ({
          type: DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent,
          seq,
          chunk,
        }));
      }
    },
    approvalRequest: () => {
      approvalRequest = store((seq) => ({
        type: DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest,
        seq,
        requestId: REQUEST_ID,
        kind: "command",
        summary: "Run the test suite",
      }));
    },
    finish: () => {
      state = "finished";
      store((seq) => ({
        type: DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished,
        seq,
        outcome: "completed",
        harnessSessionId: null,
      }));
    },
    /** What the gateway's sweep does to the run's row. */
    moveTo: (next: DesktopRunnerRunView["state"]) => {
      state = next;
      runBell.ring(RUNNER_RUN_ID);
    },
  };
};

export const localSource =
  (
    computer: ReturnType<typeof createComputer>,
    resume?: readonly RunAgentResumeItem[],
  ) =>
  (abortSignal: AbortSignal) =>
    createLocalChatRun(
      computer.context,
      resume === undefined
        ? {
            type: "start",
            target: {
              kind: "local",
              harness: DESTINATION.harness,
              model: DESTINATION.model,
              approvals: DESTINATION.approvals,
              reasoningEffort: DESTINATION.reasoningEffort,
            },
          }
        : { type: "resume", harness: DESTINATION.harness },
    ).stream({
      chatRunId: "chat-run-bound",
      chatTurnId: TURN_ID,
      messages: [],
      instructions: "You are stella.",
      resume,
      abortSignal,
    });
