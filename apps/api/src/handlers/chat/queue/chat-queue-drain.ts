import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  CHAT_QUEUE_ERROR_CODE,
  CHAT_QUEUE_HOLD_REASON,
  CHAT_QUEUE_SEND_REFUSAL,
} from "@stll/api-contract/chat-queue";
import { CHAT_RUN_TARGET_KIND } from "@stll/api-contract/chat-run-target";
import { mapWithConcurrency } from "@stll/concurrency";

import {
  holdChatQueueOfUnavailableMember,
  readDueChatQueueHead,
  sweepThreadsWithDueChatQueue,
} from "@/api/db/root";
import { agUiSendMessageBodySchema } from "@/api/handlers/chat/chat-schema";
import type {
  LocalRunRoute,
  LocalRunTarget,
} from "@/api/handlers/chat/local-run-route";
import { parseQueuedChatSend } from "@/api/handlers/chat/queue/chat-queue-store";
import type sendMessage from "@/api/handlers/chat/send-message";
import { createResponseSet } from "@/api/http/context";
import { status, unwrapStatus } from "@/api/http/status";
import type { SafeId } from "@/api/lib/branded-types";
import { announceChatQueueChange } from "@/api/lib/chat/chat-queue-announcement";
import { resolveServerStartedMember } from "@/api/lib/chat/server-started-member";
import { lockChatThreadForTurnOnTx } from "@/api/lib/db/aggregate-lock";
import {
  type ChatQueueHoldWrite,
  holdDueChatQueueOnTx,
  readChatQueueGateOnTx,
} from "@/api/lib/db/chat-queue-gate";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

/** Threads one sweep visits; a larger backlog continues on the next sweep. */
const SWEEP_BATCH_SIZE = 25;
const SWEEP_CONCURRENCY = 2;
/** How often every API task looks for a queue whose ring was lost. */
export const CHAT_QUEUE_SWEEP_INTERVAL_MS = 15_000;

/** A step of sending a queued message failed; the sweep tries it again. */
const queuedSendFailed = failureSink({
  event: "chat.queue.send_failed",
  expected: [],
});

/** Statuses after which the queue simply tries again later. */
const TRANSIENT_SEND_STATUSES: ReadonlySet<number> = new Set([429, 503]);
const USAGE_LIMIT_STATUS = 402;

type SendHandler = (typeof sendMessage)["handler"];
type SendContext = Parameters<SendHandler>[0];

export type ChatQueueDrainDependencies = {
  /** The send route's checked handler: every check a request passes runs. */
  send: SendHandler;
  /** Where a local turn would run now; only "no computer" holds the queue. */
  routeLocalRun: (args: {
    owner: { organizationId: SafeId<"organization">; userId: SafeId<"user"> };
    target: LocalRunTarget;
  }) => Promise<Result<LocalRunRoute, unknown>>;
  /** Ends sends this process starts when it stops. */
  signal: AbortSignal;
};

/** What one attempt to send a thread's next queued message did. */
export type ChatQueueSendOutcome =
  | { type: "started" }
  | { type: "not-due" }
  | { type: "held"; reason: string }
  | { type: "retry-later" };

/** What a refused send means for the queue, from its status and code. */
export const queueDispositionOfRefusal = (
  answer: unknown,
):
  | { type: "not-due" }
  | { type: "retry-later" }
  | { type: "hold-usage" }
  | { type: "hold-refused"; code: string } => {
  const { code: statusCode, value } = unwrapStatus(answer);
  const code =
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string"
      ? value.code
      : undefined;
  if (code === CHAT_QUEUE_ERROR_CODE.notDue) {
    return { type: "not-due" };
  }
  if (statusCode !== undefined && TRANSIENT_SEND_STATUSES.has(statusCode)) {
    return { type: "retry-later" };
  }
  if (statusCode === USAGE_LIMIT_STATUS) {
    return { type: "hold-usage" };
  }
  return {
    type: "hold-refused",
    code: code ?? CHAT_QUEUE_SEND_REFUSAL.refused,
  };
};

/**
 * Send the thread's next queued message as the member who queued it, once:
 * the server's only way to start a chat turn without a request. Nothing is
 * stored before the send's own acceptance takes the message from the queue,
 * so a sender that loses a race or dies leaves the message queued; a refusal
 * before acceptance holds the queue with its reason, except one that may
 * pass on its own (admission, an outage), which the sweep retries.
 */
const sendNextQueuedChatMessage = async ({
  dependencies,
  threadId,
}: {
  dependencies: ChatQueueDrainDependencies;
  threadId: SafeId<"chatThread">;
}): Promise<ChatQueueSendOutcome> => {
  const due = await readDueChatQueueHead(threadId);
  if (due === null) {
    return { type: "not-due" };
  }
  const member = await resolveServerStartedMember({
    organizationId: due.organizationId,
    userId: due.userId,
    work: { type: "queued-send", threadId, queuedMessageId: due.id },
    signal: dependencies.signal,
  });
  if (Result.isError(member)) {
    observeFailure(member.error, {
      sink: queuedSendFailed,
      ctx: { feature: "chat.queue", step: "member", threadId },
    });
    return { type: "retry-later" };
  }
  const owner = { organizationId: due.organizationId, userId: due.userId };
  const holdUnavailable = async (): Promise<ChatQueueSendOutcome> => {
    await holdChatQueueOfUnavailableMember({
      head: { id: due.id, revision: due.revision },
      threadId,
    });
    announceChatQueueChange(owner);
    return { type: "held", reason: CHAT_QUEUE_HOLD_REASON.sendRefused };
  };
  if (member.value.type === "unavailable") {
    return await holdUnavailable();
  }
  const { caller, request } = member.value;
  // The member's own connection reads the head: a thread no longer theirs,
  // or a matter they lost, shows them nothing to send.
  const gate = await caller.safeDb(async (tx) => {
    if (!(await lockChatThreadForTurnOnTx({ threadId, tx }))) {
      return { type: "thread-unavailable" } as const;
    }
    return await readChatQueueGateOnTx({ threadId, tx });
  });
  if (gate.isErr()) {
    observeFailure(gate.error, {
      sink: queuedSendFailed,
      ctx: { feature: "chat.queue", step: "gate", threadId },
    });
    return { type: "retry-later" };
  }
  if (gate.value.type === "thread-unavailable") {
    // The member can no longer see the thread (a matter they lost): hold
    // it rather than proving them again on every sweep.
    return await holdUnavailable();
  }
  if (gate.value.type !== "due") {
    return { type: "not-due" };
  }
  const { head } = gate.value;
  const send = parseQueuedChatSend(head.request);
  // Every refusal below was met outside the thread lock: it holds the queue
  // only while this message is still the due head, so a pause, an edit or a
  // turn since then stands.
  const hold = async (
    write: ChatQueueHoldWrite,
  ): Promise<ChatQueueSendOutcome> => {
    const held = await caller.safeDb(
      async (tx) =>
        await holdDueChatQueueOnTx({
          head: { id: head.id, revision: head.revision },
          hold: write,
          threadId,
          tx,
        }),
    );
    if (held.isErr()) {
      observeFailure(held.error, {
        sink: queuedSendFailed,
        ctx: { feature: "chat.queue", step: "hold", threadId },
      });
      return { type: "retry-later" };
    }
    if (held.value !== "held") {
      return { type: "not-due" };
    }
    announceChatQueueChange(owner);
    return { type: "held", reason: write.reason };
  };

  const { runTarget } = send;
  if (
    runTarget !== undefined &&
    runTarget.kind !== CHAT_RUN_TARGET_KIND.cloud
  ) {
    // A message for a computer that is away waits for it instead of being
    // sent and failing; the computer's next report releases the hold.
    const route = await dependencies.routeLocalRun({
      owner: {
        organizationId: caller.session.activeOrganizationId,
        userId: caller.user.id,
      },
      target: runTarget,
    });
    if (Result.isError(route)) {
      return { type: "retry-later" };
    }
    if (route.value.type === "no_computer") {
      return await hold({ reason: CHAT_QUEUE_HOLD_REASON.computerAway });
    }
  }

  const runId = Bun.randomUUIDv7();
  const forwardedProps = { ...send, threadId, runId };
  const body = v.safeParse(agUiSendMessageBodySchema, {
    threadId,
    runId,
    state: {},
    messages: [{ id: send.message.id, role: send.message.role }],
    tools: [],
    context: [],
    forwardedProps,
  });
  if (!body.success) {
    return await hold({
      reason: CHAT_QUEUE_HOLD_REASON.sendRefused,
      queuedMessageId: head.id,
      refusalCode: CHAT_QUEUE_SEND_REFUSAL.refused,
    });
  }
  const context = {
    request,
    server: null,
    path: new URL(request.url).pathname,
    route: "/chat",
    routeEntry: undefined,
    set: createResponseSet(),
    params: {},
    query: {},
    body: body.output,
    headers: {},
    status,
    ...caller,
    session: {
      ...caller.session,
      startedFromQueue: {
        queuedMessageId: head.id,
        revision: head.revision,
      },
    },
  } satisfies SendContext;
  const answer = await dependencies.send(context);
  const delivered = unwrapStatus(answer).value;
  if (delivered instanceof Response) {
    // Nobody watches this turn here: its producer keeps writing the run's
    // log, and pages join it like any turn they did not start.
    await delivered.body?.cancel();
    return { type: "started" };
  }
  const refusal = queueDispositionOfRefusal(answer);
  switch (refusal.type) {
    case "not-due":
      return { type: "not-due" };
    case "retry-later":
      return { type: "retry-later" };
    case "hold-usage":
      return await hold({ reason: CHAT_QUEUE_HOLD_REASON.usageLimit });
    case "hold-refused":
      return await hold({
        reason: CHAT_QUEUE_HOLD_REASON.sendRefused,
        queuedMessageId: head.id,
        refusalCode: refusal.code,
      });
    default:
      refusal satisfies never;
      return panic("Unhandled queued send refusal");
  }
};

/**
 * This process's queue sender: drains a rung thread at most once at a time
 * here (another task draining the same thread serializes on its lock), and
 * sweeps for queues whose ring was lost.
 */
export const createChatQueueDrainer = (
  dependencies: ChatQueueDrainDependencies,
) => {
  const draining = new Set<SafeId<"chatThread">>();
  const drain = async (threadId: SafeId<"chatThread">): Promise<void> => {
    if (draining.has(threadId)) {
      return;
    }
    draining.add(threadId);
    const sent = await Result.tryPromise(
      async () => await sendNextQueuedChatMessage({ dependencies, threadId }),
    );
    draining.delete(threadId);
    if (Result.isError(sent)) {
      observeFailure(sent.error, {
        sink: queuedSendFailed,
        ctx: { feature: "chat.queue", step: "drain", threadId },
      });
    }
  };
  const sweep = async (): Promise<void> => {
    if (dependencies.signal.aborted) {
      return;
    }
    const threads = await sweepThreadsWithDueChatQueue(SWEEP_BATCH_SIZE);
    await mapWithConcurrency({
      items: threads,
      limit: SWEEP_CONCURRENCY,
      operation: async (threadId) => {
        await drain(threadId);
        return 1;
      },
    });
  };
  return { drain, sweep };
};
