// Records the provider wire corpus (src/tests/fixtures/provider-wire) from
// the live providers: each recordable scenario's fixed synthetic request goes
// through the real adapter, exactly as the replay test sends it, and what the
// provider answers is written as a `recorded` cassette over the scenario's
// current entry. The recording is then replayed through the adapter and
// checked against the wire contract, and any violation is printed.
//
//   RECORD_OPENAI_API_KEY=... bun run record:provider-cassettes
//   bun run record:provider-cassettes --provider anthropic,google --scenario text
//   bun run record:provider-cassettes --provider mistral --pause-ms 5000
//   bun run record:provider-cassettes --provider openai --model gpt-6-luna
//
// A provider is recorded only when its recording key is set:
// RECORD_OPENAI_API_KEY, RECORD_ANTHROPIC_API_KEY, RECORD_GOOGLE_API_KEY,
// RECORD_MISTRAL_API_KEY, RECORD_OPENROUTER_API_KEY, RECORD_BEDROCK_API_KEY
// (a Bedrock API key, us-east-1). They are separate from the app's own keys,
// so no configured key is ever used by accident. Scenarios no live request
// can produce on demand (rate limits, outages, corrupted or cut-off streams)
// stay synthetic. `--pause-ms` waits between requests, for a key whose
// rate limit a full pass would hit. `--model` records with another of the
// provider's catalog models than its chat default. `tool-call` and `text`
// are always recorded together: the replay tests play them as one
// conversation, on one model.
//
// Nothing but the synthetic prompts is sent. Request bodies and request
// headers are never stored, only the prompt; response headers are kept only
// when an SDK reads them; response and request identifiers are replaced, one
// placeholder per value; a response that contains the key fails the
// recording. Review the diff before committing.

import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { BYOK_MODEL_OPTIONS } from "@stll/ai-catalog";

import { env } from "@/api/env";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import type { OracleViolation } from "@/api/tests/helpers/chat-oracles";
import {
  cassetteKey,
  cassettePath,
  PROVIDER_WIRE_PROVIDERS,
  PROVIDER_WIRE_SCENARIOS,
  providerWireCassetteSchema,
} from "@/api/tests/helpers/provider-wire-cassette";
import type {
  ProviderWireCassette,
  ProviderWireExchange,
  ProviderWireExpectation,
  ProviderWireProvider,
  ProviderWireScenario,
} from "@/api/tests/helpers/provider-wire-cassette";
import {
  EXPECTED_TEXT,
  findWireContractViolations,
  replayWireScenario,
  runWireScenario,
  scenarioPrompt,
  UNKNOWN_MODEL_ID,
  wireChatModel,
} from "@/api/tests/helpers/provider-wire-contract";
import {
  cassetteRequestPath,
  decodeAwsEventStream,
  installProviderWireReplay,
} from "@/api/tests/helpers/provider-wire-replay";
import { matchesUnmetEntry } from "@/api/tests/helpers/provider-wire-unmet";

/** Each provider's recording key and the variable it is read from. */
const recordingKey = (
  provider: ProviderWireProvider,
): { name: string; value: string } => {
  switch (provider) {
    case "anthropic":
      return {
        name: "RECORD_ANTHROPIC_API_KEY",
        value: process.env["RECORD_ANTHROPIC_API_KEY"] ?? "",
      };
    case "bedrock":
      return {
        name: "RECORD_BEDROCK_API_KEY",
        value: process.env["RECORD_BEDROCK_API_KEY"] ?? "",
      };
    case "google":
      return {
        name: "RECORD_GOOGLE_API_KEY",
        value: process.env["RECORD_GOOGLE_API_KEY"] ?? "",
      };
    case "mistral":
      return {
        name: "RECORD_MISTRAL_API_KEY",
        value: process.env["RECORD_MISTRAL_API_KEY"] ?? "",
      };
    case "openai":
      return {
        name: "RECORD_OPENAI_API_KEY",
        value: process.env["RECORD_OPENAI_API_KEY"] ?? "",
      };
    case "openrouter":
      return {
        name: "RECORD_OPENROUTER_API_KEY",
        value: process.env["RECORD_OPENROUTER_API_KEY"] ?? "",
      };
    default: {
      provider satisfies never;
      return panic(`Unhandled provider ${String(provider)}`);
    }
  }
};

const ORIGINS = {
  anthropic: ["https://api.anthropic.com"],
  bedrock: ["https://bedrock-runtime.us-east-1.amazonaws.com"],
  google: ["https://generativelanguage.googleapis.com"],
  mistral: ["https://api.mistral.ai"],
  openai: ["https://api.openai.com"],
  openrouter: ["https://openrouter.ai"],
} as const satisfies Record<ProviderWireProvider, readonly string[]>;

/** Response headers an SDK reads; every other header is dropped. */
const KEPT_RESPONSE_HEADERS = [
  "content-type",
  "retry-after",
  "retry-after-ms",
  "x-amzn-errortype",
  "x-should-retry",
];
/** A scenario makes one request; a retried failure a few more. */
const MAX_REQUESTS_PER_SCENARIO = 4;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Identifier keys whose values are replaced, at any depth: response and
 *  request ids, and the ids of the account the key belongs to. */
const IDENTIFIER_KEYS = new Set([
  "account_id",
  "id",
  "item_id",
  "organization_id",
  "project_id",
  "requestId",
  "request_id",
  "responseId",
  "response_id",
  "system_fingerprint",
  "userId",
  "user_id",
]);
/** Keys whose string values could echo request content. */
const ECHO_KEYS = new Set([
  "instructions",
  "prompt_cache_key",
  "safety_identifier",
  "user",
]);
/** OpenRouter may attach live account pricing and routing to usage. */
const PRIVATE_USAGE_KEYS = new Set(["cost", "cost_details", "is_byok"]);
/** Tool call ids stay: they tie a call to its result in a continuation. */
const TOOL_CALL_ID = /^(?:call|toolu|tooluse|fc)_/u;
/** Ids of the account the key belongs to, wherever a string carries them
 *  (an error message naming the project, say). */
const ACCOUNT_TOKEN =
  /\b(?:org|proj|user)[-_](?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{6,}\b/gu;

/** Refuses anything to be stored that carries the recording key. */
export const refuseSecret = (text: string, secret: string): void => {
  if (secret !== "" && text.includes(secret)) {
    panic("A provider response contains the recording key");
  }
};

/**
 * What one recording redacts: the key it refuses to store, and every
 * identifier it has replaced so far. One real value always gets the same
 * placeholder, whichever key or event carries it, so the references a
 * response makes to its own items still match.
 */
export type Redaction = {
  identifiers: Map<string, string>;
  secret: string;
};

export const newRedaction = (secret: string): Redaction => ({
  identifiers: new Map(),
  secret,
});

const placeholderFor = (redaction: Redaction, value: string): string => {
  const known = redaction.identifiers.get(value);
  if (known !== undefined) {
    return known;
  }
  const placeholder = `[id_${String(redaction.identifiers.size + 1)}]`;
  redaction.identifiers.set(value, placeholder);
  return placeholder;
};

export const sanitizeJson = (value: unknown, redaction: Redaction): unknown => {
  if (Array.isArray(value)) {
    return value.map((child) => sanitizeJson(child, redaction));
  }
  if (typeof value === "string") {
    refuseSecret(value, redaction.secret);
    return value.replaceAll(ACCOUNT_TOKEN, (token) =>
      placeholderFor(redaction, token),
    );
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      if (PRIVATE_USAGE_KEYS.has(key)) {
        return [];
      }
      if (
        IDENTIFIER_KEYS.has(key) &&
        typeof child === "string" &&
        !TOOL_CALL_ID.test(child)
      ) {
        refuseSecret(child, redaction.secret);
        return [[key, placeholderFor(redaction, child)]];
      }
      if (ECHO_KEYS.has(key) && typeof child === "string") {
        return [[key, "[redacted]"]];
      }
      return [[key, sanitizeJson(child, redaction)]];
    }),
  );
};

/** Response, request and account identifiers as providers spell them in
 *  free text. */
const IDENTIFIER_TOKEN =
  /\b(?:chatcmpl|gen|msg|org|proj|req|resp|response|user)[-_](?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{6,}\b/gu;

const parseJson = (text: string): { value: unknown } | undefined => {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
};

/**
 * Text that is not JSON (a cut payload, a plain-text error) keeps its
 * bytes, with any identifier token replaced.
 */
const sanitizeFreeText = (text: string, redaction: Redaction): string => {
  refuseSecret(text, redaction.secret);
  return text.replaceAll(IDENTIFIER_TOKEN, (token) =>
    placeholderFor(redaction, token),
  );
};

/** One JSON document, or free text when it is not one. */
const sanitizeDocument = (text: string, redaction: Redaction): string => {
  refuseSecret(text, redaction.secret);
  const parsed = parseJson(text);
  return parsed === undefined
    ? sanitizeFreeText(text, redaction)
    : JSON.stringify(sanitizeJson(parsed.value, redaction));
};

/** An SSE or JSON body with every payload sanitized, framing kept. */
export const sanitizeTextBody = (
  text: string,
  redaction: Redaction,
): string => {
  refuseSecret(text, redaction.secret);
  if (parseJson(text) !== undefined) {
    return sanitizeDocument(text, redaction);
  }
  return text
    .split(/(\r?\n)/u)
    .map((line) => {
      if (!line.startsWith("data:")) {
        return sanitizeFreeText(line, redaction);
      }
      const data = line.slice("data:".length).trimStart();
      return data === "[DONE]"
        ? line
        : `data: ${sanitizeDocument(data, redaction)}`;
    })
    .join("");
};

/**
 * An event stream frame's payload, whatever its shape: an object, a JSON
 * scalar or array kept as text, or bytes that are not JSON at all.
 */
export const sanitizeEventPayload = (
  payload: string | Record<string, unknown>,
  redaction: Redaction,
): string | Record<string, unknown> => {
  if (typeof payload === "string") {
    return sanitizeDocument(payload, redaction);
  }
  const sanitized = sanitizeJson(payload, redaction);
  return typeof sanitized === "object" &&
    sanitized !== null &&
    !Array.isArray(sanitized)
    ? Object.fromEntries(Object.entries(sanitized))
    : panic("An object payload sanitized to a non-object");
};

export const keptHeaders = (headers: Headers): Record<string, string> =>
  Object.fromEntries(
    KEPT_RESPONSE_HEADERS.flatMap((name) => {
      const value = headers.get(name);
      return value === null ? [] : [[name, value]];
    }),
  );

/** The body, refused as soon as it passes the size limit. */
const readBounded = async (response: Response): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        length += value.byteLength;
        if (length > MAX_RESPONSE_BYTES) {
          return panic("A provider response exceeds the recording size limit");
        }
        chunks.push(value);
      }
    } finally {
      // Stops the producer on every early exit; a no-op after EOF.
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/** A fetch that forwards to the provider and keeps what it answered. */
const installRecorder = ({
  provider,
  secret,
}: {
  provider: ProviderWireProvider;
  secret: string;
}) => {
  const upstream = globalThis.fetch;
  const origins = new Set<string>(ORIGINS[provider]);
  const exchanges: ProviderWireExchange[] = [];
  const redaction = newRedaction(secret);
  /** The first refusal: the SDK sees only a failed fetch, the recording
   *  fails with the reason. */
  const refusal: { error: unknown } = { error: undefined };
  const forward = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request =
      input instanceof Request ? input : new Request(input.toString(), init);
    const url = new URL(request.url);
    if (!origins.has(url.origin)) {
      return panic(`The recorder refuses a request to ${url.origin}`);
    }
    if (exchanges.length >= MAX_REQUESTS_PER_SCENARIO) {
      return panic("The recorder's request limit is reached");
    }
    const response = await upstream(input, { ...init, redirect: "error" });
    const bytes = await readBounded(response);
    // Every stored byte and header, whatever its framing.
    refuseSecret(new TextDecoder().decode(bytes), secret);
    const headers = keptHeaders(response.headers);
    refuseSecret(JSON.stringify(headers), secret);
    const contentType = response.headers.get("content-type") ?? "";
    const body: ProviderWireExchange["response"]["body"] = contentType.includes(
      "vnd.amazon.eventstream",
    )
      ? {
          encoding: "aws-eventstream",
          messages: decodeAwsEventStream(bytes).map((message) => {
            refuseSecret(JSON.stringify(message.headers), secret);
            return {
              headers: message.headers,
              payload: sanitizeEventPayload(message.payload, redaction),
            };
          }),
        }
      : {
          encoding: "text",
          text: sanitizeTextBody(new TextDecoder().decode(bytes), redaction),
        };
    exchanges.push({
      request: { method: "POST", path: cassetteRequestPath(url) },
      response: { body, headers, status: response.status },
    });
    // The SDK reads exactly the bytes that were recorded, already decoded.
    const sdkHeaders = new Headers(response.headers);
    sdkHeaders.delete("content-encoding");
    sdkHeaders.delete("content-length");
    return new Response(bytes, {
      headers: sdkHeaders,
      status: response.status,
    });
  };
  const recorder = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    try {
      return await forward(input, init);
    } catch (error) {
      refusal.error ??= error;
      throw error;
    }
  };
  globalThis.fetch = Object.assign(recorder, {
    preconnect: () => undefined,
  });
  return {
    exchanges,
    refusal,
    restore: () => {
      globalThis.fetch = upstream;
    },
  };
};

/** What a scenario's live answer must read as. */
const expectationFor = (
  scenario: ProviderWireScenario,
  exchanges: readonly ProviderWireExchange[],
): ProviderWireExpectation => {
  const draft = { input: { name: "draft" }, name: "mcp__external__delete" };
  switch (scenario) {
    case "text":
      return { finishReason: "stop", outcome: "finished", text: EXPECTED_TEXT };
    case "tool-call":
    case "strict-null":
      return {
        finishReason: "tool_calls",
        outcome: "finished",
        toolCalls: [draft],
      };
    case "parallel-tool-calls":
      return {
        finishReason: "tool_calls",
        outcome: "finished",
        toolCalls: [draft, { ...draft, input: { name: "memo" } }],
      };
    case "length":
      return { finishReason: "length", outcome: "finished" };
    case "bad-request":
      return {
        errorKind:
          exchanges.at(-1)?.response.status === 404
            ? "model_unavailable"
            : "unknown",
        outcome: "error",
      };
    case "early-eof":
    case "malformed-chunk":
    case "rate-limit":
    case "refusal":
    case "server-error":
    case "text-terminal-only":
      return panic(`${scenario} is not recordable`);
    default: {
      scenario satisfies never;
      return panic(`Unhandled scenario ${String(scenario)}`);
    }
  }
};

/** Whether some tool call streamed arguments that hold a JSON null. */
export const wireCarriesNull = (chunks: readonly StreamChunk[]): boolean => {
  const argumentText = new Map<string, string>();
  for (const chunk of chunks) {
    if (chunk.type === EventType.TOOL_CALL_ARGS) {
      argumentText.set(
        chunk.toolCallId,
        (argumentText.get(chunk.toolCallId) ?? "") + chunk.delta,
      );
    }
  }
  return [...argumentText.values()].some((text) => {
    const parsed = Result.try((): unknown => JSON.parse(text));
    return (
      Result.isOk(parsed) &&
      isJsonRecord(parsed.value) &&
      Object.values(parsed.value).includes(null)
    );
  });
};

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What a recording must show beyond the contract for its scenario to be the
 * one it is named for. A strict-null recording is kept only when the model
 * put a JSON null on the wire: a model that writes the string "null", or
 * leaves the field out, recorded something else.
 */
const scenarioShapeProblems = (
  scenario: ProviderWireScenario,
  chunks: readonly StreamChunk[],
): OracleViolation[] =>
  scenario === "strict-null" && !wireCarriesNull(chunks)
    ? violationsOf(CHAT_ORACLE.providerWireToolInput, [
        { problem: "the recording carries no JSON null on the wire" },
      ])
    : [];

const listArgument = (name: string): string[] | undefined => {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value?.split(",").filter((entry) => entry !== "");
};

/** `--model`, which must be one of the provider's catalog models. */
export const offeredModel = (
  provider: ProviderWireProvider,
  model: string,
): string => {
  const options: readonly string[] = BYOK_MODEL_OPTIONS[provider];
  return options.includes(model)
    ? model
    : panic(`--model ${model} is not one of ${provider}'s models`);
};

/** The model a scenario is recorded with: the rejected request always names
 *  a model no provider serves. */
const recordingModel = ({
  chatModel,
  provider,
  scenario,
}: {
  chatModel: string | undefined;
  provider: ProviderWireProvider;
  scenario: ProviderWireScenario;
}): string => {
  if (scenario === "bad-request") {
    return UNKNOWN_MODEL_ID;
  }
  return chatModel === undefined
    ? wireChatModel(provider)
    : offeredModel(provider, chatModel);
};

export const recordOne = async ({
  chatModel,
  provider,
  scenario,
  secret,
}: {
  /** Records with this model rather than the provider's chat default. */
  chatModel?: string | undefined;
  provider: ProviderWireProvider;
  scenario: ProviderWireScenario;
  secret: string;
}): Promise<ProviderWireCassette> => {
  const model = recordingModel({ chatModel, provider, scenario });
  const recorder = installRecorder({ provider, secret });
  try {
    await runWireScenario({ apiKey: secret, model, provider, scenario });
  } finally {
    recorder.restore();
  }
  const refused = recorder.refusal.error;
  if (refused !== undefined) {
    return panic(
      `The recording was refused: ${refused instanceof Error ? refused.message : "unknown reason"}`,
      refused,
    );
  }
  return v.parse(providerWireCassetteSchema, {
    exchanges: recorder.exchanges,
    expect: expectationFor(scenario, recorder.exchanges),
    format: 1,
    model,
    prompt: scenarioPrompt(provider, scenario),
    provider,
    recordedAt: new Date().toISOString(),
    scenario,
    source: "recorded",
  });
};

const RECORDABLE_SCENARIOS = Object.entries(PROVIDER_WIRE_SCENARIOS)
  .filter(([, scenario]) => scenario.recordable)
  .map(([name]) => name);

/** Scenarios the replay tests play as one conversation, on one model: a tool
 *  call and the text answer that continues it. They are recorded together. */
const RECORDED_TOGETHER: readonly (readonly ProviderWireScenario[])[] = [
  ["text", "tool-call"],
];

/** The recordable scenarios among `requested`, with every scenario recorded
 *  together with one of them, in corpus order. */
export const scenariosToRecord = (
  requested: readonly string[],
): ProviderWireScenario[] => {
  const included = new Set(requested);
  for (const group of RECORDED_TOGETHER) {
    if (group.some((scenario) => included.has(scenario))) {
      for (const scenario of group) {
        included.add(scenario);
      }
    }
  }
  return RECORDABLE_SCENARIOS.filter((name): name is ProviderWireScenario =>
    included.has(name),
  );
};

const main = async (): Promise<number> => {
  env.USE_MOCK_AI = false;
  const providers = (
    listArgument("--provider") ?? PROVIDER_WIRE_PROVIDERS
  ).filter((name): name is ProviderWireProvider =>
    (PROVIDER_WIRE_PROVIDERS as readonly string[]).includes(name),
  );
  const scenarios = scenariosToRecord(
    listArgument("--scenario") ?? RECORDABLE_SCENARIOS,
  );
  const pauseMs = Number(listArgument("--pause-ms")?.at(0) ?? "0");
  if (!Number.isSafeInteger(pauseMs) || pauseMs < 0) {
    return panic("--pause-ms takes a whole number of milliseconds");
  }
  const chatModel = listArgument("--model")?.at(0);
  if (chatModel !== undefined) {
    for (const provider of providers) {
      offeredModel(provider, chatModel);
    }
  }
  let failures = 0;
  let requested = false;
  for (const provider of providers) {
    const { name: keyName, value: secret } = recordingKey(provider);
    if (secret === "") {
      console.log(`${provider}: skipped (${keyName} is not set)`);
      continue;
    }
    for (const scenario of scenarios) {
      const label = `${provider}/${scenario}`;
      if (requested) {
        await Bun.sleep(pauseMs);
      }
      requested = true;
      try {
        const cassette = await recordOne({
          chatModel,
          provider,
          scenario,
          secret,
        });
        const replay = installProviderWireReplay();
        let violations: ReturnType<typeof findWireContractViolations>;
        let accepted: boolean;
        try {
          const { findings, run } = await replayWireScenario({
            cassette,
            replay,
          });
          const contract = findWireContractViolations({
            cassette,
            replay: findings,
            run,
          });
          const shape = scenarioShapeProblems(scenario, run.chunks);
          violations = [...contract, ...shape];
          // A run on the unmet ledger fails at exactly its entry's oracles,
          // as the replay test requires of the corpus entry.
          accepted =
            shape.length === 0 &&
            (contract.length === 0 ||
              matchesUnmetEntry(cassetteKey(cassette), contract));
        } finally {
          replay.restore();
        }
        // A recording the contract rejects stays beside the corpus, outside
        // it, for review; the entry it would replace is left as it is.
        const corpusFile = cassettePath(provider, scenario);
        const file = accepted ? corpusFile : `${corpusFile}.rejected`;
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(cassette, null, 2)}\n`);
        if (!accepted) {
          failures += 1;
        }
        console.log(
          accepted
            ? `${label}: recorded, contract holds${violations.length === 0 ? "" : " up to its unmet entry"}`
            : `${label}: written to ${path.basename(file)}, contract violations ${JSON.stringify(violations)}`,
        );
      } catch {
        // Provider errors can echo request content; keep the output generic.
        failures += 1;
        console.error(`${label}: recording failed`);
      }
    }
  }
  return failures === 0 ? 0 : 1;
};

if (import.meta.main) {
  process.exit(await main());
}
