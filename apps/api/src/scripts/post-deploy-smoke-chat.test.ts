import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { createSafeId } from "@/api/lib/branded-types";
import {
  buildApprovalBody,
  buildSmokeAIConfigBody,
  describeChatSendFailure,
  evaluateApprovedTurn,
  evaluateFollowUpTurn,
  evaluatePendingApproval,
  evaluateTurnStream,
  parseThreadMessages,
  readTurnStream,
  runAIChatJourney,
  SMOKE_AI_MODEL_ID,
  SMOKE_APPROVAL_TOOL_NAME,
  type SmokeRequest,
  type StoredMessage,
} from "@/api/scripts/post-deploy-smoke-chat";

const sse = (...frames: object[]): string =>
  frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");

const FINISHED_STREAM = sse(
  { type: "RUN_STARTED" },
  { type: "TEXT_MESSAGE_CONTENT", delta: "ok" },
  { type: "RUN_FINISHED" },
);

const pendingCall = {
  type: "tool-call",
  id: "call-1",
  name: SMOKE_APPROVAL_TOOL_NAME,
  arguments: '{"subagents":[{"task":"Reply with the word OK."}]}',
  state: "approval-requested",
  approval: { id: "approval-1", needsApproval: true },
};

const completedCall = {
  ...pendingCall,
  state: "complete",
  approval: { id: "approval-1", needsApproval: true, approved: true },
  output: { results: [{ index: 0, status: "completed", result: "OK" }] },
};

const awaitingApproval = {
  turnOutcome: {
    type: "awaiting-user",
    interaction: { type: "approval", toolCallId: "call-1" },
  },
};
const completed = { turnOutcome: { type: "completed" } };

const userMessage = (id: string, text: string) => ({
  id,
  role: "user",
  parts: [{ type: "text", content: text }],
});

const storedThread = (messages: unknown[]): StoredMessage[] =>
  parseThreadMessages({ messages }) ?? panic("fixture thread must parse");

const pendingThread = () =>
  storedThread([
    userMessage("u1", "go"),
    {
      id: "a1",
      role: "assistant",
      parts: [pendingCall],
      metadata: awaitingApproval,
    },
  ]);

const pendingOf = (messages: readonly StoredMessage[]) => {
  const { pending } = evaluatePendingApproval(messages);
  return pending ?? panic("fixture thread must await approval");
};

describe("evaluateTurnStream", () => {
  test("passes a stream that finished without a run error", () => {
    expect(evaluateTurnStream("turn", FINISHED_STREAM).ok).toBe(true);
  });

  test("fails a run error even when the run later finishes", () => {
    const check = evaluateTurnStream(
      "turn",
      sse(
        { type: "RUN_ERROR", message: "provider rejected the tool schema" },
        { type: "RUN_FINISHED" },
      ),
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("provider rejected the tool schema");
  });

  test("fails a stream that ends before the run finishes", () => {
    expect(
      evaluateTurnStream(
        "turn",
        sse({ type: "RUN_STARTED" }, { type: "TEXT_MESSAGE_CONTENT" }),
      ).ok,
    ).toBe(false);
  });
});

describe("readTurnStream", () => {
  const streamOf = (chunks: string[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      }),
    );

  test("reads the whole stream", async () => {
    expect(
      await readTurnStream(streamOf(["data: 1\n\n", "data: 2\n\n"])),
    ).toEqual({ text: "data: 1\n\ndata: 2\n\n" });
  });

  test("stops a stream past the byte cap", async () => {
    const result = await readTurnStream(streamOf(["x".repeat(64)]), {
      maxBytes: 16,
    });
    expect(result).toEqual({ error: "stream exceeded 16 bytes" });
  });

  test("stops a stream that does not finish in time", async () => {
    const never = new Promise<void>((_resolve) => {});
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: async () => {
          await never;
        },
      }),
    );
    expect(await readTurnStream(response, { timeoutMs: 5 })).toEqual({
      error: "Chat stream did not finish before timeout",
    });
  });
});

describe("describeChatSendFailure", () => {
  test("reports the no-AI response as a configuration regression", () => {
    const detail = describeChatSendFailure(
      403,
      '{"message":"AI is not available for the \\"chat\\" role on this deployment."}',
    );
    expect(detail).toContain("AI smoke organization");
    expect(detail).toContain("no longer reaches chat");
  });

  test("reports any other failure with its status and body", () => {
    expect(describeChatSendFailure(500, "boom")).toBe("500 boom");
  });
});

describe("buildSmokeAIConfigBody", () => {
  test("puts the one smoke model on every role of the keyed provider", () => {
    const body = buildSmokeAIConfigBody("key");
    expect(body.providers).toEqual([{ provider: "openai", apiKey: "key" }]);
    expect(Object.keys(body.overrideModels).toSorted()).toEqual([
      "chat",
      "fast",
      "pdf",
      "reasoning",
    ]);
    for (const selection of Object.values(body.overrideModels)) {
      expect(selection).toEqual({
        provider: "openai",
        modelId: SMOKE_AI_MODEL_ID,
      });
    }
  });
});

describe("evaluatePendingApproval", () => {
  test("finds the smoke tool waiting on its approval", () => {
    const { check, pending } = evaluatePendingApproval(pendingThread());
    expect(check.ok).toBe(true);
    expect(pending).toMatchObject({
      approvalId: "approval-1",
      callId: "call-1",
    });
  });

  test("fails when the model answered without calling the tool", () => {
    const { check, pending } = evaluatePendingApproval(
      storedThread([
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", content: "OK" }],
          metadata: completed,
        },
      ]),
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("tool calls: none");
    expect(pending).toBeNull();
  });

  test("fails when the turn did not stop for the approval", () => {
    const { check } = evaluatePendingApproval(
      storedThread([
        {
          id: "a1",
          role: "assistant",
          parts: [pendingCall],
          metadata: completed,
        },
      ]),
    );
    expect(check.ok).toBe(false);
  });
});

describe("buildApprovalBody", () => {
  test("approves the stored call and resumes the interrupted run", () => {
    const pending = pendingOf(pendingThread());
    const body = buildApprovalBody({
      ...pending,
      interruptedRunId: "run-1",
      runId: "run-2",
      threadId: createSafeId<"chatThread">(),
    });
    const { message } = body.forwardedProps;
    expect({ ...message, id: String(message.id) }).toEqual({
      id: "a1",
      role: "assistant",
      parts: [
        {
          ...pendingCall,
          approval: { id: "approval-1", needsApproval: true, approved: true },
          state: "approval-responded",
        },
      ],
    });
    expect(body.forwardedProps).toMatchObject({
      parentRunId: "run-1",
      resume: [
        {
          interruptId: "approval-1",
          payload: { approved: true },
          status: "resolved",
        },
      ],
      runId: "run-2",
    });
    expect(body.data).toEqual(body.forwardedProps);
  });
});

describe("evaluateApprovedTurn", () => {
  const settle = (assistant: object) =>
    evaluateApprovedTurn({
      messages: storedThread([userMessage("u1", "go"), assistant]),
      pending: pendingOf(pendingThread()),
    });

  test("passes a call stored complete with output and a text answer", () => {
    expect(
      settle({
        id: "a1",
        role: "assistant",
        parts: [completedCall, { type: "text", content: "OK" }],
        metadata: completed,
      }).ok,
    ).toBe(true);
  });

  test("fails a call stored complete without its output", () => {
    const { output: _output, ...withoutOutput } = completedCall;
    expect(
      settle({
        id: "a1",
        role: "assistant",
        parts: [withoutOutput, { type: "text", content: "OK" }],
        metadata: completed,
      }).detail,
    ).toBe("approved call is complete without output");
  });

  test("fails an approved call left open on a completed turn", () => {
    expect(
      settle({
        id: "a1",
        role: "assistant",
        parts: [
          {
            ...pendingCall,
            approval: { ...pendingCall.approval, approved: true },
            state: "approval-responded",
          },
          { type: "text", content: "OK" },
        ],
        metadata: completed,
      }).ok,
    ).toBe(false);
  });

  test("fails when the model did not answer in text", () => {
    expect(
      settle({
        id: "a1",
        role: "assistant",
        parts: [completedCall],
        metadata: completed,
      }).detail,
    ).toBe("the model did not answer in text after the tool");
  });

  test("fails when the subagent did not complete", () => {
    expect(
      settle({
        id: "a1",
        role: "assistant",
        parts: [
          {
            ...completedCall,
            output: { results: [{ index: 0, status: "failed", error: "x" }] },
          },
          { type: "text", content: "OK" },
        ],
        metadata: completed,
      }).ok,
    ).toBe(false);
  });

  test("fails when the continuation lost the approved call", () => {
    expect(
      settle({
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", content: "OK" }],
        metadata: completed,
      }).detail,
    ).toBe("approved call call-1 is no longer stored");
  });
});

describe("evaluateFollowUpTurn", () => {
  const settled = [
    userMessage("u1", "go"),
    {
      id: "a1",
      role: "assistant",
      parts: [completedCall, { type: "text", content: "OK" }],
      metadata: completed,
    },
  ];

  test("passes a new completed text answer", () => {
    expect(
      evaluateFollowUpTurn({
        messages: storedThread([
          ...settled,
          userMessage("u2", "again"),
          {
            id: "a2",
            role: "assistant",
            parts: [{ type: "text", content: "ok" }],
            metadata: completed,
          },
        ]),
        previousAssistantId: "a1",
      }).ok,
    ).toBe(true);
  });

  test("fails when no new assistant message was stored", () => {
    expect(
      evaluateFollowUpTurn({
        messages: storedThread([...settled, userMessage("u2", "again")]),
        previousAssistantId: "a1",
      }).ok,
    ).toBe(false);
  });
});

const sendBodySchema = v.object({
  forwardedProps: v.object({
    message: v.object({ role: v.string() }),
    resume: v.optional(v.array(v.unknown())),
  }),
});

/**
 * A deployment that answers the journey the way a healthy API does: the first
 * send stops on the tool's approval, the approval completes the call and
 * answers in text, and the follow-up answers in text.
 */
const createFakeDeployment = ({
  chatStatus = 200,
  throwOnReload = false,
}: { chatStatus?: number; throwOnReload?: boolean } = {}) => {
  const calls: string[] = [];
  const messages: object[] = [];
  const request: SmokeRequest = async (path, { body, method }) => {
    calls.push(`${method ?? "GET"} ${path}`);
    if (method === "DELETE") {
      return await Promise.resolve(Response.json({}));
    }
    if (path === "/v1/organization-settings/ai-config") {
      return await Promise.resolve(Response.json({}));
    }
    if (path.endsWith("/messages")) {
      if (throwOnReload) {
        throw new Error("request timed out");
      }
      return await Promise.resolve(Response.json({ messages }));
    }
    if (chatStatus !== 200) {
      return await Promise.resolve(
        Response.json(
          { message: 'AI is not available for the "chat" role.' },
          { status: chatStatus },
        ),
      );
    }
    const send = v.parse(sendBodySchema, body);
    if (send.forwardedProps.resume) {
      messages.splice(1, 1, {
        id: "a1",
        role: "assistant",
        parts: [completedCall, { type: "text", content: "OK" }],
        metadata: completed,
      });
    } else if (messages.length === 0) {
      messages.push(userMessage("u1", "go"), {
        id: "a1",
        role: "assistant",
        parts: [pendingCall],
        metadata: awaitingApproval,
      });
    } else {
      messages.push(userMessage("u2", "again"), {
        id: "a2",
        role: "assistant",
        parts: [{ type: "text", content: "ok" }],
        metadata: completed,
      });
    }
    return await Promise.resolve(
      new Response(FINISHED_STREAM, {
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };
  return { calls, request };
};

describe("runAIChatJourney", () => {
  test("passes send, approve, text, reload, and a follow-up turn", async () => {
    const deployment = createFakeDeployment();
    const checks = await runAIChatJourney({
      apiKey: "key",
      request: deployment.request,
    });
    expect(checks.filter(({ ok }) => !ok)).toEqual([]);
    expect(checks.map(({ name }) => name)).toEqual([
      "POST /v1/organization-settings/ai-config",
      "POST /v1/chat/ (turn 1)",
      "turn 1 awaits tool approval",
      "POST /v1/chat/ (approval)",
      "turn 1 settles after approval",
      "POST /v1/chat/ (turn 2)",
      "turn 2 completes",
      "cleanup: DELETE /v1/chat/threads/:threadId",
      "cleanup: DELETE /v1/organization-settings/ai-config",
    ]);
    expect(
      deployment.calls.filter((call) => call === "POST /v1/chat/"),
    ).toHaveLength(3);
    const threadDeletes = deployment.calls.filter((call) =>
      call.startsWith("DELETE /v1/chat/threads/"),
    );
    expect(threadDeletes).toHaveLength(1);
    expect(
      deployment.calls.some((call) =>
        call.startsWith(threadDeletes[0]?.replace("DELETE", "GET") ?? "-"),
      ),
    ).toBe(true);
  });

  test("fails on the no-AI response and sends nothing further", async () => {
    const deployment = createFakeDeployment({ chatStatus: 403 });
    const checks = await runAIChatJourney({
      apiKey: "key",
      request: deployment.request,
    });
    const turn = checks.find(({ name }) => name === "POST /v1/chat/ (turn 1)");
    expect(turn).toMatchObject({ ok: false });
    expect(turn?.detail).toContain("AI smoke organization");
    expect(deployment.calls).toEqual([
      "POST /v1/organization-settings/ai-config",
      "POST /v1/chat/",
      expect.stringMatching(/^DELETE \/v1\/chat\/threads\/.+/u),
      "DELETE /v1/organization-settings/ai-config",
    ]);
  });

  test("still cleans up when a request throws mid-journey", async () => {
    const deployment = createFakeDeployment({ throwOnReload: true });
    const checks = await runAIChatJourney({
      apiKey: "key",
      request: deployment.request,
    });
    expect(checks.find(({ name }) => name === "AI chat journey")).toMatchObject(
      { ok: false, detail: "aborted: request timed out" },
    );
    expect(deployment.calls.slice(-2)).toEqual([
      expect.stringMatching(/^DELETE \/v1\/chat\/threads\/.+/u),
      "DELETE /v1/organization-settings/ai-config",
    ]);
  });

  test("never creates a thread when the AI config is refused", async () => {
    const calls: string[] = [];
    const checks = await runAIChatJourney({
      apiKey: "key",
      request: async (path, { method }) => {
        calls.push(`${method ?? "GET"} ${path}`);
        return await Promise.resolve(
          method === "DELETE"
            ? Response.json({})
            : Response.json({ message: "invalid key" }, { status: 400 }),
        );
      },
    });
    expect(checks.map(({ ok }) => ok)).toEqual([false, true]);
    expect(calls).toEqual([
      "POST /v1/organization-settings/ai-config",
      "DELETE /v1/organization-settings/ai-config",
    ]);
  });
});
