import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import {
  cassetteFor,
  loadProviderWireCassettes,
} from "@/api/tests/helpers/provider-wire-cassette";
import type {
  ProviderWireProvider,
  ProviderWireScenario,
} from "@/api/tests/helpers/provider-wire-cassette";
import {
  findWireContractViolations,
  replayWireScenario,
} from "@/api/tests/helpers/provider-wire-contract";
import {
  bodyBytesOf,
  decodeAwsEventStream,
  installProviderWireReplay,
} from "@/api/tests/helpers/provider-wire-replay";
import type { ProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";

import {
  keptHeaders,
  recordOne,
  sanitizeJson,
  sanitizeTextBody,
} from "./record-provider-cassettes";

const SECRET = "sk-recording-secret";

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
        },
        SECRET,
      ),
    ).toEqual({
      id: "[id]",
      request_id: "[request_id]",
      output: [
        { id: "[id]", type: "message" },
        { call_id: "call_abc", id: "fc_abc", type: "function_call" },
      ],
      content: [{ id: "toolu_01", type: "tool_use" }],
    });
  });

  test("redacts fields that echo request content", () => {
    expect(
      sanitizeJson(
        { instructions: "system text", user: "someone", model: "m" },
        SECRET,
      ),
    ).toEqual({ instructions: "[redacted]", model: "m", user: "[redacted]" });
  });

  test("refuses a response that contains the key", () => {
    const refusal = "A provider response contains the recording key";
    expect(() =>
      sanitizeTextBody(`data: {"echo":"${SECRET}"}\n\n`, SECRET),
    ).toThrow(refusal);
    expect(() => sanitizeJson({ nested: [SECRET] }, SECRET)).toThrow(refusal);
  });

  test("keeps event stream framing while sanitizing each payload", () => {
    const body =
      'event: message_start\r\ndata: {"message":{"id":"msg_9"}}\r\n\r\n: keep-alive\r\ndata: [DONE]\r\n\r\n';
    expect(sanitizeTextBody(body, SECRET)).toBe(
      'event: message_start\r\ndata: {"message":{"id":"[id]"}}\r\n\r\n: keep-alive\r\ndata: [DONE]\r\n\r\n',
    );
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
let upstream: ProviderWireReplay;
let previousMockAI: boolean;

const recordAndReplay = async (
  provider: ProviderWireProvider,
  scenario: ProviderWireScenario,
) => {
  const source = cassetteFor(cassettes, provider, scenario);
  upstream.serve(source);
  const recorded = await recordOne({ provider, scenario, secret: SECRET });
  expect(upstream.takeFindings()).toEqual({ unconsumed: [], unexpected: [] });

  expect(recorded).toMatchObject({
    model: source.model,
    provider,
    scenario,
    source: "recorded",
  });
  // The same request and status; the body with its identifiers replaced.
  const [recordedExchange] = recorded.exchanges;
  const [sourceExchange] = source.exchanges;
  expect(recordedExchange?.request).toEqual(sourceExchange?.request);
  expect(recordedExchange?.response.status).toBe(
    sourceExchange?.response.status,
  );

  const { findings, run } = await replayWireScenario({
    cassette: recorded,
    replay: upstream,
  });
  expect(
    findWireContractViolations({ cassette: recorded, replay: findings, run }),
  ).toEqual([]);
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

  test("an event stream body decodes to the frames it was encoded from", () => {
    const [exchange] = cassetteFor(cassettes, "bedrock", "tool-call").exchanges;
    const body = exchange?.response.body;
    if (body?.encoding !== "aws-eventstream") {
      panic("The Bedrock cassette is not an event stream");
    }
    expect(decodeAwsEventStream(bodyBytesOf(body))).toEqual(body.messages);
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
