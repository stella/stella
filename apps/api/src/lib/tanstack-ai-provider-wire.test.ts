import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { withProviderStreamContract } from "@/api/lib/chat/provider-stream-contract";
import { createTanStackTextAdapterFactory } from "@/api/lib/tanstack-ai-models";
import { CHAT_ORACLE } from "@/api/tests/helpers/chat-oracles";
import type { OracleViolation } from "@/api/tests/helpers/chat-oracles";
import {
  cassetteFor,
  cassetteKey,
  findMissingCassettes,
  findUndecidedErrorUsage,
  loadProviderWireCassettes,
  PROVIDER_WIRE_PROVIDERS,
} from "@/api/tests/helpers/provider-wire-cassette";
import type {
  ProviderWireCassette,
  ProviderWireProvider,
} from "@/api/tests/helpers/provider-wire-cassette";
import {
  findRequestShapeDrift,
  findWireCancelViolations,
  findWireContractViolations,
  replayWireScenario,
  wireChatModel,
} from "@/api/tests/helpers/provider-wire-contract";
import { installProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import type {
  ProviderWireReplay,
  ReplayedRequest,
} from "@/api/tests/helpers/provider-wire-replay";
import {
  UNMET,
  UNMET_SIZE,
  violatedOracles,
} from "@/api/tests/helpers/provider-wire-unmet";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// Every provider adapter against the provider wire corpus
// (`src/tests/fixtures/provider-wire`): the real adapter, its real SDK and
// our model resolution, with only `fetch` answered from a cassette. Each
// cassette's normalized events must satisfy one contract, whichever
// provider produced them.

const cassettes = loadProviderWireCassettes();

const {
  providerWireRequestShape: requestShape,
  providerWireToolInput: toolInput,
} = CHAT_ORACLE;

let replay: ProviderWireReplay;
let previousMockAI: boolean;
let previousBedrockEndpoint: string | undefined;

beforeAll(() => {
  // Real adapters, not the local mock model.
  previousMockAI = env.USE_MOCK_AI;
  env.USE_MOCK_AI = false;
  // Were a Bedrock request ever to bypass `fetch`, it would go to a host
  // that does not resolve rather than to AWS.
  previousBedrockEndpoint = process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
  process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] =
    "https://bedrock-runtime.us-east-1.amazonaws.com.cassette.invalid";
  replay = installProviderWireReplay();
});

afterAll(() => {
  replay.restore();
  env.USE_MOCK_AI = previousMockAI;
  if (previousBedrockEndpoint === undefined) {
    delete process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
  } else {
    process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] = previousBedrockEndpoint;
  }
});

const expectContract = (
  key: string,
  violations: readonly OracleViolation[],
) => {
  const unmet = UNMET[key];
  if (unmet === undefined) {
    if (violations.length > 0) {
      panic(
        `The adapter breaks the wire contract: ${JSON.stringify(violations)}`,
      );
    }
    return;
  }
  if (violations.length === 0) {
    panic(`${key} meets the contract now: remove it from UNMET`);
  }
  expect(violatedOracles(violations)).toEqual(unmet.oracles.toSorted());
};

/** Every request the adapter sent is the one its exchange pins, shown as a
 *  diff of the two when it is not. */
const expectPinnedRequests = (
  cassette: ProviderWireCassette,
  sent: readonly ReplayedRequest[],
) => {
  for (const drift of findRequestShapeDrift({ cassette, sent })) {
    const where = JSON.stringify({
      cassette: cassetteKey(cassette),
      exchange: drift.exchange,
      oracle: requestShape,
    });
    const heading = `${where}: the adapter sends another request than the cassette pins. To pin today's, run \`bun run record:provider-cassettes --update-request-shapes\` and review the diff.`;
    expect(drift.got, heading).toBe(drift.expected);
  }
};

const checkCassette = async (cassette: ProviderWireCassette) => {
  const { findings, run, sent } = await replayWireScenario({
    cassette,
    replay,
  });
  expectContract(
    cassetteKey(cassette),
    findWireContractViolations({ cassette, replay: findings, run }),
  );
  expectPinnedRequests(cassette, sent);
};

const checkCancel = async (provider: ProviderWireProvider) => {
  const { findings, requests, run } = await replayWireScenario({
    cancelAfterFirstDelta: true,
    cassette: cassetteFor(cassettes, provider, "text"),
    replay,
  });
  expectContract(
    `${provider}/cancel`,
    findWireCancelViolations({ replay: findings, requests, run }),
  );
};

/** Retried failures wait out each SDK's backoff. */
const RETRY_TIMEOUT_MS = 60_000;

describe("provider wire corpus", () => {
  test("every provider has a cassette for every scenario its protocol can produce", () => {
    expect(findMissingCassettes(cassettes)).toEqual([]);
  });

  test("every error cassette whose body reports usage decides what its run error carries", () => {
    expect(findUndecidedErrorUsage(cassettes)).toEqual([]);
  });

  test("every unmet entry names a cassette in the corpus", () => {
    const keys = new Set(
      cassettes.flatMap((cassette) => [
        cassetteKey(cassette),
        `${cassette.provider}/cancel`,
      ]),
    );
    expect(Object.keys(UNMET).filter((key) => !keys.has(key))).toEqual([]);
  });

  test("the unmet ledger only shrinks, and every entry gives its reason", () => {
    expect(Object.keys(UNMET).length).toBe(UNMET_SIZE);
    expect(
      Object.entries(UNMET)
        .filter(
          ([, entry]) =>
            entry.reason.trim() === "" || entry.oracles.length === 0,
        )
        .map(([key]) => key),
    ).toEqual([]);
  });

  test("every exchange pins the request it answers", () => {
    expect(
      cassettes
        .filter(({ exchanges }) =>
          exchanges.some(({ request }) => request.shape === undefined),
        )
        .map(cassetteKey),
    ).toEqual([]);
  });

  test("a tool schema whose properties change order is a finding", async () => {
    // A strict provider generates a tool's input in its schema's property
    // order, so the order is part of the request.
    const cassette = cassetteFor(cassettes, "openai", "tool-call");
    const { sent } = await replayWireScenario({ cassette, replay });
    expect(findRequestShapeDrift({ cassette, sent })).toEqual([]);
    const [exchange] = cassette.exchanges;
    const pinned = exchange?.request.shape;
    if (exchange === undefined || pinned === undefined) {
      panic("The tool call cassette pins no request");
    }
    // Every schema's properties, last first.
    const reorder = (value: unknown, key?: string): unknown => {
      if (Array.isArray(value)) {
        return value.map((child) => reorder(child));
      }
      if (typeof value !== "object" || value === null) {
        return value;
      }
      const entries = Object.entries(value).map(
        ([childKey, child]): [string, unknown] => [
          childKey,
          reorder(child, childKey),
        ],
      );
      return Object.fromEntries(
        key === "properties" ? entries.toReversed() : entries,
      );
    };
    const reordered = { ...pinned, body: reorder(pinned.body) };
    // The same request, only in another order.
    expect(reordered).toEqual(pinned);
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(pinned));
    expect(
      findRequestShapeDrift({
        cassette: {
          ...cassette,
          exchanges: [
            { ...exchange, request: { ...exchange.request, shape: reordered } },
          ],
        },
        sent,
      }),
    ).toHaveLength(1);
  });

  test("a header fetch's init overrides is the header the request is pinned by", async () => {
    // `fetch(request, { headers })` sends the init's headers, not the
    // request's, so the shape must be read from what is sent.
    const cassette = cassetteFor(cassettes, "anthropic", "text");
    const [exchange] = cassette.exchanges;
    if (exchange === undefined) {
      panic("The text cassette has no exchange");
    }
    replay.serve(cassette);
    const response = await fetch(
      new Request(`https://api.anthropic.com${exchange.request.path}`, {
        body: JSON.stringify({ model: cassette.model }),
        headers: { "anthropic-version": "on-the-request" },
        method: "POST",
      }),
      { headers: { "anthropic-version": "sent" } },
    );
    await response.body?.cancel();
    const sent = replay.requests().map(({ exchange: index, headers }) => ({
      index,
      version: headers.get("anthropic-version"),
    }));
    replay.takeFindings();
    expect(sent, JSON.stringify({ oracle: requestShape })).toEqual([
      { index: 0, version: "sent" },
    ]);
  });

  test("a tool call ended twice is a finding", async () => {
    // The real adapter's run, with one TOOL_CALL_END repeated.
    const cassette = cassetteFor(cassettes, "openai", "tool-call");
    const { findings, run } = await replayWireScenario({ cassette, replay });
    const end = run.chunks.find(
      (chunk) => chunk.type === EventType.TOOL_CALL_END,
    );
    if (end === undefined) {
      panic("The tool call cassette ends no tool call");
    }
    const repeated = run.chunks.flatMap((chunk) =>
      chunk === end ? [chunk, { ...chunk }] : [chunk],
    );
    expect(
      findWireContractViolations({
        cassette,
        replay: findings,
        run: { ...run, chunks: repeated },
      }),
    ).toContainEqual({
      detail: {
        event: EventType.TOOL_CALL_END,
        problem: "a tool call id repeats",
      },
      oracle: toolInput,
    });
  });
});

describe("every adapter satisfies the wire contract", () => {
  for (const cassette of cassettes) {
    test(
      cassetteKey(cassette).replace("/", " "),
      async () => {
        await checkCassette(cassette);
      },
      RETRY_TIMEOUT_MS,
    );
  }
});

// Every adapter we ship ends a cut-off stream in its own run error, but only
// through our patches: the releases they patch end it with no terminal event
// (each patch's header). The stream contract is what holds every adapter to
// one terminal event, so it is checked on the stream such a release produces.
describe("the stream contract holds where an adapter does not", () => {
  test("a cut-off stream an adapter leaves unended", async () => {
    const cassette = cassetteFor(cassettes, "openai", "early-eof");
    const { findings, run } = await replayWireScenario({ cassette, replay });
    // The adapter's own events, without the run error it ends the stream in.
    const unended = run.chunks.filter(
      ({ type }) =>
        type !== EventType.RUN_ERROR && type !== EventType.RUN_FINISHED,
    );
    const released = asTestRaw<AnyTextAdapter>({
      kind: "text",
      model: cassette.model,
      name: "released",
      async *chatStream() {
        await Promise.resolve();
        yield* unended;
      },
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of withProviderStreamContract(released).chatStream({
      logger: resolveDebugOption(false),
      messages: [],
      model: cassette.model,
    })) {
      chunks.push(chunk);
    }
    expectContract(
      `${cassetteKey(cassette)}/unended`,
      findWireContractViolations({
        cassette,
        replay: findings,
        run: { ...run, chunks },
      }),
    );
  });
});

describe("a cancelled run rejects cleanly", () => {
  for (const provider of PROVIDER_WIRE_PROVIDERS) {
    test(provider, async () => {
      await checkCancel(provider);
    });
  }
});

// A structured Bedrock request takes the non-streaming path; the run's cancel
// reaches it too. Cancelled before it starts, it never reaches the wire.
test("a cancelled structured Bedrock request never reaches the provider", async () => {
  const model = wireChatModel("bedrock");
  const adapter = createTanStackTextAdapterFactory({
    apiKey: "cassette-replay-no-credentials",
    provider: "bedrock",
  })(model);
  const controller = new AbortController();
  controller.abort();
  const outcome = await adapter
    .structuredOutput({
      chatOptions: {
        logger: resolveDebugOption(false),
        messages: [{ content: "Reply with OK.", role: "user" }],
        model,
        request: { signal: controller.signal },
      },
      outputSchema: {
        properties: { answer: { type: "string" } },
        required: ["answer"],
        type: "object",
      },
    })
    .then(
      () => "answered",
      () => "rejected",
    );
  expect(outcome).toBe("rejected");
  expect(replay.takeFindings().unexpected).toEqual([]);
});
