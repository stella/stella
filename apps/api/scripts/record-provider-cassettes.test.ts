import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import {
  cassetteFor,
  cassetteKey,
  loadProviderWireCassettes,
} from "@/api/tests/helpers/provider-wire-cassette";
import type {
  ProviderWireProvider,
  ProviderWireScenario,
} from "@/api/tests/helpers/provider-wire-cassette";
import {
  findRequestShapeDrift,
  findWireContractViolations,
  replayWireScenario,
  scenarioPrompt,
  UNKNOWN_MODEL_ID,
  wireChatModel,
} from "@/api/tests/helpers/provider-wire-contract";
import {
  bodyBytesOf,
  decodeAwsEventStream,
  installProviderWireReplay,
} from "@/api/tests/helpers/provider-wire-replay";
import type { ProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";

import {
  keptHeaders,
  MAX_RESPONSE_BYTES,
  offeredModel,
  newRedaction,
  recordOne,
  sanitizeEventPayload,
  sanitizeJson,
  sanitizeTextBody,
  scenariosToRecord,
  wireCarriesNull,
} from "./record-provider-cassettes";

const SECRET = "sk-recording-secret";
/** A fresh recording's redaction. */
const redact = () => newRedaction(SECRET);

describe("provider cassette recording redaction", () => {
  test("replaces response and request ids but keeps tool call ids", () => {
    expect(
      sanitizeJson(
        {
          id: "resp_0123",
          request_id: "req_77",
          output: [
            { id: "msg_1", type: "message" },
            { call_id: "call_abc", id: "fc_abc", type: "function_call" },
          ],
          content: [{ id: "toolu_01", type: "tool_use" }],
          deltas: [{ item_id: "msg_1" }, { item_id: "fc_abc" }],
        },
        redact(),
      ),
    ).toEqual({
      id: "[id_1]",
      request_id: "[id_2]",
      output: [
        { id: "[id_3]", type: "message" },
        { call_id: "call_abc", id: "fc_abc", type: "function_call" },
      ],
      content: [{ id: "toolu_01", type: "tool_use" }],
      deltas: [{ item_id: "[id_3]" }, { item_id: "fc_abc" }],
    });
  });

  test("gives one value one placeholder across keys and events", () => {
    const redaction = redact();
    const added = sanitizeTextBody(
      'data: {"item":{"id":"msg_0123456789","type":"message"}}\n\n',
      redaction,
    );
    const delta = sanitizeTextBody(
      'data: {"item_id":"msg_0123456789","delta":"The"}\n\ndata: {"item_id":"msg_9876543210","delta":"A"}\n\n',
      redaction,
    );
    expect(added).toBe('data: {"item":{"id":"[id_1]","type":"message"}}\n\n');
    expect(delta).toBe(
      'data: {"item_id":"[id_1]","delta":"The"}\n\ndata: {"item_id":"[id_2]","delta":"A"}\n\n',
    );
    // The same value in free text reads as the same placeholder too.
    expect(sanitizeTextBody(": item msg_0123456789\n\n", redaction)).toBe(
      ": item [id_1]\n\n",
    );
  });

  test("replaces the ids of the account the key belongs to", () => {
    expect(
      sanitizeJson(
        { error: { code: 400 }, user_id: "user_2Ab3Cd4Ef5Gh6" },
        redact(),
      ),
    ).toEqual({ error: { code: 400 }, user_id: "[id_1]" });
    expect(
      sanitizeJson(
        { error: { message: "Project `proj_2Ab3Cd4Ef5Gh6` has no access" } },
        redact(),
      ),
    ).toEqual({ error: { message: "Project `[id_1]` has no access" } });
    expect(
      sanitizeTextBody(
        ": account user_2Ab3Cd4Ef5Gh6 org-9Zy8Xw7Vu6\n\n",
        redact(),
      ),
    ).toBe(": account [id_1] [id_2]\n\n");
  });

  test("redacts fields that echo request content", () => {
    expect(
      sanitizeJson(
        { instructions: "system text", user: "someone", model: "m" },
        redact(),
      ),
    ).toEqual({ instructions: "[redacted]", model: "m", user: "[redacted]" });
  });

  test("omits live billing and account routing metadata from usage", () => {
    const usage = {
      prompt_tokens: 12,
      completion_tokens: 3,
      cost: 0.001,
      cost_details: { upstream_inference_cost: 0.0008 },
      is_byok: true,
    };
    expect(sanitizeJson({ usage }, redact())).toEqual({
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });
    expect(
      sanitizeTextBody(`data: ${JSON.stringify({ usage })}\n\n`, redact()),
    ).toBe('data: {"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n');
  });

  test("refuses a response that contains the key", () => {
    const refusal = "A provider response contains the recording key";
    expect(() =>
      sanitizeTextBody(`data: {"echo":"${SECRET}"}\n\n`, redact()),
    ).toThrow(refusal);
    expect(() => sanitizeJson({ nested: [SECRET] }, redact())).toThrow(refusal);
    expect(() => sanitizeJson({ id: `resp_${SECRET}` }, redact())).toThrow(
      refusal,
    );
  });

  test("redacts every event stream payload shape", () => {
    const refusal = "A provider response contains the recording key";
    // Bytes that are not JSON, a JSON scalar, a JSON array and an object.
    expect(() =>
      sanitizeEventPayload(`{"message":"bad key ${SECRET}`, redact()),
    ).toThrow(refusal);
    expect(() => sanitizeEventPayload(`"${SECRET}"`, redact())).toThrow(
      refusal,
    );
    expect(() =>
      sanitizeEventPayload({ nested: { value: SECRET } }, redact()),
    ).toThrow(refusal);
    expect(
      sanitizeEventPayload(
        '{"message":"failed","requestId":"req_4c1d9e2',
        redact(),
      ),
    ).toBe('{"message":"failed","requestId":"[id_1]');
    expect(
      sanitizeEventPayload('[{"id":"resp_0123456789","ok":true}]', redact()),
    ).toBe('[{"id":"[id_1]","ok":true}]');
    expect(sanitizeEventPayload({ id: "msg_0123456789" }, redact())).toEqual({
      id: "[id_1]",
    });
  });

  test("redacts identifiers in stream lines that are not JSON", () => {
    expect(
      sanitizeTextBody(
        'data: {"id":"chatcmpl-abcdef123","delta":"The ca\n\n: request resp_0123456789\n\n',
        redact(),
      ),
    ).toBe('data: {"id":"[id_1]","delta":"The ca\n\n: request [id_2]\n\n');
  });

  test("keeps event stream framing while sanitizing each payload", () => {
    const body =
      'event: message_start\r\ndata: {"message":{"id":"msg_9"}}\r\n\r\n: keep-alive\r\ndata: [DONE]\r\n\r\n';
    expect(sanitizeTextBody(body, redact())).toBe(
      'event: message_start\r\ndata: {"message":{"id":"[id_1]"}}\r\n\r\n: keep-alive\r\ndata: [DONE]\r\n\r\n',
    );
  });

  test("records a tool call and the text that continues it together", () => {
    expect(scenariosToRecord(["tool-call"])).toEqual(["text", "tool-call"]);
    expect(scenariosToRecord(["text"])).toEqual(["text", "tool-call"]);
    expect(scenariosToRecord(["length", "rate-limit", "nonsense"])).toEqual([
      "length",
    ]);
  });

  test("keeps a strict-null recording only when the wire carries a JSON null", () => {
    const streamed = (...deltas: string[]): StreamChunk[] =>
      deltas.map((delta) => ({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call-1",
        delta,
        timestamp: 1,
      }));
    expect(
      wireCarriesNull(streamed('{"name":"draft",', '"note":nu', "ll}")),
    ).toBe(true);
    // A model that writes the string "null" recorded something else.
    expect(wireCarriesNull(streamed('{"name":"draft","note":"null"}'))).toBe(
      false,
    );
    expect(wireCarriesNull(streamed('{"name":"draft"}'))).toBe(false);
  });

  test("keeps only the response headers an SDK reads", () => {
    expect(
      keptHeaders(
        new Headers({
          "content-type": "application/json",
          "request-id": "req_1",
          "retry-after": "2",
          "set-cookie": "a=b",
          "x-amzn-errortype": "ThrottlingException",
          "x-request-id": "abc",
        }),
      ),
    ).toEqual({
      "content-type": "application/json",
      "retry-after": "2",
      "x-amzn-errortype": "ThrottlingException",
    });
  });
});

// A recording made through the real adapter, against a stand-in provider
// (the replay, which answers at the same `fetch` boundary the network would),
// is a cassette the replay test accepts.
const cassettes = loadProviderWireCassettes();

// A prompt that changed after a recording also moves its request shape;
// this names the cause.
test("every recording answers the prompt the recorder sends today", () => {
  expect(
    cassettes
      .filter(
        (cassette) =>
          cassette.source === "recorded" &&
          cassette.prompt !==
            scenarioPrompt(cassette.provider, cassette.scenario),
      )
      .map(cassetteKey),
  ).toEqual([]);
});
let upstream: ProviderWireReplay;
let previousMockAI: typeof env.USE_MOCK_AI;

const recordAndReplay = async (
  provider: ProviderWireProvider,
  scenario: ProviderWireScenario,
  chatModel?: string,
) => {
  // The stand-in answers the model the recording asks for, whichever model
  // the corpus entry was recorded with.
  const source = {
    ...cassetteFor(cassettes, provider, scenario),
    model: chatModel ?? wireChatModel(provider),
  };
  upstream.serve(source);
  const recorded = await recordOne({
    chatModel,
    provider,
    scenario,
    secret: SECRET,
  });
  expect(upstream.takeFindings()).toEqual({ unconsumed: [], unexpected: [] });

  expect(recorded).toMatchObject({
    model: source.model,
    provider,
    scenario,
    source: "recorded",
  });
  if (scenario === "text") {
    expect(recorded.expect).toEqual(source.expect);
  }
  // The same request and status; the body with its identifiers replaced.
  const [recordedExchange] = recorded.exchanges;
  const [sourceExchange] = source.exchanges;
  expect(recordedExchange?.request.method).toBe(sourceExchange?.request.method);
  expect(recordedExchange?.request.path).toBe(sourceExchange?.request.path);
  expect(recordedExchange?.response.status).toBe(
    sourceExchange?.response.status,
  );
  // The shape the recording pins is the request it sent: the prompt is out
  // of it, and replaying the recording sends that request again.
  expect(recordedExchange?.request.shape?.body).toBeDefined();
  expect(JSON.stringify(recordedExchange?.request.shape)).not.toContain(
    scenarioPrompt(provider, scenario),
  );

  const { findings, run, sent } = await replayWireScenario({
    cassette: recorded,
    replay: upstream,
  });
  expect(
    findWireContractViolations({ cassette: recorded, replay: findings, run }),
  ).toEqual([]);
  expect(findRequestShapeDrift({ cassette: recorded, sent })).toEqual([]);
};

describe("a recording replays", () => {
  beforeAll(() => {
    previousMockAI = env.USE_MOCK_AI;
    env.USE_MOCK_AI = false;
    upstream = installProviderWireReplay();
  });

  afterAll(() => {
    upstream.restore();
    env.USE_MOCK_AI = previousMockAI;
  });

  test("stops reading a response at the size limit", async () => {
    // A provider that never stops sending: the recorder must refuse it
    // while reading, not after buffering it whole.
    const slice = new Uint8Array(64 * 1024).fill(0x61);
    // Bytes served per request; a retrying SDK asks more than once.
    const served: number[] = [];
    const replayFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () => {
        const request = served.push(0) - 1;
        return await Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull: (controller) => {
                served[request] = (served[request] ?? 0) + slice.length;
                controller.enqueue(slice);
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      },
      { preconnect: () => undefined },
    );
    let outcome = "recorded";
    try {
      await recordOne({ provider: "openai", scenario: "text", secret: SECRET });
    } catch (error) {
      outcome = error instanceof Error ? error.message : "refused";
    } finally {
      globalThis.fetch = replayFetch;
    }
    expect(outcome).toContain("exceeds the recording size limit");
    expect(served.length).toBeGreaterThan(0);
    for (const bytes of served) {
      expect(bytes).toBeGreaterThan(MAX_RESPONSE_BYTES);
      expect(bytes).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + 4 * slice.length);
    }
  });

  test("an event stream body decodes to the frames it was encoded from", () => {
    const [exchange] = cassetteFor(cassettes, "bedrock", "tool-call").exchanges;
    const body = exchange?.response.body;
    if (body?.encoding !== "aws-eventstream") {
      panic("The Bedrock cassette is not an event stream");
    }
    expect(decodeAwsEventStream(bodyBytesOf(body))).toEqual(body.messages);
  });

  test("records with a --model the provider's catalog offers", async () => {
    await recordAndReplay("openai", "tool-call", "gpt-6-luna");
  });

  test("records the rejected request with the unknown model whatever --model says", async () => {
    upstream.serve(cassetteFor(cassettes, "openai", "bad-request"));
    const recorded = await recordOne({
      chatModel: "gpt-6-luna",
      provider: "openai",
      scenario: "bad-request",
      secret: SECRET,
    });
    expect(upstream.takeFindings()).toEqual({ unconsumed: [], unexpected: [] });
    expect(recorded.model).toBe(UNKNOWN_MODEL_ID);
  });

  test("refuses a --model outside the provider's catalog", () => {
    expect(offeredModel("openai", "gpt-6-luna")).toBe("gpt-6-luna");
    for (const model of ["claude-opus-5-5", "openai/gpt-6-luna", "gpt-x"]) {
      expect(() => offeredModel("openai", model)).toThrow(
        `--model ${model} is not one of openai's models`,
      );
    }
  });

  // Bedrock stays out: a request that ever bypassed `fetch` here would reach
  // AWS, and the recorder only permits the real endpoint.
  for (const [provider, scenario] of [
    ["openai", "tool-call"],
    ["anthropic", "text"],
  ] as const) {
    test(`${provider} ${scenario}`, async () => {
      await recordAndReplay(provider, scenario);
    });
  }
});
