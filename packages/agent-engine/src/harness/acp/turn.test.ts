import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { HarnessEvent } from "../events";
import {
  antigravityCommandOutlivesPrompt,
  classifyAntigravityError,
} from "./antigravity";
import { AcpRequestError } from "./client";
import type { AcpAnswer, AcpClient } from "./client";
import { ACP_AGENT_NOTIFICATIONS } from "./protocol";
import { AcpTurnSession } from "./turn";

const createFakeClient = (stderrText = "") => {
  const notifications: { method: string; params: unknown }[] = [];
  let resolveExit:
    | ((exit: { exitCode: number | null; signal: string | null }) => void)
    | null = null;
  const exited = new Promise<{
    exitCode: number | null;
    signal: string | null;
  }>((resolve) => {
    resolveExit = resolve;
  });
  const client: AcpClient = {
    pid: 4242,
    request: async () => Result.ok({ stopReason: "end_turn" }),
    notify: (method, params) => {
      notifications.push({ method, params });
    },
    respond: () => undefined,
    respondError: () => undefined,
    // The fake's stderr is written once the turn has begun.
    stderrBytesSeen: () => 0,
    stderrSince: () => stderrText,
    exited,
    closeInput: () => undefined,
    kill: async () => {
      const exit = { exitCode: 0, signal: null };
      resolveExit?.(exit);
      return exit;
    },
  };
  return { client, notifications };
};

const collectEvents = async (turn: ReturnType<AcpTurnSession["turn"]>) => {
  const events: HarnessEvent[] = [];
  for await (const event of turn.events) {
    events.push(event);
  }
  return events;
};

describe("AcpTurnSession background work, stderr classification, and late updates", () => {
  test("keeps a turn alive while a background command runs and completes on usage_update after it finishes", async () => {
    const { client } = createFakeClient();
    const session = new AcpTurnSession({
      gracePeriodMs: 200,
      detached: (p) => {
        void p;
      },
      displayName: "Antigravity",
      mcpNames: { stella: "stella", others: [] },
      policy: { approvals: "auto", network: "open", fs: "workspace" },
      workspaceDir: "/tmp/chat",
      unreadablePaths: [],
      onPromptError: () => undefined,
      toolOutlivesPrompt: antigravityCommandOutlivesPrompt,
      backgroundSettleMs: 5000,
    });
    session.attach(client);
    session.begin("sess-bg", { type: "fresh" });

    const turn = session.turn();
    const collected = collectEvents(turn);

    session.handlers.notification(ACP_AGENT_NOTIFICATIONS.update, {
      sessionId: "sess-bg",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "cmd-1",
        title: "bun test",
        kind: "execute",
        status: "in_progress",
        rawInput: { CommandLine: "bun test" },
      },
    });

    const promptDeferred = Promise.withResolvers<AcpAnswer>();
    session.prompted(promptDeferred.promise);
    promptDeferred.resolve(Result.ok({ stopReason: "end_turn" }));
    await Promise.resolve();
    await Promise.resolve();

    session.handlers.notification(ACP_AGENT_NOTIFICATIONS.update, {
      sessionId: "sess-bg",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "cmd-1",
        status: "completed",
      },
    });
    session.handlers.notification(ACP_AGENT_NOTIFICATIONS.update, {
      sessionId: "sess-bg",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Tests passed." },
      },
    });
    session.handlers.notification(ACP_AGENT_NOTIFICATIONS.update, {
      sessionId: "sess-bg",
      update: {
        sessionUpdate: "usage_update",
        used: 100,
        size: 1000,
      },
    });

    // Late update after turn completed must be ignored.
    session.handlers.notification(ACP_AGENT_NOTIFICATIONS.update, {
      sessionId: "sess-bg",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Late ghost text" },
      },
    });

    const events = await collected;
    expect(events.some((e) => e.type === "tool.completed")).toBe(true);
    expect(
      events.some(
        (e) => e.type === "text.completed" && e.text === "Tests passed.",
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) => e.type === "text.delta" && e.delta === "Late ghost text",
      ),
    ).toBe(false);
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  test("interrupting a turn held open for a background command sends session/cancel and ends interrupted", async () => {
    const { client, notifications } = createFakeClient();
    const session = new AcpTurnSession({
      gracePeriodMs: 200,
      detached: (p) => {
        void p;
      },
      displayName: "Antigravity",
      mcpNames: { stella: "stella", others: [] },
      policy: { approvals: "auto", network: "open", fs: "workspace" },
      workspaceDir: "/tmp/chat",
      unreadablePaths: [],
      onPromptError: () => undefined,
      toolOutlivesPrompt: antigravityCommandOutlivesPrompt,
      backgroundSettleMs: 5000,
    });
    session.attach(client);
    session.begin("sess-stop", { type: "fresh" });

    const turn = session.turn();
    const collected = collectEvents(turn);

    session.handlers.notification(ACP_AGENT_NOTIFICATIONS.update, {
      sessionId: "sess-stop",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "cmd-2",
        title: "sleep 60",
        kind: "execute",
        status: "in_progress",
        rawInput: { CommandLine: "sleep 60" },
      },
    });

    session.prompted(Promise.resolve(Result.ok({ stopReason: "end_turn" })));
    await Promise.resolve();
    await Promise.resolve();
    await turn.interrupt();

    const events = await collected;
    expect(notifications).toContainEqual({
      method: "session/cancel",
      params: { sessionId: "sess-stop" },
    });
    expect(events.at(-1)?.type).toBe("turn.interrupted");
  });

  test("classifies stderr QUOTA_EXHAUSTED into a usage_limit failure on an empty end_turn", async () => {
    const { client } = createFakeClient(
      "Error 429, Message: Quota exceeded reason:QUOTA_EXHAUSTED quotaResetTimeStamp:2026-11-22T10:00:00Z, Status: RESOURCE_EXHAUSTED",
    );
    const session = new AcpTurnSession({
      gracePeriodMs: 200,
      detached: (p) => {
        void p;
      },
      displayName: "Antigravity",
      mcpNames: { stella: "stella", others: [] },
      policy: { approvals: "auto", network: "open", fs: "workspace" },
      workspaceDir: "/tmp/chat",
      unreadablePaths: [],
      onPromptError: () => undefined,
      classifyErrorOutput: classifyAntigravityError,
    });
    session.attach(client);
    session.begin("sess-err", { type: "fresh" });

    const turn = session.turn();
    const collected = collectEvents(turn);
    session.prompted(Promise.resolve(Result.ok({ stopReason: "end_turn" })));

    const events = await collected;
    expect(events.at(-1)).toEqual({
      type: "turn.failed",
      failure: {
        type: "usage_limit",
        message: "You have reached your Antigravity quota for this period.",
        resetsAt: "2026-11-22T10:00:00Z",
      },
    });
  });
  test("an error written while a held turn's background work runs fails the turn", async () => {
    const { client } = createFakeClient();
    const stderr = { text: "" };
    const lateErrorClient: AcpClient = {
      ...client,
      stderrSince: () => stderr.text,
    };
    const session = new AcpTurnSession({
      gracePeriodMs: 200,
      detached: (p) => {
        void p;
      },
      displayName: "Antigravity",
      mcpNames: { stella: "stella", others: [] },
      policy: { approvals: "auto", network: "open", fs: "workspace" },
      workspaceDir: "/tmp/chat",
      unreadablePaths: [],
      onPromptError: () => undefined,
      toolOutlivesPrompt: antigravityCommandOutlivesPrompt,
      classifyErrorOutput: classifyAntigravityError,
      backgroundSettleMs: 5000,
    });
    session.attach(lateErrorClient);
    session.begin("sess-late-err", { type: "fresh" });

    const turn = session.turn();
    const collected = collectEvents(turn);
    session.handlers.notification(ACP_AGENT_NOTIFICATIONS.update, {
      sessionId: "sess-late-err",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "cmd-late",
        title: "bun test",
        kind: "execute",
        status: "in_progress",
        rawInput: { CommandLine: "bun test" },
      },
    });
    session.prompted(Promise.resolve(Result.ok({ stopReason: "end_turn" })));
    await Promise.resolve();
    await Promise.resolve();

    stderr.text =
      "Error 429, Message: Quota exceeded reason:QUOTA_EXHAUSTED quotaResetTimeStamp:2026-11-22T10:00:00Z, Status: RESOURCE_EXHAUSTED";
    session.handlers.notification(ACP_AGENT_NOTIFICATIONS.update, {
      sessionId: "sess-late-err",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "cmd-late",
        status: "completed",
      },
    });
    session.handlers.notification(ACP_AGENT_NOTIFICATIONS.update, {
      sessionId: "sess-late-err",
      update: { sessionUpdate: "usage_update", used: 10, size: 1000 },
    });

    const events = await collected;
    expect(events.at(-1)).toEqual({
      type: "turn.failed",
      failure: {
        type: "usage_limit",
        message: "You have reached your Antigravity quota for this period.",
        resetsAt: "2026-11-22T10:00:00Z",
      },
    });
  });

  test("a steer refused while the turn waits on background work leaves the turn waiting for that work", async () => {
    const { client } = createFakeClient();
    const steerAnswer = Promise.withResolvers<AcpAnswer>();
    const steeringClient: AcpClient = {
      ...client,
      request: async () => await steerAnswer.promise,
    };
    const session = new AcpTurnSession({
      gracePeriodMs: 200,
      detached: (p) => {
        void p;
      },
      displayName: "Antigravity",
      mcpNames: { stella: "stella", others: [] },
      policy: { approvals: "auto", network: "open", fs: "workspace" },
      workspaceDir: "/tmp/chat",
      unreadablePaths: [],
      onPromptError: () => undefined,
      toolOutlivesPrompt: antigravityCommandOutlivesPrompt,
      backgroundSettleMs: 5000,
    });
    session.attach(steeringClient);
    session.steers(true);
    session.begin("sess-steer-held", { type: "fresh" });

    const turn = session.turn();
    const collected = collectEvents(turn);
    session.handlers.notification(ACP_AGENT_NOTIFICATIONS.update, {
      sessionId: "sess-steer-held",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "cmd-steer",
        title: "bun test",
        kind: "execute",
        status: "in_progress",
        rawInput: { CommandLine: "bun test" },
      },
    });
    session.prompted(Promise.resolve(Result.ok({ stopReason: "end_turn" })));
    await Promise.resolve();
    await Promise.resolve();

    await turn.steer({ inputId: "input-held", text: "Also check B." });
    steerAnswer.resolve(
      Result.err(
        new AcpRequestError({
          reason: "rejected",
          code: null,
          message: "busy",
        }),
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    session.handlers.notification(ACP_AGENT_NOTIFICATIONS.update, {
      sessionId: "sess-steer-held",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "cmd-steer",
        status: "completed",
      },
    });
    session.handlers.notification(ACP_AGENT_NOTIFICATIONS.update, {
      sessionId: "sess-steer-held",
      update: { sessionUpdate: "usage_update", used: 10, size: 1000 },
    });

    const events = await collected;
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  test("stderr an earlier turn wrote but not yet read is drained before the mark and does not fail the next turn", async () => {
    const { client } = createFakeClient();
    const quota =
      "Error 429, Message: Quota exceeded reason:QUOTA_EXHAUSTED quotaResetTimeStamp:2026-11-22T10:00:00Z, Status: RESOURCE_EXHAUSTED";
    const stderr = { text: "" };
    const lateReadClient: AcpClient = {
      ...client,
      stderrBytesSeen: () => stderr.text.length,
      stderrSince: (start) => stderr.text.slice(start),
    };
    const clock = { now: 0, sleeps: 0 };
    const session = new AcpTurnSession({
      gracePeriodMs: 200,
      detached: (p) => {
        void p;
      },
      displayName: "Antigravity",
      mcpNames: { stella: "stella", others: [] },
      policy: { approvals: "auto", network: "open", fs: "workspace" },
      workspaceDir: "/tmp/chat",
      unreadablePaths: [],
      onPromptError: () => undefined,
      classifyErrorOutput: classifyAntigravityError,
      stderrClock: {
        now: () => clock.now,
        sleep: async (ms) => {
          clock.now += ms;
          clock.sleeps += 1;
          // The earlier turn's error is read only after this turn attached.
          if (clock.sleeps === 1) {
            stderr.text = quota;
          }
        },
      },
    });
    session.attach(lateReadClient);
    await session.settleStderrMark();
    // Without the wait the late read lands after the mark instead.
    if (stderr.text === "") {
      stderr.text = quota;
    }
    session.begin("sess-drained", { type: "fresh" });

    const turn = session.turn();
    const collected = collectEvents(turn);
    session.prompted(Promise.resolve(Result.ok({ stopReason: "end_turn" })));

    const events = await collected;
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  test("the wait before the stderr mark stops at its cap while stderr stays busy", async () => {
    const { client } = createFakeClient();
    const stderr = { seen: 0 };
    const busyClient: AcpClient = {
      ...client,
      stderrBytesSeen: () => stderr.seen,
    };
    const clock = { now: 1000 };
    const session = new AcpTurnSession({
      gracePeriodMs: 200,
      detached: (p) => {
        void p;
      },
      displayName: "Antigravity",
      mcpNames: { stella: "stella", others: [] },
      policy: { approvals: "auto", network: "open", fs: "workspace" },
      workspaceDir: "/tmp/chat",
      unreadablePaths: [],
      onPromptError: () => undefined,
      stderrClock: {
        now: () => clock.now,
        sleep: async (ms) => {
          clock.now += ms;
          stderr.seen += 10;
        },
      },
    });
    session.attach(busyClient);
    await session.settleStderrMark();
    expect(clock.now - 1000).toBe(250);
  });
});

describe("AcpTurnSession permission requests", () => {
  const SESSION = "sess-ask";

  /** A session at Ask, with the client's answers and notifications in one log. */
  const askingSession = () => {
    const wire: {
      kind: "notify" | "respond";
      method?: string;
      body: unknown;
    }[] = [];
    const prompt = Promise.withResolvers<AcpAnswer>();
    const { client } = createFakeClient();
    const recording: AcpClient = {
      ...client,
      request: async () => await prompt.promise,
      notify: (method, params) => {
        wire.push({ kind: "notify", method, body: params });
      },
      respond: (id, result) => {
        wire.push({ kind: "respond", body: { id, result } });
      },
    };
    const session = new AcpTurnSession({
      gracePeriodMs: 200,
      detached: (p) => {
        void p;
      },
      displayName: "Antigravity",
      mcpNames: { stella: "stella", others: [] },
      policy: { approvals: "ask", network: "open", fs: "workspace" },
      workspaceDir: "/tmp/chat",
      unreadablePaths: [],
      onPromptError: () => undefined,
      toolOutlivesPrompt: antigravityCommandOutlivesPrompt,
      backgroundSettleMs: 5000,
    });
    session.attach(recording);
    session.begin(SESSION, { type: "fresh" });
    const turn = session.turn();
    const events: HarnessEvent[] = [];
    const collected = (async () => {
      for await (const event of turn.events) {
        events.push(event);
      }
    })();
    session.prompted(prompt.promise);
    const ask = (
      id: number,
      options: readonly { optionId: string; kind: string }[],
    ) => {
      session.handlers.request(id, "session/request_permission", {
        sessionId: SESSION,
        toolCall: {
          toolCallId: `call-${String(id)}`,
          title: "rm -rf build",
          kind: "execute",
        },
        options,
      });
    };
    const end = async () => {
      prompt.resolve(Result.ok({ stopReason: "end_turn" }));
      await collected;
    };
    return { ask, end, events, session, turn, wire, collected };
  };

  const ONCE = [
    { optionId: "yes", kind: "allow_once" },
    { optionId: "no", kind: "reject_once" },
  ];

  const requestIdOf = (events: readonly HarnessEvent[]) => {
    const asked = events.find((event) => event.type === "approval.requested");
    return asked?.type === "approval.requested"
      ? asked.request.requestId
      : null;
  };

  test("a request the agent withdraws closes its question while the turn goes on, and an answer then reaches nothing", async () => {
    const { ask, end, events, session, turn, wire } = askingSession();
    ask(7, ONCE);
    const requestId = requestIdOf(events);
    expect(requestId).not.toBeNull();
    session.handlers.notification(ACP_AGENT_NOTIFICATIONS.cancelRequest, {
      requestId: 7,
    });
    expect(events).toContainEqual({
      type: "interaction.resolved",
      requestId: requestId ?? "",
    });
    expect(wire).toContainEqual({
      kind: "respond",
      body: { id: 7, result: { outcome: { outcome: "cancelled" } } },
    });
    const late = await turn.respond({
      type: "approval",
      requestId: requestId ?? "",
      decision: "approve",
    });
    expect(Result.isError(late)).toBe(true);
    // A withdrawal of a request it never sent changes nothing.
    session.handlers.notification(ACP_AGENT_NOTIFICATIONS.cancelRequest, {
      requestId: 99,
    });
    await end();
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  test("a stop sends the cancel first, then answers every pending request cancelled", async () => {
    const { ask, turn, wire, collected } = askingSession();
    ask(3, ONCE);
    await turn.interrupt();
    await collected;
    const cancel = wire.findIndex(
      (entry) => entry.kind === "notify" && entry.method === "session/cancel",
    );
    const answered = wire.findIndex(
      (entry) =>
        entry.kind === "respond" &&
        JSON.stringify(entry.body) ===
          JSON.stringify({
            id: 3,
            result: { outcome: { outcome: "cancelled" } },
          }),
    );
    expect(cancel).toBeGreaterThanOrEqual(0);
    expect(answered).toBeGreaterThan(cancel);
  });

  test("a prompt that refuses only with 'reject always' still offers Deny", async () => {
    const { ask, end, events } = askingSession();
    ask(5, [
      { optionId: "yes", kind: "allow_once" },
      { optionId: "never", kind: "reject_always" },
    ]);
    const asked = events.find((event) => event.type === "approval.requested");
    expect(
      asked?.type === "approval.requested"
        ? asked.request.options.map(({ decision }) => decision)
        : [],
    ).toEqual(["approve", "deny"]);
    await end();
  });
});
