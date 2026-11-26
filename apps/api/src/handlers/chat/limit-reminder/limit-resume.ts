import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_TURN_INTENT } from "@stll/api-contract/chat";
import { CHAT_QUEUE_ERROR_CODE } from "@stll/api-contract/chat-queue";
import {
  CHAT_RUN_TARGET_KIND,
  type ChatLocalRunTarget,
} from "@stll/api-contract/chat-run-target";
import { DESKTOP_RUNNER_HARNESS_STATE } from "@stll/api-contract/desktop-runner";
import { mapWithConcurrency } from "@stll/concurrency";

import type {
  discardChatLimitResume,
  readDueChatLimitResumes,
  Transaction,
} from "@/api/db/root";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { chatMessageFromPersisted } from "@/api/handlers/chat/chat-message-parts";
import { agUiSendMessageBodySchema } from "@/api/handlers/chat/chat-schema";
import type {
  LocalRunRoute,
  LocalRunTarget,
} from "@/api/handlers/chat/local-run-route";
import type sendMessage from "@/api/handlers/chat/send-message";
import { createResponseSet } from "@/api/http/context";
import { status, unwrapStatus } from "@/api/http/status";
import type { SafeId } from "@/api/lib/branded-types";
import {
  type ChatLimitResumeEnd,
  endChatLimitResumeOnTx,
  endRefusedChatLimitResumeOnTx,
} from "@/api/lib/chat/limit-reset-notification";
import { chatRunTargetOf } from "@/api/lib/chat/run-target";
import { resolveServerStartedMember } from "@/api/lib/chat/server-started-member";
import { NEWEST_CHAT_TURN_FIRST } from "@/api/lib/chat/turn-order";
import { lockChatThreadForTurnOnTx } from "@/api/lib/db/aggregate-lock";
import type { DueChatLimitReminder } from "@/api/lib/db/chat-limit-reminder-system";
import { pingNotificationRecipients } from "@/api/lib/notifications";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

/** Requests one sweep visits; a larger backlog continues on the next sweep. */
const SWEEP_BATCH_SIZE = 25;
const SWEEP_CONCURRENCY = 2;
/** How often every API task looks for a chat to continue after a limit. */
export const CHAT_LIMIT_RESUME_SWEEP_INTERVAL_MS = 15_000;

/** A step of continuing a chat after a limit failed; the sweep tries again. */
const limitResumeFailed = failureSink({
  event: "chat.limit_resume.failed",
  expected: [],
});

/** Statuses after which the resume simply tries again later. */
const TRANSIENT_SEND_STATUSES: ReadonlySet<number> = new Set([429, 503]);

type SendHandler = (typeof sendMessage)["handler"];
type SendContext = Parameters<SendHandler>[0];

export type ChatLimitResumeDependencies = {
  /** The send route's checked handler: every check a request passes runs. */
  send: SendHandler;
  /** Where a local turn would run now. */
  routeLocalRun: (args: {
    owner: { organizationId: SafeId<"organization">; userId: SafeId<"user"> };
    target: LocalRunTarget;
  }) => Promise<Result<LocalRunRoute, unknown>>;
  /** Drops the request of a member who can no longer act (the owner connection's door). */
  discard: typeof discardChatLimitResume;
  now: () => Date;
  /** Ends resumes this process starts when it stops. */
  signal: AbortSignal;
};

/** What one attempt to continue a chat after its limit reset did. */
export type ChatLimitResumeOutcome =
  /** The turn started; its acceptance took the request. */
  | { type: "started" }
  /** The request ended without a turn: the member was told, or cannot act. */
  | { type: "ended"; end: ChatLimitResumeEnd }
  /** Another task started it, or a newer turn made it moot. */
  | { type: "not-due" }
  /** A step may pass on its own: the next sweep tries again. */
  | { type: "retry-later" };

/** What the route of the chat's computer means for a resume now. */
type RouteDisposition =
  | { type: "start" }
  | { type: "end"; end: ChatLimitResumeEnd }
  | { type: "retry-later" };

/**
 * Whether the stopped turn can run again where it ran: on none of the
 * member's computers (away) or with the harness still reporting a limit that
 * resets later, the member is told instead, once. A limit the computer
 * still reports although its reset passed is a report not yet renewed (the
 * computer checks every few minutes), so it is tried again. Every other
 * answer goes to the send, which stores what the member reads.
 */
export const limitResumeRouteDisposition = (
  route: LocalRunRoute,
  now: Date,
): RouteDisposition => {
  switch (route.type) {
    case "no_computer":
    case "folder_unavailable":
      return { type: "end", end: "notify" };
    case "harness_unavailable": {
      const { report } = route;
      if (report?.state !== DESKTOP_RUNNER_HARNESS_STATE.limitUntil) {
        return { type: "start" };
      }
      return new Date(report.resetsAt).getTime() > now.getTime()
        ? { type: "end", end: "notify" }
        : { type: "retry-later" };
    }
    case "routed":
    case "model_unavailable":
    case "reasoning_effort_unavailable":
    case "approvals_unavailable":
    case "folder_not_approved":
      return { type: "start" };
    default:
      route satisfies never;
      return panic("Unhandled computer route");
  }
};

/**
 * What a refused resend means: nothing (another task or a newer turn got
 * there first), a later try (admission, an outage), or the member is told.
 */
export const limitResumeRefusalDisposition = (
  answer: unknown,
): Exclude<ChatLimitResumeOutcome, { type: "started" }> => {
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
  return { type: "ended", end: "notify" };
};

/** What the resend repeats, read under the member's own connection. */
type ChatLimitResumeRead =
  /** The member can no longer see the thread. */
  | { type: "thread-unavailable" }
  /** The stopped turn is no longer the thread's latest. */
  | { type: "moot" }
  | {
      type: "due";
      workspaceId: SafeId<"workspace"> | null;
      usedAnonymization: boolean;
      /** Where the stopped turn ran; null when the thread now runs on stella's models. */
      runTarget: ChatLocalRunTarget | null;
      /** The stopped turn's message as the thread stores it, as Resend sends it. */
      message: {
        id: string;
        role: "user";
        parts: ReturnType<typeof chatMessageFromPersisted>["parts"];
      };
    };

/**
 * The stopped turn's message and where it ran, while that turn is still the
 * thread's latest and failed. The caller holds the thread lock.
 */
const readChatLimitResumeOnTx = async ({
  threadId,
  turnId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
  tx: Transaction;
}): Promise<ChatLimitResumeRead> => {
  const [thread] = await tx
    .select({
      workspaceId: chatThreads.workspaceId,
      usedAnonymization: chatThreads.usedAnonymization,
      chatLocalRunTarget: chatThreads.chatLocalRunTarget,
      chatCloudApprovals: chatThreads.chatCloudApprovals,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (thread === undefined) {
    return { type: "thread-unavailable" };
  }
  const [latest] = await tx
    .select({
      id: chatTurns.id,
      status: chatTurns.status,
      userMessageId: chatTurns.userMessageId,
    })
    .from(chatTurns)
    .where(eq(chatTurns.threadId, threadId))
    .orderBy(...NEWEST_CHAT_TURN_FIRST)
    .limit(1);
  if (latest?.id !== turnId || latest.status !== "failed") {
    return { type: "moot" };
  }
  const [asked] = await tx
    .select({
      content: chatMessages.content,
      id: chatMessages.id,
      role: chatMessages.role,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.id, latest.userMessageId),
        eq(chatMessages.threadId, threadId),
      ),
    )
    .limit(1);
  if (asked?.role !== "user") {
    return { type: "moot" };
  }
  const runTarget = chatRunTargetOf(thread);
  return {
    type: "due",
    workspaceId: thread.workspaceId,
    usedAnonymization: thread.usedAnonymization,
    runTarget: runTarget.kind === CHAT_RUN_TARGET_KIND.local ? runTarget : null,
    message: {
      id: asked.id,
      role: "user",
      parts: chatMessageFromPersisted(asked).parts,
    },
  };
};

/**
 * The resend the member's own Resend makes: the stored message again, asking
 * for a regeneration that replaces the failed answer, on the thread's
 * computer target, sent the way the thread already sends (anonymized once it
 * has been).
 */
const resendBody = ({
  due,
  runId,
  threadId,
}: {
  due: Extract<ChatLimitResumeRead, { type: "due" }>;
  runId: string;
  threadId: SafeId<"chatThread">;
}) => {
  const forwardedProps = {
    threadId,
    runId,
    ...(due.workspaceId === null ? {} : { workspaceId: due.workspaceId }),
    sendMode: due.usedAnonymization
      ? CHAT_SEND_MODE.anonymized
      : CHAT_SEND_MODE.rawOverride,
    ...(due.runTarget === null ? {} : { runTarget: due.runTarget }),
    message: due.message,
    turnIntent: CHAT_TURN_INTENT.regenerate,
  };
  return v.safeParse(agUiSendMessageBodySchema, {
    threadId,
    runId,
    state: {},
    messages: [{ id: due.message.id, role: due.message.role }],
    tools: [],
    context: [],
    forwardedProps,
  });
};

/**
 * Send the message of the member's turn a usage limit stopped again, as the
 * member, once the limit reset, as they asked: started the way the queue
 * sends a queued message, every check of a request run again, no credential
 * of theirs kept. Nothing is stored before the send's acceptance takes the
 * request, so two tasks resuming the same chat start one turn. A computer
 * that is away, or a limit still reached, ends the request in the
 * notification, once; nothing loops.
 */
export const resumeChatAfterLimit = async ({
  dependencies,
  due,
}: {
  dependencies: ChatLimitResumeDependencies;
  due: DueChatLimitReminder;
}): Promise<ChatLimitResumeOutcome> => {
  const { threadId, turnId } = due;
  const owner = {
    organizationId: due.organizationId,
    userId: brandPersistedUserId(due.userId),
  };
  const retryLater = (step: string, error: unknown): ChatLimitResumeOutcome => {
    observeFailure(error, {
      sink: limitResumeFailed,
      ctx: { feature: "chat.limit_resume", step, threadId },
    });
    return { type: "retry-later" };
  };

  const member = await resolveServerStartedMember({
    ...owner,
    work: { type: "limit-resume", threadId, turnId },
    signal: dependencies.signal,
  });
  if (Result.isError(member)) {
    return retryLater("member", member.error);
  }
  if (member.value.type === "unavailable") {
    await dependencies.discard({ threadId, turnId });
    return { type: "ended", end: "discard" };
  }
  const { caller, request } = member.value;
  // A request that will not start ends on the member's own connection: a
  // notification of theirs, or nothing when the chat moved on.
  const end = async (
    how: ChatLimitResumeEnd,
  ): Promise<ChatLimitResumeOutcome> => {
    const ended = await caller.safeDb(
      async (tx) =>
        await endChatLimitResumeOnTx({ end: how, threadId, turnId, tx }),
    );
    if (ended.isErr()) {
      return retryLater("end", ended.error);
    }
    pingNotificationRecipients(ended.value);
    return { type: "ended", end: how };
  };
  // The member's own connection reads what to resend: a thread no longer
  // theirs, or a matter they lost, shows them nothing.
  const read = await caller.safeDb(async (tx) =>
    (await lockChatThreadForTurnOnTx({ threadId, tx }))
      ? await readChatLimitResumeOnTx({ threadId, turnId, tx })
      : ({ type: "thread-unavailable" } satisfies ChatLimitResumeRead),
  );
  if (read.isErr()) {
    return retryLater("read", read.error);
  }
  switch (read.value.type) {
    case "thread-unavailable":
    case "moot":
      return await end("discard");
    case "due":
      break;
    default:
      read.value satisfies never;
      return panic("Unhandled limit resume read");
  }
  const resend = read.value;
  if (resend.runTarget === null) {
    // The thread runs on stella's own models now: no computer limit to wait out.
    return await end("notify");
  }
  const route = await dependencies.routeLocalRun({
    owner: {
      organizationId: caller.session.activeOrganizationId,
      userId: caller.user.id,
    },
    target: resend.runTarget,
  });
  if (Result.isError(route)) {
    return retryLater("route", route.error);
  }
  const disposition = limitResumeRouteDisposition(
    route.value,
    dependencies.now(),
  );
  switch (disposition.type) {
    case "end":
      return await end(disposition.end);
    case "retry-later":
      return { type: "retry-later" };
    case "start":
      break;
    default:
      disposition satisfies never;
      return panic("Unhandled limit resume route");
  }

  const body = resendBody({
    due: resend,
    runId: Bun.randomUUIDv7(),
    threadId,
  });
  if (!body.success) {
    return await end("notify");
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
      serverStartedTurn: { type: "limit-resume", failedTurnId: turnId },
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
  const refusal = limitResumeRefusalDisposition(answer);
  if (refusal.type === "not-due") {
    return refusal;
  }
  // The refusal may have come after the send's acceptance took the request:
  // what is still stored decides whether to try again or tell the member.
  const ended = await caller.safeDb(async (tx) =>
    (await lockChatThreadForTurnOnTx({ threadId, tx }))
      ? await endRefusedChatLimitResumeOnTx({
          due,
          transient: refusal.type === "retry-later",
          tx,
        })
      : ({ type: "not-due" } as const),
  );
  if (ended.isErr()) {
    return retryLater("end", ended.error);
  }
  switch (ended.value.type) {
    case "kept":
      return { type: "retry-later" };
    case "not-due":
      return { type: "not-due" };
    case "ended":
      pingNotificationRecipients(ended.value.pings);
      return { type: "ended", end: "notify" };
    default:
      ended.value satisfies never;
      return panic("Unhandled refused limit resume");
  }
};

/**
 * This process's limit resumer: every sweep, the requests to continue a chat
 * that are due, at most one attempt per chat at a time here (another task
 * resuming the same chat serializes on its lock, and only one acceptance
 * takes the request).
 */
export const createChatLimitResumer = (
  dependencies: ChatLimitResumeDependencies & {
    readDue: typeof readDueChatLimitResumes;
  },
) => {
  const resuming = new Set<SafeId<"chatThread">>();
  const resume = async (due: DueChatLimitReminder): Promise<void> => {
    if (resuming.has(due.threadId)) {
      return;
    }
    resuming.add(due.threadId);
    const done = await Result.tryPromise(
      async () => await resumeChatAfterLimit({ dependencies, due }),
    );
    resuming.delete(due.threadId);
    if (Result.isError(done)) {
      observeFailure(done.error, {
        sink: limitResumeFailed,
        ctx: {
          feature: "chat.limit_resume",
          step: "resume",
          threadId: due.threadId,
        },
      });
    }
  };
  return async (): Promise<void> => {
    if (dependencies.signal.aborted) {
      return;
    }
    const due = await dependencies.readDue({
      limit: SWEEP_BATCH_SIZE,
      now: dependencies.now(),
    });
    await mapWithConcurrency({
      items: due,
      limit: SWEEP_CONCURRENCY,
      operation: async (reminder) => {
        await resume(reminder);
        return 1;
      },
    });
  };
};
