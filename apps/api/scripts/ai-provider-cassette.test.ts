import { describe, expect, test } from "bun:test";

import {
  AiCassetteError,
  createCassetteFetch,
  type AiProviderCassette,
  type CassetteFetch,
} from "./ai-provider-cassette";

const ORIGIN = "https://provider.example";
const API_KEY = "test-secret-key";
const RECORDED_AT = "2026-09-14T12:00:00.000Z";
const DEFAULT_BODY = { model: "synthetic", prompt: "hello" };

const request = (
  body: unknown = DEFAULT_BODY,
  url = `${ORIGIN}/v1/responses?z=2&a=1`,
) =>
  new Request(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
      "x-private-header": "private",
    },
    body: JSON.stringify(body),
  });

const record = (upstreamFetch: CassetteFetch, maxRequests = 1) =>
  createCassetteFetch({
    mode: "record",
    upstreamFetch,
    maxRequests,
    permittedOrigins: [ORIGIN],
    apiKey: API_KEY,
    recordedAt: () => RECORDED_AT,
  });

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const expectRejected = async (promise: Promise<unknown>, message: string) => {
  try {
    await promise;
    throw new TypeError("Expected promise to reject.");
  } catch (error) {
    expect(error).toBeInstanceOf(AiCassetteError);
    expect(error instanceof Error ? error.message : "").toContain(message);
  }
};

describe("AI provider cassette transport", () => {
  test("records sanitized metadata and replays the ordered response", async () => {
    let calls = 0;
    const transport = record(async (_input, init) => {
      calls += 1;
      expect(init?.redirect).toBe("error");
      return jsonResponse(
        {
          id: "message-id-needed-by-sdk",
          request_id: "opaque-request-id",
          usage: {
            input_tokens: 3,
            output_tokens: 1,
            cost: 0.00001,
            cost_details: { upstream_inference_cost: 0.00001 },
          },
          output: [{ tool_call_id: "tool-call-7" }],
        },
        201,
      );
    });

    const liveResponse = await transport.fetch(
      request(undefined, `${ORIGIN}/v1/responses?api_key=${API_KEY}&z=2&a=1`),
    );
    expect(liveResponse.status).toBe(201);
    const cassette = await transport.finish();
    const serialized = JSON.stringify(cassette);

    expect(calls).toBe(1);
    expect(cassette.recordedAt).toBe(RECORDED_AT);
    expect(cassette.entries[0]?.request.url).toBe(
      `${ORIGIN}/v1/responses?a=1&z=2`,
    );
    expect(cassette.entries[0]?.request.headers).toEqual({
      "content-type": "application/json",
    });
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain("hello");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("x-private-header");
    expect(cassette.entries[0]?.response.body).toContain("[request-id]");
    expect(cassette.entries[0]?.response.body).toContain("tool-call-7");
    expect(cassette.entries[0]?.response.body).toContain(
      "message-id-needed-by-sdk",
    );
    expect(cassette.entries[0]?.response.body).toContain("input_tokens");
    expect(cassette.entries[0]?.response.body).not.toContain("cost");

    const replay = createCassetteFetch({ mode: "replay", cassette });
    const replayed = await replay.fetch(request());
    expect(replayed.status).toBe(201);
    expect(await replayed.json()).toEqual({
      id: "message-id-needed-by-sdk",
      request_id: "[request-id]",
      usage: { input_tokens: 3, output_tokens: 1 },
      output: [{ tool_call_id: "tool-call-7" }],
    });
    await replay.finish();
  });

  test("normalizes only completion envelope IDs", async () => {
    const transport = record(async () =>
      jsonResponse({
        id: "gen-random",
        object: "chat.completion",
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call-stable",
                  arguments: {
                    id: "argument-id",
                    nested: { id: "nested-id", object: "chat.completion" },
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    await transport.fetch(request());
    const cassette = await transport.finish();

    expect(JSON.parse(cassette.entries[0]?.response.body ?? "")).toEqual({
      id: "[completion-id]",
      object: "chat.completion",
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call-stable",
                arguments: {
                  id: "argument-id",
                  nested: { id: "nested-id", object: "chat.completion" },
                },
              },
            ],
          },
        },
      ],
    });
  });

  test("matches canonical JSON bodies but rejects an ordered mismatch", async () => {
    const transport = record(async () => jsonResponse({ ok: true }));
    await transport.fetch(request({ b: 2, a: 1 }));
    const cassette = await transport.finish();
    const replay = createCassetteFetch({ mode: "replay", cassette });

    expect(await replay.fetch(request({ a: 1, b: 2 }))).toBeInstanceOf(
      Response,
    );
    await replay.finish();

    const mismatch = createCassetteFetch({ mode: "replay", cassette });
    await expectRejected(
      mismatch.fetch(request({ a: 2, b: 1 })),
      "request did not match replay entry",
    );
  });

  test("fails when replay entries are missing, extra, or unused", async () => {
    const transport = record(async () => jsonResponse({ ok: true }));
    await transport.fetch(request());
    const cassette = await transport.finish();

    const unused = createCassetteFetch({ mode: "replay", cassette });
    await expectRejected(unused.finish(), "did not consume every entry");

    const consumed = createCassetteFetch({ mode: "replay", cassette });
    await consumed.fetch(request());
    await expectRejected(consumed.fetch(request()), "unexpected extra request");
  });

  test("reserves ordered replay entries before concurrent body reads", async () => {
    const transport = record(
      async (input) =>
        jsonResponse({
          url: input instanceof Request ? input.url : new URL(input).toString(),
        }),
      2,
    );
    await Promise.all([
      transport.fetch(request({ sequence: 1 }, `${ORIGIN}/first`)),
      transport.fetch(request({ sequence: 2 }, `${ORIGIN}/second`)),
    ]);
    const cassette = await transport.finish();
    const replay = createCassetteFetch({ mode: "replay", cassette });

    const [first, second] = await Promise.all([
      replay.fetch(request({ sequence: 1 }, `${ORIGIN}/first`)),
      replay.fetch(request({ sequence: 2 }, `${ORIGIN}/second`)),
    ]);
    expect(await first.json()).toEqual({ url: `${ORIGIN}/first` });
    expect(await second.json()).toEqual({ url: `${ORIGIN}/second` });
    await replay.finish();
  });

  test("enforces the request cap before another upstream call", async () => {
    let calls = 0;
    const transport = record(async () => {
      calls += 1;
      return jsonResponse({ ok: true });
    });
    const attempts = await Promise.allSettled([
      transport.fetch(request()),
      transport.fetch(request()),
    ]);
    expect(attempts.map(({ status }) => status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      attempts[1].status === "rejected" ? attempts[1].reason.message : "",
    ).toContain("request limit exceeded");
    expect(calls).toBe(1);
    await expectRejected(transport.finish(), "recording failed");
  });

  test("seals recording while finish waits and after it completes", async () => {
    let releaseUpstream: () => void = () => {
      throw new TypeError("Upstream gate was not initialized.");
    };
    let markUpstreamStarted: () => void = () => {
      throw new TypeError("Upstream start signal was not initialized.");
    };
    let calls = 0;
    const upstreamGate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const upstreamStarted = new Promise<void>((resolve) => {
      markUpstreamStarted = resolve;
    });
    const transport = record(async () => {
      calls += 1;
      markUpstreamStarted();
      await upstreamGate;
      return jsonResponse({ ok: true });
    }, 3);
    const accepted = transport.fetch(request());
    await upstreamStarted;
    const finishing = transport.finish();

    const callsBeforeLateFetch = calls;
    await expectRejected(transport.fetch(request()), "recording is sealed");
    expect(calls).toBe(callsBeforeLateFetch);
    releaseUpstream();
    await accepted;
    await finishing;

    await expectRejected(transport.fetch(request()), "recording is sealed");
    expect(calls).toBe(1);
  });

  test("round-trips SSE while preserving tool call IDs", async () => {
    const sse = [
      'data: {"requestId":"random","tool_call_id":"call_42"}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const transport = record(
      async () =>
        new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    );
    await transport.fetch(request());
    const cassette = await transport.finish();
    const replay = createCassetteFetch({ mode: "replay", cassette });

    const replayed = await replay.fetch(request());
    expect(replayed.headers.get("content-type")).toBe("text/event-stream");
    expect(await replayed.text()).toContain(
      'data: {"requestId":"[request-id]","tool_call_id":"call_42"}',
    );
    await replay.finish();
  });

  test("rejects credential leaks and unsupported response media", async () => {
    const leaked = record(async () => jsonResponse({ error: API_KEY }));
    await expectRejected(
      leaked.fetch(request()),
      "contains configured credentials",
    );
    await expectRejected(leaked.finish(), "recording failed");

    const escaped = record(
      async () =>
        new Response(`{"error":"${API_KEY.replace("s", "\\u0073")}"}`, {
          headers: { "content-type": "application/json" },
        }),
    );
    await expectRejected(
      escaped.fetch(request()),
      "contains configured credentials",
    );

    const binary = record(
      async () =>
        new Response(new Uint8Array([1, 2]), {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    await expectRejected(binary.fetch(request()), "media type is unsupported");
    await expectRejected(binary.finish(), "recording failed");
  });

  test("strictly rejects malformed or extended cassette data", () => {
    const invalid = {
      version: 1,
      recordedAt: RECORDED_AT,
      entries: [],
      secret: API_KEY,
    } satisfies AiProviderCassette & { secret: string };

    expect(() =>
      createCassetteFetch({ mode: "replay", cassette: invalid }),
    ).toThrow("cassette is invalid");
  });
});
