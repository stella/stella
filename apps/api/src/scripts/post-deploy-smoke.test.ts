import { describe, expect, test } from "bun:test";

import {
  allChecksPassed,
  buildChatSmokeBody,
  evaluateChatStreamPrefix,
  evaluateChatStreamContentType,
  evaluateHttpCheck,
  isExpectedChatBusinessResponse,
  isServerError,
  readStreamPrefix,
  streamPrefixHasError,
} from "@/api/scripts/post-deploy-smoke";

describe("isServerError", () => {
  test("only 5xx counts as a server error", () => {
    expect(isServerError(200)).toBe(false);
    expect(isServerError(403)).toBe(false);
    expect(isServerError(404)).toBe(false);
    expect(isServerError(499)).toBe(false);
    expect(isServerError(500)).toBe(true);
    expect(isServerError(503)).toBe(true);
    expect(isServerError(599)).toBe(true);
    expect(isServerError(600)).toBe(false);
  });
});

describe("evaluateHttpCheck", () => {
  test("okOnly mode passes only on 2xx", () => {
    expect(
      evaluateHttpCheck({ name: "mint", status: 200, mode: "okOnly" }).ok,
    ).toBe(true);
    expect(
      evaluateHttpCheck({ name: "mint", status: 404, mode: "okOnly" }).ok,
    ).toBe(false);
    expect(
      evaluateHttpCheck({ name: "mint", status: 500, mode: "okOnly" }).ok,
    ).toBe(false);
  });

  test("chatSend mode allows only 2xx and the no-AI business response", () => {
    expect(
      evaluateHttpCheck({
        body: '{"message":"AI is not available. Configure an AI key."}',
        name: "chat",
        status: 403,
        mode: "chatSend",
      }).ok,
    ).toBe(true);
    expect(
      evaluateHttpCheck({
        body: "",
        name: "chat",
        status: 200,
        mode: "chatSend",
      }).ok,
    ).toBe(true);
    expect(
      evaluateHttpCheck({
        body: '{"message":"Unauthorized"}',
        name: "chat",
        status: 401,
        mode: "chatSend",
      }).ok,
    ).toBe(false);
    expect(
      evaluateHttpCheck({
        body: '{"message":"Payment required"}',
        name: "chat",
        status: 402,
        mode: "chatSend",
      }).ok,
    ).toBe(false);
    expect(
      evaluateHttpCheck({
        body: '{"message":"Forbidden"}',
        name: "chat",
        status: 403,
        mode: "chatSend",
      }).ok,
    ).toBe(false);
    expect(
      evaluateHttpCheck({
        body: '{"message":"Not found"}',
        name: "chat",
        status: 404,
        mode: "chatSend",
      }).ok,
    ).toBe(false);
    expect(
      evaluateHttpCheck({
        body: "",
        name: "chat",
        status: 500,
        mode: "chatSend",
      }).ok,
    ).toBe(false);
  });
});

describe("isExpectedChatBusinessResponse", () => {
  test("matches only the no-AI 403 response", () => {
    expect(
      isExpectedChatBusinessResponse(
        403,
        '{"message":"AI is not available. Configure an AI key."}',
      ),
    ).toBe(true);
    expect(isExpectedChatBusinessResponse(403, '{"message":"Forbidden"}')).toBe(
      false,
    );
    expect(
      isExpectedChatBusinessResponse(
        402,
        '{"message":"AI is not available. Configure an AI key."}',
      ),
    ).toBe(false);
  });
});

describe("evaluateChatStreamContentType", () => {
  test("allows only event-stream chat responses", () => {
    expect(evaluateChatStreamContentType("text/event-stream").ok).toBe(true);
    expect(
      evaluateChatStreamContentType("text/event-stream; charset=utf-8").ok,
    ).toBe(true);
    expect(evaluateChatStreamContentType("TEXT/EVENT-STREAM").ok).toBe(true);
    expect(evaluateChatStreamContentType(null).ok).toBe(false);
    expect(evaluateChatStreamContentType("").ok).toBe(false);
    expect(evaluateChatStreamContentType("application/json").ok).toBe(false);
    expect(evaluateChatStreamContentType("text/plain").ok).toBe(false);
  });
});

describe("streamPrefixHasError", () => {
  test("detects an AI SDK error frame in the SSE prefix", () => {
    expect(
      streamPrefixHasError('data: {"type":"error","errorText":"boom"}\n\n'),
    ).toBe(true);
  });

  test("does not flag a healthy text stream", () => {
    expect(
      streamPrefixHasError(
        'data: {"type":"start"}\n\ndata: {"type":"text-delta","delta":"hi"}\n\n',
      ),
    ).toBe(false);
  });
});

describe("evaluateChatStreamPrefix", () => {
  test("requires a data frame before accepting a stream", () => {
    expect(evaluateChatStreamPrefix("").ok).toBe(false);
    expect(evaluateChatStreamPrefix("\n\n").ok).toBe(false);
    expect(evaluateChatStreamPrefix(": keepalive\n\n").ok).toBe(false);
    expect(evaluateChatStreamPrefix('data: {"type":"start"}\n\n').ok).toBe(
      true,
    );
    expect(evaluateChatStreamPrefix('data: {"type":"error"}\n\n').ok).toBe(
      false,
    );
  });
});

describe("readStreamPrefix", () => {
  test("stops after the first decisive data frame", async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(encoder.encode('data: {"type":"start"}\n\n'));
        },
      }),
    );

    const prefix = await readStreamPrefix(response, { timeoutMs: 5 });
    expect(prefix).toBe('data: {"type":"start"}\n\n');
  });

  test("rejects when a stream does not produce a prefix before the timeout", async () => {
    const never = new Promise<void>((_resolve) => {});
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: async () => {
          await never;
        },
      }),
    );

    let message = "";
    try {
      await readStreamPrefix(response, { timeoutMs: 5 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "Chat stream did not produce a readable prefix before timeout",
    );
  });
});

describe("allChecksPassed", () => {
  test("passes only when every check is ok", () => {
    expect(
      allChecksPassed([
        { name: "a", ok: true, detail: "" },
        { name: "b", ok: true, detail: "" },
      ]),
    ).toBe(true);
    expect(
      allChecksPassed([
        { name: "a", ok: true, detail: "" },
        { name: "b", ok: false, detail: "" },
      ]),
    ).toBe(false);
  });
});

describe("buildChatSmokeBody", () => {
  test("produces a fresh thread id and a user text message", () => {
    const body = buildChatSmokeBody();
    expect(body.sendMode).toBe("rawOverride");
    const uuid =
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
    expect(body.threadId).toMatch(uuid);
    const { message } = body;
    expect(message.role).toBe("user");
    expect(message.id).toMatch(uuid);
    expect(message.parts).toEqual([{ type: "text", text: "ping" }]);
  });

  test("each call uses a distinct thread id", () => {
    expect(buildChatSmokeBody().threadId).not.toBe(
      buildChatSmokeBody().threadId,
    );
  });
});
