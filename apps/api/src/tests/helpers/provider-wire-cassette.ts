import { panic } from "better-result";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";
import type { TanStackAIProvider } from "@stll/ai-catalog";
import { AI_ERROR_KINDS } from "@stll/api-contract";

// Provider wire cassettes: what a provider's HTTP API answered one of a
// fixed set of synthetic requests, byte for byte, with what the adapter must
// make of it. `provider-wire-replay.ts` serves them to the real adapters
// through `fetch`, and `provider-wire-contract.ts` holds the adapters'
// normalized events to one contract.
//
// A cassette is `recorded` (captured by `bun run record:provider-cassettes`)
// or `synthetic` (written from the provider's documented stream format, for
// the scenarios no live request can produce on demand: rate limits, outages,
// corrupted and cut-off streams). A recording replaces the synthetic entry
// for its scenario.

export const PROVIDER_WIRE_DIR = path.resolve(
  import.meta.dir,
  "../fixtures/provider-wire",
);

export const PROVIDER_WIRE_PROVIDERS = TANSTACK_AI_PROVIDERS;
export type ProviderWireProvider = TanStackAIProvider;

/** The one tool every synthetic request offers the model. */
export const WIRE_TOOL_NAME = "mcp__external__delete";

/**
 * Every scenario a provider's corpus holds. `recordable` scenarios have a
 * live request that produces them; the rest stay synthetic.
 */
export const PROVIDER_WIRE_SCENARIOS = {
  /** A plain text answer. */
  text: { outcome: "finished", recordable: true },
  /** A text answer whose text arrives only in the stream's terminal event. */
  "text-terminal-only": { outcome: "finished", recordable: false },
  /** One call of the wire tool. */
  "tool-call": { outcome: "finished", recordable: true },
  /** Two calls of the wire tool in one response. */
  "parallel-tool-calls": { outcome: "finished", recordable: true },
  /** A call whose optional field arrives as `null`. */
  "strict-null": { outcome: "finished", recordable: true },
  /** A text answer cut off at the output limit. */
  length: { outcome: "finished", recordable: true },
  /** The provider declines to answer. */
  refusal: { outcome: "either", recordable: false },
  /** A request the provider rejects (4xx). */
  "bad-request": { outcome: "error", recordable: true },
  /** HTTP 429. */
  "rate-limit": { outcome: "error", recordable: false },
  /** HTTP 5xx, on every attempt. */
  "server-error": { outcome: "error", recordable: false },
  /** A stream with an unparseable event in it. */
  "malformed-chunk": { outcome: "error", recordable: false },
  /** A stream that stops before its terminal event. */
  "early-eof": { outcome: "either", recordable: false },
} as const satisfies Record<
  string,
  { outcome: "either" | "error" | "finished"; recordable: boolean }
>;

export type ProviderWireScenario = keyof typeof PROVIDER_WIRE_SCENARIOS;

const SCENARIO_NAMES = Object.keys(PROVIDER_WIRE_SCENARIOS).filter(
  (name): name is ProviderWireScenario => name in PROVIDER_WIRE_SCENARIOS,
);

/**
 * Scenarios a provider's protocol cannot produce. Every other scenario must
 * have a cassette for every provider (`findMissingCassettes`).
 */
export const NOT_APPLICABLE: Partial<
  Record<ProviderWireProvider, Partial<Record<ProviderWireScenario, string>>>
> = {
  anthropic: {
    "text-terminal-only":
      "Messages streams carry text only in content_block_delta events.",
  },
  bedrock: {
    "text-terminal-only":
      "Converse streams carry text only in contentBlockDelta events.",
  },
  google: {
    "text-terminal-only":
      "Every streamGenerateContent chunk is a complete candidate delta.",
  },
  mistral: {
    "text-terminal-only":
      "Chat completion chunks carry text only in choice deltas.",
    refusal: "Mistral chat completions have no refusal or filter finish.",
  },
  openrouter: {
    "text-terminal-only":
      "Chat completion chunks carry text only in choice deltas.",
  },
};

const headersSchema = v.record(v.string(), v.string());

const awsEventStreamMessageSchema = v.strictObject({
  headers: headersSchema,
  /** A JSON payload, or the literal bytes of a payload that is not JSON. */
  payload: v.union([v.string(), v.record(v.string(), v.unknown())]),
});

export type AwsEventStreamMessage = v.InferOutput<
  typeof awsEventStreamMessageSchema
>;

const bodySchema = v.variant("encoding", [
  /** The body as text: an SSE stream or a JSON document. */
  v.strictObject({ encoding: v.literal("text"), text: v.string() }),
  /** The binary `application/vnd.amazon.eventstream` framing, one entry
   *  per frame. */
  v.strictObject({
    encoding: v.literal("aws-eventstream"),
    messages: v.array(awsEventStreamMessageSchema),
  }),
]);

const exchangeSchema = v.strictObject({
  request: v.strictObject({
    method: v.literal("POST"),
    /** Path and query, without credentials. */
    path: v.string(),
  }),
  response: v.strictObject({
    status: v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599)),
    headers: headersSchema,
    body: bodySchema,
    /** `reset`: the connection fails once the body is sent, as a dropped
     *  socket does. */
    ending: v.optional(v.picklist(["complete", "reset"])),
  }),
  /** Served to every retry of this request, as a persistent failure is. */
  repeat: v.optional(v.boolean()),
});

export type ProviderWireExchange = v.InferOutput<typeof exchangeSchema>;

const FINISH_REASONS = ["content_filter", "length", "stop", "tool_calls"];

const usageSchema = v.strictObject({
  completionTokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
  promptTokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
  totalTokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const expectSchema = v.variant("outcome", [
  v.strictObject({
    outcome: v.literal("finished"),
    finishReason: v.picklist(FINISH_REASONS),
    /** The exact text; a recording that cannot know it leaves it out, and
     *  the text must then be non-empty. */
    text: v.optional(v.string()),
    toolCalls: v.optional(
      v.array(v.strictObject({ name: v.string(), input: v.unknown() })),
    ),
    usage: v.optional(usageSchema),
  }),
  v.strictObject({
    outcome: v.literal("error"),
    errorKind: v.picklist(AI_ERROR_KINDS),
  }),
]);

export type ProviderWireExpectation = v.InferOutput<typeof expectSchema>;

export const providerWireCassetteSchema = v.strictObject({
  format: v.literal(1),
  provider: v.picklist(PROVIDER_WIRE_PROVIDERS),
  scenario: v.picklist(SCENARIO_NAMES),
  /** A further shape of the same scenario, beside its main cassette. */
  variant: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/u))),
  source: v.picklist(["recorded", "synthetic"]),
  /** Where a synthetic cassette's bytes come from. */
  basis: v.optional(v.string()),
  recordedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  /** The model the request named. */
  model: v.string(),
  exchanges: v.pipe(v.array(exchangeSchema), v.minLength(1)),
  expect: expectSchema,
});

export type ProviderWireCassette = v.InferOutput<
  typeof providerWireCassetteSchema
>;

export const cassettePath = (
  provider: ProviderWireProvider,
  scenario: ProviderWireScenario,
  variant?: string,
): string =>
  path.join(
    PROVIDER_WIRE_DIR,
    provider,
    `${scenario}${variant === undefined ? "" : `.${variant}`}.json`,
  );

/** A cassette's name: provider, scenario and any variant. */
export const cassetteKey = ({
  provider,
  scenario,
  variant,
}: Pick<ProviderWireCassette, "provider" | "scenario" | "variant">): string =>
  `${provider}/${scenario}${variant === undefined ? "" : `.${variant}`}`;

/** Problems with one cassette file, beyond its schema. */
const cassetteProblems = (
  file: string,
  cassette: ProviderWireCassette,
): string[] => {
  const problems: string[] = [];
  const expected = cassettePath(
    cassette.provider,
    cassette.scenario,
    cassette.variant,
  );
  if (path.resolve(file) !== expected) {
    problems.push(`${file}: lives at ${expected} by its provider and scenario`);
  }
  if (cassette.source === "synthetic" && (cassette.basis ?? "") === "") {
    problems.push(`${file}: a synthetic cassette names its basis`);
  }
  if (cassette.source === "recorded" && cassette.recordedAt === undefined) {
    problems.push(`${file}: a recording carries its recordedAt`);
  }
  const { outcome } = PROVIDER_WIRE_SCENARIOS[cassette.scenario];
  if (outcome !== "either" && outcome !== cassette.expect.outcome) {
    problems.push(
      `${file}: a ${cassette.scenario} cassette expects a ${outcome} outcome`,
    );
  }
  return problems;
};

/** Every cassette in the corpus, parsed; panics on a malformed file. */
export const loadProviderWireCassettes = (): ProviderWireCassette[] => {
  const cassettes: ProviderWireCassette[] = [];
  const problems: string[] = [];
  for (const provider of readdirSync(PROVIDER_WIRE_DIR)) {
    const directory = path.join(PROVIDER_WIRE_DIR, provider);
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const file = path.join(directory, name);
      const parsed = v.safeParse(
        providerWireCassetteSchema,
        JSON.parse(readFileSync(file, "utf-8")),
      );
      if (!parsed.success) {
        problems.push(`${file}: ${v.summarize(parsed.issues)}`);
        continue;
      }
      problems.push(...cassetteProblems(file, parsed.output));
      cassettes.push(parsed.output);
    }
  }
  if (problems.length > 0) {
    return panic(`Invalid provider wire cassettes:\n${problems.join("\n")}`);
  }
  return cassettes;
};

/** Every provider × scenario pair that needs a cassette and has none. */
export const findMissingCassettes = (
  cassettes: readonly ProviderWireCassette[],
): string[] => {
  // A variant sits beside its main cassette; it does not stand in for one.
  const present = new Set(
    cassettes
      .filter(({ variant }) => variant === undefined)
      .map(({ provider, scenario }) => `${provider}/${scenario}`),
  );
  return PROVIDER_WIRE_PROVIDERS.flatMap((provider) =>
    SCENARIO_NAMES.filter(
      (scenario) =>
        NOT_APPLICABLE[provider]?.[scenario] === undefined &&
        !present.has(`${provider}/${scenario}`),
    ).map((scenario) => `${provider}/${scenario}`),
  );
};

/** The corpus entry for one pair; panics when it is missing. */
export const cassetteFor = (
  cassettes: readonly ProviderWireCassette[],
  provider: ProviderWireProvider,
  scenario: ProviderWireScenario,
): ProviderWireCassette =>
  cassettes.find(
    (cassette) =>
      cassette.provider === provider &&
      cassette.scenario === scenario &&
      cassette.variant === undefined,
  ) ?? panic(`No ${provider}/${scenario} provider wire cassette`);
