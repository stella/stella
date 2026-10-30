import { panic } from "better-result";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { isRecord } from "@/api/lib/type-guards";
import { CHAT_ORACLE } from "@/api/tests/helpers/chat-oracles";
import {
  cassetteFor,
  PROVIDER_WIRE_PROVIDERS,
  PROVIDER_WIRE_SCENARIOS,
} from "@/api/tests/helpers/provider-wire-cassette";
import type {
  ProviderWireCassette,
  ProviderWireExchange,
  ProviderWireProvider,
  ProviderWireScenario,
} from "@/api/tests/helpers/provider-wire-cassette";
import { wireRequestShape } from "@/api/tests/helpers/provider-wire-contract";
import { createReplayGate } from "@/api/tests/helpers/provider-wire-gate";
import type { ReplayGate } from "@/api/tests/helpers/provider-wire-gate";
import {
  bodyBytesOf,
  encodeAwsEventStreamMessage,
} from "@/api/tests/helpers/provider-wire-replay";
import type {
  ReplayedRequest,
  TranscriptStep,
} from "@/api/tests/helpers/provider-wire-replay";

// Two-way provider transcripts: a conversation's model calls as the provider
// saw them, in order. Each `expect_outbound` entry is the request the send
// path must make next, normalized (`normalizeOutboundRequest`); each
// `emit_inbound` entry is the answer the provider gives it, taken from the
// provider wire corpus by scenario, with any pause points labelled on its
// frames. The replay refuses a request that differs from the next expected
// one or arrives after the transcript ran out, and a step no request took is
// a finding, so a conversation that sends too much, too little, or something
// else fails at the call that diverged.
//
// The expected requests are what Stella's own request builder sends today
// for these recorded answers; nothing here calls a provider. Regenerate them
// after an intended change with `bun run gen:provider-wire-transcripts` in
// apps/api and review the diff. To re-record an answer against a real
// provider, record its corpus cassette (`bun run record:provider-cassettes`,
// with that provider's recording key), then regenerate the transcripts:
// the transcripts reference the corpus, so the new answer flows into every
// conversation that plays it.

const PROVIDER_WIRE_TRANSCRIPT_DIR = path.resolve(
  import.meta.dir,
  "../fixtures/provider-wire-transcripts",
);

/** Set by `gen:provider-wire-transcripts`: record the outbound side. */
export const TRANSCRIPTS_WRITE_ENV = "PROVIDER_WIRE_TRANSCRIPTS_WRITE";

/**
 * Where an answer can be held, by what the conversation is doing there.
 * `tool-call-open`: right after the first frame that carries a tool call,
 * so the call is on its way and the model's step has not ended.
 * `text-open`: right after the first frame that carries answer text.
 */
const PAUSE_POINTS = ["text-open", "tool-call-open"] as const;
type PausePoint = (typeof PAUSE_POINTS)[number];

const SCENARIO_NAMES = Object.keys(PROVIDER_WIRE_SCENARIOS).filter(
  (name): name is ProviderWireScenario => name in PROVIDER_WIRE_SCENARIOS,
);

const pauseSchema = v.strictObject({
  label: v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/u)),
  at: v.picklist(PAUSE_POINTS),
  /** The answer goes quiet after this frame (0-based): an SSE event or an
   *  event stream message. */
  afterFrame: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const entrySchema = v.variant("type", [
  v.strictObject({
    type: v.literal("expect_outbound"),
    label: v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/u)),
    /** The request, as `normalizeOutboundRequest` reduces it. */
    request: v.unknown(),
  }),
  v.strictObject({
    type: v.literal("emit_inbound"),
    /** The corpus answer: the provider's cassette for this scenario. */
    cassette: v.picklist(SCENARIO_NAMES),
    pauses: v.optional(v.array(pauseSchema)),
  }),
]);

const providerWireTranscriptSchema = v.strictObject({
  format: v.literal(1),
  scenario: v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/u)),
  provider: v.picklist(PROVIDER_WIRE_PROVIDERS),
  model: v.string(),
  entries: v.pipe(v.array(entrySchema), v.minLength(2)),
});

export type ProviderWireTranscript = v.InferOutput<
  typeof providerWireTranscriptSchema
>;
type TranscriptEntry = ProviderWireTranscript["entries"][number];

/** A conversation's model calls, as its scenario declares them: the
 *  transcript's structure, without the requests. */
export type TranscriptPlan = readonly {
  label: string;
  inbound: ProviderWireScenario;
  pauses?: readonly { label: string; at: PausePoint }[];
}[];

export const transcriptPath = (
  scenario: string,
  provider: ProviderWireProvider,
): string =>
  path.join(PROVIDER_WIRE_TRANSCRIPT_DIR, scenario, `${provider}.json`);

/** Every committed transcript file, as `<scenario>/<provider>.json`. */
export const committedTranscriptFiles = (): string[] =>
  existsSync(PROVIDER_WIRE_TRANSCRIPT_DIR)
    ? readdirSync(PROVIDER_WIRE_TRANSCRIPT_DIR).flatMap((scenario) =>
        readdirSync(path.join(PROVIDER_WIRE_TRANSCRIPT_DIR, scenario)).map(
          (file) => `${scenario}/${file}`,
        ),
      )
    : [];

/** `plan` as the transcript records it, for comparing the two. */
const planOf = (transcript: ProviderWireTranscript) =>
  transcript.entries.flatMap((entry, index) => {
    if (entry.type !== "expect_outbound") {
      return [];
    }
    const answer = transcript.entries[index + 1];
    return answer?.type === "emit_inbound"
      ? [
          {
            label: entry.label,
            inbound: answer.cassette,
            ...(answer.pauses === undefined
              ? {}
              : {
                  pauses: answer.pauses.map(({ at, label }) => ({ label, at })),
                }),
          },
        ]
      : [];
  });

/** Problems with a transcript beyond its schema. */
const transcriptProblems = (
  transcript: ProviderWireTranscript,
  cassettes: readonly ProviderWireCassette[],
): string[] => {
  const problems: string[] = [];
  for (const [index, entry] of transcript.entries.entries()) {
    const expected = index % 2 === 0 ? "expect_outbound" : "emit_inbound";
    if (entry.type !== expected) {
      problems.push(
        `entry ${String(index)} is ${entry.type}: every request is followed by its answer`,
      );
    }
    if (entry.type === "emit_inbound") {
      const cassette = cassetteFor(
        cassettes,
        transcript.provider,
        entry.cassette,
      );
      if (cassette.model !== transcript.model) {
        problems.push(
          `entry ${String(index)} answers with ${cassette.model}, not ${transcript.model}`,
        );
      }
      const frames = frameEndsOf(onlyExchange(cassette)).length;
      for (const pause of entry.pauses ?? []) {
        if (pause.afterFrame >= frames) {
          problems.push(
            `pause ${pause.label} is after frame ${String(pause.afterFrame)} of ${String(frames)}`,
          );
        }
      }
    }
  }
  if (transcript.entries.length % 2 !== 0) {
    problems.push("the last request has no answer");
  }
  return problems;
};

/** The transcript of `scenario` for `provider`; panics on a malformed or
 *  stale file. */
export const loadProviderWireTranscript = ({
  cassettes,
  plan,
  provider,
  scenario,
}: {
  cassettes: readonly ProviderWireCassette[];
  plan: TranscriptPlan;
  provider: ProviderWireProvider;
  scenario: string;
}): ProviderWireTranscript => {
  const file = transcriptPath(scenario, provider);
  const parsed = v.safeParse(
    providerWireTranscriptSchema,
    JSON.parse(readFileSync(file, "utf-8")),
  );
  if (!parsed.success) {
    return panic(`${file}: ${v.summarize(parsed.issues)}`);
  }
  const transcript = parsed.output;
  const problems = transcriptProblems(transcript, cassettes);
  if (transcript.scenario !== scenario || transcript.provider !== provider) {
    problems.push(`it records ${transcript.scenario}/${transcript.provider}`);
  }
  if (JSON.stringify(planOf(transcript)) !== JSON.stringify(plan)) {
    problems.push(
      "its model calls are not the ones the scenario declares; regenerate it with `bun run gen:provider-wire-transcripts`",
    );
  }
  if (problems.length > 0) {
    return panic(`${file}:\n${problems.join("\n")}`);
  }
  return transcript;
};

/** A new transcript for `plan`, its requests not yet recorded. */
export const plannedTranscript = ({
  cassettes,
  plan,
  provider,
  scenario,
}: {
  cassettes: readonly ProviderWireCassette[];
  plan: TranscriptPlan;
  provider: ProviderWireProvider;
  scenario: string;
}): ProviderWireTranscript => {
  const model = cassetteFor(
    cassettes,
    provider,
    plan[0]?.inbound ?? panic("A plan makes a model call"),
  ).model;
  return {
    format: 1,
    scenario,
    provider,
    model,
    entries: plan.flatMap(({ inbound, label, pauses }): TranscriptEntry[] => {
      const exchange = onlyExchange(cassetteFor(cassettes, provider, inbound));
      return [
        { type: "expect_outbound", label, request: null },
        {
          type: "emit_inbound",
          cassette: inbound,
          ...(pauses === undefined
            ? {}
            : {
                pauses: pauses.map(({ at, label: pauseLabel }) => ({
                  label: pauseLabel,
                  at,
                  afterFrame: pauseFrameOf(provider, exchange, at),
                })),
              }),
        },
      ];
    }),
  };
};

const onlyExchange = (cassette: ProviderWireCassette): ProviderWireExchange =>
  cassette.exchanges.length === 1
    ? (cassette.exchanges[0] ?? panic("Unreachable"))
    : panic(
        `A transcript answers with one exchange; ${cassette.provider}/${cassette.scenario} has ${String(cassette.exchanges.length)}`,
      );

// --- Frames ------------------------------------------------------------------

/** Each frame of `exchange`'s body, as text, with the byte offset it ends at:
 *  an SSE event (blank-line separated), an event stream message, or the
 *  whole of a JSON body. */
const framesOf = (
  exchange: ProviderWireExchange,
): { end: number; text: string }[] => {
  const { body } = exchange.response;
  if (body.encoding === "aws-eventstream") {
    let end = 0;
    return body.messages.map((message) => {
      end += encodeAwsEventStreamMessage(message).length;
      return { end, text: JSON.stringify(message) };
    });
  }
  const encoder = new TextEncoder();
  const frames: { end: number; text: string }[] = [];
  let start = 0;
  for (const separator of body.text.matchAll(/\r?\n\r?\n/gu)) {
    const stop = separator.index + separator[0].length;
    frames.push({
      end: encoder.encode(body.text.slice(0, stop)).length,
      text: body.text.slice(start, stop),
    });
    start = stop;
  }
  if (start < body.text.length) {
    frames.push({
      end: bodyBytesOf(body).length,
      text: body.text.slice(start),
    });
  }
  return frames;
};

const frameEndsOf = (exchange: ProviderWireExchange): number[] =>
  framesOf(exchange).map(({ end }) => end);

/** Whether a frame of `provider`'s answer carries what `at` waits for. */
const FRAME_CARRIES = {
  "tool-call-open": {
    // Its adapter shows a call once input arrives, not at the block's start.
    anthropic: (text) => /"partial_json":\s*"[^"]/u.test(text),
    bedrock: (text) => /"toolUse"/u.test(text),
    google: (text) => /"functionCall"/u.test(text),
    mistral: (text) => /"tool_calls"/u.test(text),
    openai: (text) =>
      /"type":\s*"response\.output_item\.added"/u.test(text) &&
      /"type":\s*"function_call"/u.test(text),
    openrouter: (text) => /"tool_calls"/u.test(text),
  },
  "text-open": {
    anthropic: (text) => /"type":\s*"text_delta"/u.test(text),
    bedrock: (text) =>
      /"contentBlockDelta"/u.test(text) && /"text"/u.test(text),
    google: (text) => /"text"/u.test(text),
    mistral: (text) => /"content":\s*"[^"]/u.test(text),
    openai: (text) => /"type":\s*"response\.output_text\.delta"/u.test(text),
    openrouter: (text) => /"content":\s*"[^"]/u.test(text),
  },
} as const satisfies Record<
  PausePoint,
  Record<ProviderWireProvider, (text: string) => boolean>
>;

/** The frame an answer pauses after for `at`, when a transcript is
 *  recorded. */
const pauseFrameOf = (
  provider: ProviderWireProvider,
  exchange: ProviderWireExchange,
  at: PausePoint,
): number => {
  const carries: (text: string) => boolean = FRAME_CARRIES[at][provider];
  const index = framesOf(exchange).findIndex(({ text }) => carries(text));
  return index === -1
    ? panic(`No frame of the ${provider} answer reaches ${at}`)
    : index;
};

// --- The outbound normalizer ------------------------------------------------

/**
 * A request as a transcript holds it. Kept verbatim: the path (which names
 * Bedrock's and Gemini's model), the protocol headers
 * (`wireRequestShape`'s, never a credential), and every body field: the
 * model, the messages with their text, tool calls, tool results and
 * reasoning, tool choice, reasoning and output settings, and every cache
 * marker. Reduced, each for a stated reason:
 *
 * - System prompt text becomes `[system prompt]`, block by block, its cache
 *   markers kept: the prompt is held to its own tests
 *   (`chat.provider.prefix-stable`, the chat prompt tests), and carries the
 *   date.
 * - A tool definition becomes its name, with its cache marker if it has one:
 *   which tools are offered, in which order, is this check's business;
 *   their schemas are pinned per adapter by the request-shape and
 *   request-schema checks.
 * - Each identifier (`id`, `call_id`, `tool_call_id`, `tool_use_id`,
 *   `toolUseId`) becomes `[id-N]`, and each signature or encrypted
 *   reasoning blob (`signature`, `thoughtSignature`, `encrypted_content`)
 *   `[signature-N]`, numbered by first appearance in the request: what
 *   matters is which call a result answers, which the numbering keeps,
 *   not the provider's spelling, which changes when a cassette is
 *   recorded again.
 */
export const normalizeOutboundRequest = (
  provider: ProviderWireProvider,
  request: Pick<ReplayedRequest, "body" | "headers" | "path">,
): unknown => {
  const { headers } = wireRequestShape({
    body: request.body,
    headers: request.headers,
    prompt: "",
  });
  const parsed: unknown = JSON.parse(request.body);
  if (!isRecord(parsed)) {
    return panic("A provider request body is a JSON object");
  }
  const placeholders = new Map<string, string>();
  const counts = { id: 0, signature: 0 };
  const placeholder = (kind: "id" | "signature", value: string) => {
    const known = placeholders.get(`${kind}:${value}`);
    if (known !== undefined) {
      return known;
    }
    counts[kind] += 1;
    const made = `[${kind}-${String(counts[kind])}]`;
    placeholders.set(`${kind}:${value}`, made);
    return made;
  };
  const withPlaceholders = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(withPlaceholders);
    }
    if (!isRecord(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (typeof child === "string" && ID_KEYS.has(key)) {
          return [key, placeholder("id", child)];
        }
        if (typeof child === "string" && SIGNATURE_KEYS.has(key)) {
          return [key, placeholder("signature", child)];
        }
        return [key, withPlaceholders(child)];
      }),
    );
  };
  return {
    path: request.path,
    headers,
    body: withPlaceholders(REDUCE_SECTIONS[provider](parsed)),
  };
};

const ID_KEYS: ReadonlySet<string> = new Set([
  "call_id",
  "id",
  "tool_call_id",
  "tool_use_id",
  "toolUseId",
]);
const SIGNATURE_KEYS: ReadonlySet<string> = new Set([
  "encrypted_content",
  "signature",
  "thoughtSignature",
]);

const SYSTEM_PROMPT = "[system prompt]";

/** A text block with its text replaced, everything else (a cache marker)
 *  kept. */
const systemBlock = (block: unknown): unknown =>
  isRecord(block) && typeof block["text"] === "string"
    ? { ...block, text: SYSTEM_PROMPT }
    : block;

const systemContent = (content: unknown): unknown => {
  if (typeof content === "string") {
    return SYSTEM_PROMPT;
  }
  return Array.isArray(content) ? content.map(systemBlock) : content;
};

const listOf = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

/** A tool by its name, with its cache marker when it carries one. */
const toolName = (name: unknown, tool: Record<string, unknown>): unknown =>
  tool["cache_control"] === undefined
    ? name
    : { name, cache_control: tool["cache_control"] };

const chatCompletionsSections = (body: Record<string, unknown>) => ({
  ...body,
  ...("messages" in body
    ? {
        messages: listOf(body["messages"]).map((message) =>
          isRecord(message) && message["role"] === "system"
            ? { ...message, content: systemContent(message["content"]) }
            : message,
        ),
      }
    : {}),
  ...("tools" in body
    ? {
        tools: listOf(body["tools"]).map((tool) =>
          isRecord(tool) && isRecord(tool["function"])
            ? toolName(tool["function"]["name"], tool)
            : tool,
        ),
      }
    : {}),
});

/** Per provider: the body with its system prompt and tool definitions
 *  reduced, every other field as sent. */
const REDUCE_SECTIONS = {
  anthropic: (body) => ({
    ...body,
    ...("system" in body ? { system: systemContent(body["system"]) } : {}),
    ...("tools" in body
      ? {
          tools: listOf(body["tools"]).map((tool) =>
            isRecord(tool) ? toolName(tool["name"], tool) : tool,
          ),
        }
      : {}),
  }),
  bedrock: (body) => ({
    ...body,
    ...("system" in body ? { system: systemContent(body["system"]) } : {}),
    ...(isRecord(body["toolConfig"])
      ? {
          toolConfig: {
            ...body["toolConfig"],
            tools: listOf(body["toolConfig"]["tools"]).map((tool) =>
              isRecord(tool) && isRecord(tool["toolSpec"])
                ? tool["toolSpec"]["name"]
                : tool,
            ),
          },
        }
      : {}),
  }),
  google: (body) => ({
    ...body,
    ...(isRecord(body["systemInstruction"])
      ? {
          systemInstruction: {
            ...body["systemInstruction"],
            parts: systemContent(body["systemInstruction"]["parts"]),
          },
        }
      : {}),
    ...("tools" in body
      ? {
          tools: listOf(body["tools"]).map((tool) =>
            isRecord(tool) && Array.isArray(tool["functionDeclarations"])
              ? {
                  ...tool,
                  functionDeclarations: tool["functionDeclarations"].map(
                    (declaration: unknown) =>
                      isRecord(declaration) ? declaration["name"] : declaration,
                  ),
                }
              : tool,
          ),
        }
      : {}),
  }),
  mistral: chatCompletionsSections,
  openai: (body) => ({
    ...body,
    ...(typeof body["instructions"] === "string"
      ? { instructions: SYSTEM_PROMPT }
      : {}),
    ...("tools" in body
      ? {
          tools: listOf(body["tools"]).map((tool) =>
            isRecord(tool) ? toolName(tool["name"], tool) : tool,
          ),
        }
      : {}),
  }),
  openrouter: chatCompletionsSections,
} as const satisfies Record<
  ProviderWireProvider,
  (body: Record<string, unknown>) => Record<string, unknown>
>;

/** Where `actual` first differs from `expected`, as a JSON path with both
 *  values, key order included. */
const firstDifference = (
  expected: unknown,
  actual: unknown,
  at = "$",
): string | null => {
  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    return null;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      const found = firstDifference(
        expected[index],
        actual[index],
        `${at}[${String(index)}]`,
      );
      if (found !== null) {
        return found;
      }
    }
  }
  if (isRecord(expected) && isRecord(actual)) {
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    for (const key of new Set([...expectedKeys, ...actualKeys])) {
      const found = firstDifference(expected[key], actual[key], `${at}.${key}`);
      if (found !== null) {
        return found;
      }
    }
    if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
      return `${at}: keys ${JSON.stringify(expectedKeys)} expected, got ${JSON.stringify(actualKeys)}`;
    }
  }
  const shown = (value: unknown) =>
    value === undefined ? "(absent)" : JSON.stringify(value);
  return `${at}: expected ${shown(expected)}, got ${shown(actual)}`;
};

// --- Playing a transcript ---------------------------------------------------

/**
 * `transcript` as the replay's steps, with the gate its pause points wait
 * on. In record mode every request is accepted and stored as its step's
 * expected request; otherwise a request that differs is refused, and why is
 * kept in `mismatches`.
 */
export const transcriptSteps = ({
  cassettes,
  record,
  transcript,
}: {
  cassettes: readonly ProviderWireCassette[];
  record: boolean;
  transcript: ProviderWireTranscript;
}): {
  gate: ReplayGate;
  /** Why each refused request was not the expected one. */
  mismatches: string[];
  steps: TranscriptStep[];
} => {
  const labels = transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound"
      ? (entry.pauses ?? []).map(({ label }) => label)
      : [],
  );
  const gate = createReplayGate(labels);
  const mismatches: string[] = [];
  const steps = transcript.entries.flatMap((entry, index) => {
    const answer = transcript.entries[index + 1];
    if (entry.type !== "expect_outbound" || answer?.type !== "emit_inbound") {
      return [];
    }
    const exchange = onlyExchange(
      cassetteFor(cassettes, transcript.provider, answer.cassette),
    );
    const ends = frameEndsOf(exchange);
    return [
      {
        exchange,
        label: entry.label,
        pauses:
          answer.pauses === undefined
            ? undefined
            : {
                gate,
                points: answer.pauses.map(({ afterFrame, label }) => ({
                  atByte: ends[afterFrame] ?? panic("A pause is on a frame"),
                  label,
                })),
              },
        vet: (request: ReplayedRequest) => {
          const actual = normalizeOutboundRequest(transcript.provider, request);
          if (record) {
            entry.request = actual;
            return null;
          }
          const difference = firstDifference(entry.request, actual);
          if (difference === null) {
            return null;
          }
          mismatches.push(`${entry.label}: ${difference}`);
          gate.fail(`The request at ${entry.label} diverged: ${difference}`);
          // The refusal surfaces in the harness's findings: name the oracle.
          return `${CHAT_ORACLE.providerWireOutbound}: ${difference}`;
        },
      },
    ];
  });
  return { gate, mismatches, steps };
};
