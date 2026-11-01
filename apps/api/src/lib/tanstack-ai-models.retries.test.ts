import { EventType } from "@tanstack/ai";
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { TanStackAIProvider } from "@stll/ai-catalog";
import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { isRecord } from "@/api/lib/type-guards";
import { SEAM_DRIVERS } from "@/api/tests/helpers/ai-text-call-sites";
import { cassetteForModel } from "@/api/tests/helpers/provider-request-matrix";
import {
  cassetteFor,
  loadProviderWireCassettes,
  PROVIDER_WIRE_PROVIDERS,
} from "@/api/tests/helpers/provider-wire-cassette";
import type { ProviderWireCassette } from "@/api/tests/helpers/provider-wire-cassette";
import { replayWireScenario } from "@/api/tests/helpers/provider-wire-contract";
import { installProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import type { ProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";

// Model requests are retried by the generation layer alone
// (`provider-retry-policy.ts`): every check it makes before a dispatch then
// sees every send. This census holds each provider client the API builds to
// one request per attempt, through the real model factory and the real
// adapter and SDK, with only `fetch` answered from the provider wire corpus.
// The corpus is keyed by the catalog's provider list, so a provider added
// there is held here before it can serve a request.

const cassettes = loadProviderWireCassettes();
const testState = createTestState({ file: import.meta.path, config: env });

let installed: ProviderWireReplay | undefined;
testState.beforeAll(() => {
  testState.setConfig("USE_MOCK_AI", false);
  // Were a Bedrock request ever to bypass `fetch`, it would go to a host
  // that does not resolve rather than to AWS.
  testState.setEnv(
    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
    "https://bedrock-runtime.us-east-1.amazonaws.com.cassette.invalid",
  );
  // Stainless clients read `retry-after-ms`; 1 ms keeps a waited-out delay
  // short without leaving the hint out.
  installed = installProviderWireReplay({ retryAfterMs: 1 });
});
afterAll(() => {
  installed?.restore();
});

const replay = (): ProviderWireReplay => {
  if (installed === undefined) {
    throw new Error("The replay installs before any test runs");
  }
  return installed;
};

/** Failures every provider SDK retried before Stella turned that off. */
const SDK_RETRIED_SCENARIOS = ["rate-limit", "server-error"] as const;

/** The client builds the Stainless SDKs make their errors through
 *  `makeStatusError`, where the retry hints join the error. */
const HINTED_PROVIDERS: ReadonlySet<TanStackAIProvider> = new Set([
  "anthropic",
  "openai",
]);

const runErrorEvidence = (chunks: readonly unknown[]): unknown => {
  const failure = chunks.find(
    (chunk) => isRecord(chunk) && chunk["type"] === EventType.RUN_ERROR,
  );
  return isRecord(failure) ? failure["rawEvent"] : undefined;
};

describe("each provider client sends a failed request once", () => {
  for (const provider of PROVIDER_WIRE_PROVIDERS) {
    for (const scenario of SDK_RETRIED_SCENARIOS) {
      test(`${provider}: ${scenario}`, async () => {
        // The cassette answers every repeat of the request, so a client
        // that retried would be served and counted here.
        const cassette = cassetteFor(cassettes, provider, scenario);
        const { findings, requests, run } = await replayWireScenario({
          cassette,
          replay: replay(),
        });
        expect(requests).toBe(1);
        expect(findings.unexpected).toEqual([]);
        expect(run.overdue).toBe(false);
        const failed =
          run.thrown !== undefined ||
          run.chunks.some((chunk) => chunk.type === EventType.RUN_ERROR);
        expect(failed).toBe(true);
        if (HINTED_PROVIDERS.has(provider)) {
          // The retry hint survives TanStack's `RUN_ERROR` projection.
          expect(runErrorEvidence(run.chunks)).toMatchObject({
            headers: { "retry-after-ms": "1" },
          });
        }
      });
    }
  }
});

/**
 * The failure each provider's retry is shown with. Google's recorded rate
 * limit asks for twelve seconds, which the layer would wait out; its outage
 * is retried on the same path without the wait.
 */
const LAYER_RETRY_SCENARIO = {
  anthropic: "rate-limit",
  bedrock: "rate-limit",
  google: "server-error",
  mistral: "rate-limit",
  openai: "rate-limit",
  openrouter: "rate-limit",
} as const satisfies Record<
  TanStackAIProvider,
  (typeof SDK_RETRIED_SCENARIOS)[number]
>;

/** The provider's failure once, then its plain answer. */
const failureThenAnswer = (
  provider: TanStackAIProvider,
): ProviderWireCassette => {
  const answer = cassetteFor(cassettes, provider, "text");
  const failure = cassetteForModel(
    cassetteFor(cassettes, provider, LAYER_RETRY_SCENARIO[provider]),
    answer.model,
  );
  const [first] = failure.exchanges;
  if (first === undefined) {
    throw new Error(`${provider}: the failure cassette has an exchange`);
  }
  const { repeat: _repeat, ...once } = first;
  return { ...answer, exchanges: [once, ...answer.exchanges] };
};

describe("the generation layer retries what the clients no longer do", () => {
  for (const provider of PROVIDER_WIRE_PROVIDERS) {
    test(`${provider}: ${LAYER_RETRY_SCENARIO[provider]}, then the answer`, async () => {
      const cassette = failureThenAnswer(provider);
      const served = replay();
      served.serve(cassette);
      const { got, want } =
        await SEAM_DRIVERS["require-complete"].settle(cassette);
      const sent = served.requests().length;
      const findings = served.takeFindings();
      expect(got).toEqual(want);
      // One request per attempt: the failure, then the retry that answered.
      expect(sent).toBe(2);
      expect(findings).toEqual({ unconsumed: [], unexpected: [] });
    });
  }
});

/** The modules that build provider clients; each is held by the census above. */
const CLIENT_OWNERS = new Set([
  "lib/tanstack-ai-models.ts",
  "lib/stella-openrouter-text-adapter.ts",
]);

/** Provider SDKs and the TanStack adapters that build their clients. */
const PROVIDER_PACKAGE =
  /(?:openai|@anthropic-ai\/sdk|@google\/genai|@mistralai\/mistralai|@openrouter\/sdk|@aws-sdk\/client-bedrock-runtime|@tanstack\/ai-(?:openai|anthropic|gemini|mistral|bedrock|openrouter))(?:\/[^"']*)?/u
    .source;

const VALUE_IMPORT = new RegExp(
  String.raw`import\s+(?!type\b)[^;]*?from\s+["']${PROVIDER_PACKAGE}["']`,
  "u",
);
const DYNAMIC_IMPORT = new RegExp(
  String.raw`import\s*\(\s*["']${PROVIDER_PACKAGE}["']\s*\)`,
  "u",
);

const buildsProviderClient = (source: string): boolean =>
  VALUE_IMPORT.test(source) || DYNAMIC_IMPORT.test(source);

describe("provider clients are built only where the census reaches", () => {
  test("no other module imports a provider SDK or adapter at runtime", () => {
    const root = path.resolve(import.meta.dir, "..");
    const outside: string[] = [];
    for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: root })) {
      if (
        CLIENT_OWNERS.has(file) ||
        file.includes(".test.") ||
        file.startsWith("tests/")
      ) {
        continue;
      }
      if (buildsProviderClient(readFileSync(path.join(root, file), "utf-8"))) {
        outside.push(file);
      }
    }
    expect(outside).toEqual([]);
  });

  test("the scan recognises a planted client and leaves type imports alone", () => {
    // Spelled apart so this file holds no import of the packages itself.
    const from = (specifier: string) => `from "${specifier}";`;
    expect(buildsProviderClient(`import OpenAI ${from("openai")}`)).toBe(true);
    expect(
      buildsProviderClient(
        `import { createGeminiChat } ${from("@tanstack/ai-gemini")}`,
      ),
    ).toBe(true);
    expect(
      buildsProviderClient(`await import("@aws-sdk/client-bedrock-runtime")`),
    ).toBe(true);
    expect(
      buildsProviderClient(
        `import type { AnthropicTextMetadata } ${from("@tanstack/ai-anthropic")}`,
      ),
    ).toBe(false);
  });
});
