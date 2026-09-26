import { EventType } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { createTanStackTextAdapterFactory } from "@/api/lib/tanstack-ai-models";
import { CHAT_ORACLE } from "@/api/tests/helpers/chat-oracles";
import type {
  ChatOracleId,
  OracleViolation,
} from "@/api/tests/helpers/chat-oracles";
import {
  cassetteFor,
  cassetteKey,
  findMissingCassettes,
  loadProviderWireCassettes,
  PROVIDER_WIRE_PROVIDERS,
} from "@/api/tests/helpers/provider-wire-cassette";
import type {
  ProviderWireCassette,
  ProviderWireProvider,
} from "@/api/tests/helpers/provider-wire-cassette";
import {
  findWireCancelViolations,
  findWireContractViolations,
  replayWireScenario,
  wireChatModel,
} from "@/api/tests/helpers/provider-wire-contract";
import { installProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import type { ProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";

// Every provider adapter against the provider wire corpus
// (`src/tests/fixtures/provider-wire`): the real adapter, its real SDK and
// our model resolution, with only `fetch` answered from a cassette. Each
// cassette's normalized events must satisfy one contract, whichever
// provider produced them.

const cassettes = loadProviderWireCassettes();

const {
  providerWireFinish: finish,
  providerWireToolInput: toolInput,
  providerWireUsage: usage,
} = CHAT_ORACLE;

/** Why an unmet run is on the ledger. */
type UnmetEntry = { oracles: readonly ChatOracleId[]; reason: string };

/**
 * Runs that do not meet the contract yet, with the oracles they fail at.
 * The ledger only shrinks: each entry must still fail at exactly its
 * oracles, an entry whose run now meets the contract fails until it is
 * removed, and its size is pinned to UNMET_SIZE, which only goes down.
 */
const UNMET: Readonly<Record<string, UnmetEntry>> = {
  "anthropic/length": { oracles: [usage], reason: "maintenance" },
  "anthropic/refusal": { oracles: [finish], reason: "maintenance" },
  "bedrock/early-eof": { oracles: [finish], reason: "maintenance" },
  "mistral/early-eof": { oracles: [finish], reason: "maintenance" },
  "mistral/malformed-chunk": { oracles: [finish], reason: "maintenance" },
  "openai/length": { oracles: [usage], reason: "maintenance" },
  "openrouter/early-eof": { oracles: [finish], reason: "maintenance" },
};

/** The ledger's size. Lower it with every entry removed; never raise it. */
const UNMET_SIZE = 7;

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
  expect(
    [...new Set(violations.map(({ oracle }) => oracle))].toSorted(),
  ).toEqual(unmet.oracles.toSorted());
};

const checkCassette = async (cassette: ProviderWireCassette) => {
  const { findings, run } = await replayWireScenario({ cassette, replay });
  expectContract(
    cassetteKey(cassette),
    findWireContractViolations({ cassette, replay: findings, run }),
  );
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
