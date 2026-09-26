// Records the provider wire corpus (src/tests/fixtures/provider-wire) from
// the live providers: each recordable scenario's fixed synthetic request goes
// through the real adapter, exactly as the replay test sends it, and what the
// provider answers is written as a `recorded` cassette over the scenario's
// current entry. The recording is then replayed through the adapter and
// checked against the wire contract, and any violation is printed.
//
//   RECORD_OPENAI_API_KEY=... bun run record:provider-cassettes
//   bun run record:provider-cassettes --provider anthropic,google --scenario text
//
// A provider is recorded only when its recording key is set:
// RECORD_OPENAI_API_KEY, RECORD_ANTHROPIC_API_KEY, RECORD_GOOGLE_API_KEY,
// RECORD_MISTRAL_API_KEY, RECORD_OPENROUTER_API_KEY, RECORD_BEDROCK_API_KEY
// (a Bedrock API key, us-east-1). They are separate from the app's own keys,
// so no configured key is ever used by accident. Scenarios no live request
// can produce on demand (rate limits, outages, corrupted or cut-off streams)
// stay synthetic.
//
// Nothing but the synthetic prompts is sent. Request bodies and request
// headers are never stored; response headers are kept only when an SDK reads
// them; response and request identifiers are replaced; a response that
// contains the key fails the recording. Review the diff before committing.

import { panic } from "better-result";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { env } from "@/api/env";
import {
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
  findWireContractViolations,
  replayWireScenario,
  runWireScenario,
  UNKNOWN_MODEL_ID,
  wireChatModel,
} from "@/api/tests/helpers/provider-wire-contract";
import {
  cassetteRequestPath,
  decodeAwsEventStream,
  installProviderWireReplay,
} from "@/api/tests/helpers/provider-wire-replay";

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
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Identifier keys whose values are replaced, at any depth. */
const IDENTIFIER_KEYS = new Set([
  "id",
  "requestId",
  "request_id",
  "responseId",
  "response_id",
  "system_fingerprint",
]);
/** Keys whose string values could echo request content. */
const ECHO_KEYS = new Set([
  "instructions",
  "prompt_cache_key",
  "safety_identifier",
  "user",
]);
/** Tool call ids stay: they tie a call to its result in a continuation. */
const TOOL_CALL_ID = /^(?:call|toolu|tooluse|fc)_/u;

export const sanitizeJson = (value: unknown, secret: string): unknown => {
  if (Array.isArray(value)) {
    return value.map((child) => sanitizeJson(child, secret));
  }
  if (typeof value === "string") {
    if (secret !== "" && value.includes(secret)) {
      return panic("A provider response contains the recording key");
    }
    return value;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (
        IDENTIFIER_KEYS.has(key) &&
        typeof child === "string" &&
        !TOOL_CALL_ID.test(child)
      ) {
        return [key, `[${key}]`];
      }
      if (ECHO_KEYS.has(key) && typeof child === "string") {
        return [key, "[redacted]"];
      }
      return [key, sanitizeJson(child, secret)];
    }),
  );
};

/** An SSE or JSON body with every JSON payload sanitized, framing kept. */
export const sanitizeTextBody = (text: string, secret: string): string => {
  if (secret !== "" && text.includes(secret)) {
    return panic("A provider response contains the recording key");
  }
  try {
    return JSON.stringify(sanitizeJson(JSON.parse(text), secret));
  } catch {
    // Not one JSON document: an event stream.
  }
  return text
    .split(/(\r?\n)/u)
    .map((line) => {
      if (!line.startsWith("data:")) {
        return line;
      }
      const data = line.slice("data:".length).trimStart();
      try {
        return `data: ${JSON.stringify(sanitizeJson(JSON.parse(data), secret))}`;
      } catch {
        return line;
      }
    })
    .join("");
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
  for await (const chunk of response.body ?? []) {
    length += chunk.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      return panic("A provider response exceeds the recording size limit");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/** Refuses anything to be stored that carries the recording key. */
export const refuseSecret = (text: string, secret: string): void => {
  if (secret !== "" && text.includes(secret)) {
    panic("A provider response contains the recording key");
  }
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
  const recorder = async (
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
          messages: decodeAwsEventStream(bytes).map((message) => ({
            headers: message.headers,
            payload:
              typeof message.payload === "string"
                ? message.payload
                : Object.fromEntries(
                    Object.entries(sanitizeJson(message.payload, secret) ?? {}),
                  ),
          })),
        }
      : {
          encoding: "text",
          text: sanitizeTextBody(new TextDecoder().decode(bytes), secret),
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
  globalThis.fetch = Object.assign(recorder, {
    preconnect: () => undefined,
  });
  return {
    exchanges,
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
      return { finishReason: "stop", outcome: "finished" };
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

const listArgument = (name: string): string[] | undefined => {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value?.split(",").filter((entry) => entry !== "");
};

export const recordOne = async ({
  provider,
  scenario,
  secret,
}: {
  provider: ProviderWireProvider;
  scenario: ProviderWireScenario;
  secret: string;
}): Promise<ProviderWireCassette> => {
  const model =
    scenario === "bad-request" ? UNKNOWN_MODEL_ID : wireChatModel(provider);
  const recorder = installRecorder({ provider, secret });
  try {
    await runWireScenario({ apiKey: secret, model, provider, scenario });
  } finally {
    recorder.restore();
  }
  return v.parse(providerWireCassetteSchema, {
    exchanges: recorder.exchanges,
    expect: expectationFor(scenario, recorder.exchanges),
    format: 1,
    model,
    provider,
    recordedAt: new Date().toISOString(),
    scenario,
    source: "recorded",
  });
};

const main = async (): Promise<number> => {
  env.USE_MOCK_AI = false;
  const providers = (
    listArgument("--provider") ?? PROVIDER_WIRE_PROVIDERS
  ).filter((name): name is ProviderWireProvider =>
    (PROVIDER_WIRE_PROVIDERS as readonly string[]).includes(name),
  );
  const scenarios = (
    listArgument("--scenario") ?? Object.keys(PROVIDER_WIRE_SCENARIOS)
  ).filter(
    (name): name is ProviderWireScenario =>
      name in PROVIDER_WIRE_SCENARIOS &&
      PROVIDER_WIRE_SCENARIOS[name as ProviderWireScenario].recordable,
  );
  let failures = 0;
  for (const provider of providers) {
    const { name: keyName, value: secret } = recordingKey(provider);
    if (secret === "") {
      console.log(`${provider}: skipped (${keyName} is not set)`);
      continue;
    }
    for (const scenario of scenarios) {
      const label = `${provider}/${scenario}`;
      try {
        const cassette = await recordOne({ provider, scenario, secret });
        const replay = installProviderWireReplay();
        let violations: ReturnType<typeof findWireContractViolations>;
        try {
          const { findings, run } = await replayWireScenario({
            cassette,
            replay,
          });
          violations = findWireContractViolations({
            cassette,
            replay: findings,
            run,
          });
        } finally {
          replay.restore();
        }
        // A recording the contract rejects stays beside the corpus, outside
        // it, for review; the entry it would replace is left as it is.
        const corpusFile = cassettePath(provider, scenario);
        const file =
          violations.length === 0 ? corpusFile : `${corpusFile}.rejected`;
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(cassette, null, 2)}\n`);
        if (violations.length > 0) {
          failures += 1;
        }
        console.log(
          violations.length === 0
            ? `${label}: recorded, contract holds`
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
