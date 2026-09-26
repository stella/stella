import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { CHAT_ORACLE } from "@/api/tests/helpers/chat-oracles";
import type {
  ChatOracleId,
  OracleViolation,
} from "@/api/tests/helpers/chat-oracles";
import {
  cassetteFor,
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
  providerWireCancel: cancel,
  providerWireError: error,
  providerWireFinish: finish,
  providerWireOneTerminal: oneTerminal,
  providerWireToolInput: toolInput,
} = CHAT_ORACLE;

/**
 * Runs that do not meet the contract yet, with the oracles they fail at.
 * Each must still fail at exactly these, so a change that meets the
 * contract, or misses it another way, fails here until its entry is updated.
 */
const UNMET: Readonly<Record<string, readonly ChatOracleId[]>> = {
  "anthropic/early-eof": [finish, oneTerminal],
  "anthropic/length": [finish],
  "anthropic/refusal": [finish],
  "anthropic/strict-null": [toolInput],
  "bedrock/cancel": [cancel],
  "bedrock/early-eof": [finish],
  "bedrock/parallel-tool-calls": [toolInput],
  "bedrock/rate-limit": [error],
  "bedrock/server-error": [error],
  "bedrock/strict-null": [toolInput],
  "bedrock/tool-call": [toolInput],
  "google/cancel": [cancel],
  "google/early-eof": [finish, oneTerminal],
  "google/length": [finish, oneTerminal],
  "google/refusal": [finish],
  "google/strict-null": [toolInput],
  "mistral/bad-request": [oneTerminal],
  "mistral/cancel": [cancel],
  "mistral/early-eof": [finish],
  "mistral/malformed-chunk": [finish],
  "mistral/rate-limit": [error, oneTerminal],
  "mistral/server-error": [error, oneTerminal],
  "openai/bad-request": [error],
  "openai/early-eof": [finish],
  "openai/length": [finish],
  "openai/rate-limit": [error],
  "openrouter/early-eof": [finish],
  "openrouter/server-error": [error, oneTerminal],
  "openrouter/strict-null": [toolInput],
};

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
  expect(
    [...new Set(violations.map(({ oracle }) => oracle))].toSorted(),
  ).toEqual(unmet.toSorted());
};

const checkCassette = async (cassette: ProviderWireCassette) => {
  const { findings, run } = await replayWireScenario({ cassette, replay });
  expectContract(
    `${cassette.provider}/${cassette.scenario}`,
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
      cassettes.flatMap(({ provider, scenario }) => [
        `${provider}/${scenario}`,
        `${provider}/cancel`,
      ]),
    );
    expect(Object.keys(UNMET).filter((key) => !keys.has(key))).toEqual([]);
  });
});

describe("every adapter satisfies the wire contract", () => {
  for (const cassette of cassettes) {
    test(
      `${cassette.provider} ${cassette.scenario}`,
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
