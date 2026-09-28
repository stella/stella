import { EventType } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { env } from "@/api/env";
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
  findWireCancelViolations,
  findWireContractViolations,
  findWireSplitViolations,
  replayWireScenario,
  wireChatModel,
  withMultibyteText,
} from "@/api/tests/helpers/provider-wire-contract";
import {
  bodyBytesOf,
  installProviderWireReplay,
} from "@/api/tests/helpers/provider-wire-replay";
import type {
  Chunking,
  ProviderWireReplay,
} from "@/api/tests/helpers/provider-wire-replay";
import {
  UNMET,
  UNMET_SIZE,
  violatedOracles,
} from "@/api/tests/helpers/provider-wire-unmet";

// Every provider adapter against the provider wire corpus
// (`src/tests/fixtures/provider-wire`): the real adapter, its real SDK and
// our model resolution, with only `fetch` answered from a cassette. Each
// cassette's normalized events must satisfy one contract, whichever
// provider produced them.

const cassettes = loadProviderWireCassettes();

const { providerWireToolInput: toolInput } = CHAT_ORACLE;

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

// The same cassettes with their bodies cut into reads anywhere: a one-byte
// read at every offset, and seeded random cuts. Answer text and tool
// arguments are spelled in multi-byte characters first, so the cuts land
// inside characters as well as inside `data:` lines, CRLFs and event frames.

/** Each body in one read: the run every split run must equal. */
const WHOLE: Chunking = { at: [] };
/** Fixed, so a failure reproduces; fast-check prints the cuts it shrank to. */
const SPLIT_SEED = 20_260_927;
const SPLIT_RUNS = 4;

/** Cassettes whose answer is a stream, read in pieces by the adapter. */
const streamed = cassettes.filter(
  ({ exchanges }) => exchanges[0]?.response.status === 200,
);

const firstBodyOf = (cassette: ProviderWireCassette): Uint8Array => {
  const [first] = cassette.exchanges;
  if (first === undefined) {
    return panic(`${cassetteKey(cassette)} has no exchange`);
  }
  return bodyBytesOf(first.response.body);
};

const ASCII_MAX = 0x7f;

/** Whether the first body's text (an event stream's payloads, not its
 *  binary framing) holds a character outside ASCII. */
const hasMultibyte = (cassette: ProviderWireCassette): boolean => {
  const body = cassette.exchanges[0]?.response.body;
  const text =
    body?.encoding === "aws-eventstream"
      ? JSON.stringify(body.messages.map(({ payload }) => payload))
      : (body?.text ?? "");
  return Array.from(text).some(
    (character) => (character.codePointAt(0) ?? 0) > ASCII_MAX,
  );
};

const CR = 0x0d;
const LF = 0x0a;
const hasCrlf = (bytes: Uint8Array): boolean =>
  bytes.some((byte, index) => byte === CR && bytes[index + 1] === LF);

const checkSplit = async (cassette: ProviderWireCassette) => {
  const multibyte = withMultibyteText(cassette);
  const { run: whole } = await replayWireScenario({
    cassette: multibyte,
    chunking: WHOLE,
    replay,
  });
  const expectSame = async (chunking: Chunking) => {
    const { run: split } = await replayWireScenario({
      cassette: multibyte,
      chunking,
      replay,
    });
    const violations = findWireSplitViolations({ chunking, split, whole });
    if (violations.length > 0) {
      panic(`A split read changes the run: ${JSON.stringify(violations)}`);
    }
  };
  await expectSame({ every: 1 });
  const length = firstBodyOf(multibyte).length;
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: Math.max(1, length - 1) }), {
        minLength: 1,
        maxLength: 48,
      }),
      async (at) => {
        await expectSame({ at });
      },
    ),
    propertyConfig({ numRuns: SPLIT_RUNS, seed: SPLIT_SEED }),
  );
};

describe("every adapter reads a stream cut anywhere as it reads it whole", () => {
  test("the cuts reach multi-byte text, multi-byte tool arguments and a CRLF", () => {
    // Providers whose cassette the rewrite turns from ASCII to multi-byte.
    const rewritten = (scenario: "text" | "tool-call") =>
      PROVIDER_WIRE_PROVIDERS.filter((provider) => {
        const cassette = cassetteFor(cassettes, provider, scenario);
        return (
          !hasMultibyte(cassette) && hasMultibyte(withMultibyteText(cassette))
        );
      });
    expect(rewritten("text")).toEqual([...PROVIDER_WIRE_PROVIDERS]);
    // Most providers stream arguments in fragments that split the word.
    expect(rewritten("tool-call")).toContain("google");
    expect(streamed.some((cassette) => hasCrlf(firstBodyOf(cassette)))).toBe(
      true,
    );
  });

  for (const cassette of streamed) {
    test(
      cassetteKey(cassette).replace("/", " "),
      async () => {
        await checkSplit(cassette);
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
