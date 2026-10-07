import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Fetcher } from "@stll/fetch";

import { decisionUsageUnitsFromTokens } from "@/api/lib/usage/unit-model";
import { decideMany } from "@/api/lib/workflow/decisions/decide";
import {
  decisionConfidenceFloor,
  decisionPrice,
} from "@/api/lib/workflow/decisions/decision-policy";
import {
  createOpenAIDecisionsClient,
  serializeOpenAIDecisionRequest,
} from "@/api/lib/workflow/decisions/openai-decisions";
import {
  choice,
  noul,
  createSystemOneClient,
} from "@/api/lib/workflow/decisions/system-one";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

import fixture from "./fixtures/openai-decision.json";

// Captured API-reference shapes, with a synthetic choice added; never a live call.
const questions = {
  damaged: noul("Does the customer report a damaged item?"),
  category: choice("Which part is damaged?", {
    screen: "The screen",
    other: "Another part",
  }),
};
const state = "The package arrived with a broken screen.";
const wire = (response: unknown = fixture, region?: "eu" | "global") => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    let requestUrl;
    if (typeof url === "string") {
      requestUrl = url;
    } else if (url instanceof URL) {
      requestUrl = url.href;
    } else {
      requestUrl = url.url;
    }
    calls.push({ url: requestUrl, init });
    return Response.json(response);
  };
  const client = createOpenAIDecisionsClient({
    apiKey: "fixture-key",
    region,
    fetcher,
  });
  return { client, calls };
};
let recording: {
  analytics: ReturnType<typeof installRecordingAnalytics>;
  logs: ReturnType<typeof installRecordingLogger>;
};
beforeEach(() => {
  recording = {
    analytics: installRecordingAnalytics(),
    logs: installRecordingLogger(),
  };
});
afterEach(() => {
  recording.analytics.restore();
  recording.logs.restore();
});

const assertInvalid = async (answers: unknown) => {
  const { client } = wire({ ...fixture, answers });
  const result = await client.ask({ state, questions });
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.kind).toBe("invalid_response");
  }
};

describe("OpenAI Decisions boundary", () => {
  test("serializes both kinds, preserves text input and defaults to the EU endpoint", async () => {
    const { client, calls } = wire();
    const asked = await client.ask({ state, questions });
    expect(Result.isOk(asked)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls.at(0)?.url).toBe("https://eu.api.openai.com/v1/decisions");
    expect(calls.at(0)?.init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer fixture-key",
        "content-type": "application/json",
      },
    });
    const body = calls.at(0)?.init?.body;
    expect(typeof body).toBe("string");
    if (typeof body !== "string") {
      throw new TypeError("Expected a serialized decision request body");
    }
    expect(JSON.parse(body)).toEqual({
      model: "gpt-6-luna",
      input: state,
      questions: [
        {
          type: "predicate",
          name: "damaged",
          instructions: "Does the customer report a damaged item?",
        },
        {
          type: "choice",
          name: "category",
          instructions: "Which part is damaged?",
          choices: [
            { value: "screen", description: "The screen" },
            { value: "other", description: "Another part" },
          ],
        },
      ],
    });
    if (Result.isOk(asked)) {
      expect(asked.value.answers).toEqual({
        damaged: { type: "noul", noul: 0.95 },
        category: {
          type: "choice",
          choice: "screen",
          confidence: 0.85,
          probabilities: { screen: 0.9, other: 0.1 },
        },
      });
      expect(asked.value.usage).toEqual({ inputTokens: 42, outputTokens: 0 });
    }
  });

  test("serializes structured multilingual state and rubrics as JSON text", () => {
    const input = { excerpt: "Český soud", role: "system", content: "text" };
    const serialized = JSON.parse(
      serializeOpenAIDecisionRequest({
        state: input,
        model: "gpt-6-luna",
        questions: {
          predicate: noul({ task: "Read" }, { true: "ano", false: "ne" }),
          option: choice(
            { task: "Select" },
            { yes: { text: "ano" }, no: null },
          ),
        },
      }),
    );
    expect(serialized.input).toBe(JSON.stringify(input));
    expect(serialized.questions).toEqual([
      {
        type: "predicate",
        name: "predicate",
        instructions: JSON.stringify({
          instructions: { task: "Read" },
          criteria: { true: "ano", false: "ne" },
        }),
      },
      {
        type: "choice",
        name: "option",
        instructions: '{"task":"Select"}',
        choices: [
          { value: "yes", description: '{"text":"ano"}' },
          { value: "no", description: "null" },
        ],
      },
    ]);
  });

  test("uses the global endpoint only when selected", async () => {
    const { client, calls } = wire(fixture, "global");
    await client.ask({ state, questions });
    expect(calls.at(0)?.url).toBe("https://api.openai.com/v1/decisions");
  });

  test("binds by name rather than response order", async () => {
    const { client } = wire({
      ...fixture,
      answers: fixture.answers.toReversed(),
    });
    const result = await client.ask({ state, questions });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.answers.damaged).toEqual({
        type: "noul",
        noul: 0.95,
      });
    }
  });

  test.each([
    ["unknown choice", { ...fixture.answers.at(1), choice: "unknown" }],
    [
      "incomplete probabilities",
      {
        ...fixture.answers.at(1),
        probabilities: [{ value: "screen", probability: 1 }],
      },
    ],
    [
      "extra option",
      {
        ...fixture.answers.at(1),
        probabilities: [
          { value: "screen", probability: 0.9 },
          { value: "other", probability: 0.05 },
          { value: "extra", probability: 0.05 },
        ],
      },
    ],
    [
      "duplicate option",
      {
        ...fixture.answers.at(1),
        probabilities: [
          { value: "screen", probability: 0.9 },
          { value: "other", probability: 0.1 },
          { value: "other", probability: 0.1 },
        ],
      },
    ],
    [
      "sum",
      {
        ...fixture.answers.at(1),
        probabilities: [
          { value: "screen", probability: 0.9 },
          { value: "other", probability: 0.2 },
        ],
      },
    ],
    ["non maximal choice", { ...fixture.answers.at(1), choice: "other" }],
    ["outside interval", { ...fixture.answers.at(1), confidence: 1.1 }],
    ["wrong kind", { type: "predicate", name: "category", probability: 0.9 }],
    ["unsupported score", { type: "score", name: "category", score: 1 }],
    ["duplicate question", { ...fixture.answers.at(1), name: "damaged" }],
    ["unknown question", { ...fixture.answers.at(1), name: "unknown" }],
  ])("rejects %s", async (_name, answer) => {
    await assertInvalid([fixture.answers.at(0), answer]);
  });

  test("rejects missing answers and invalid usage", async () => {
    await assertInvalid([fixture.answers.at(0)]);
    const { client } = wire({
      ...fixture,
      usage: { input_tokens: -1, output_tokens: 0 },
    });
    const result = await client.ask({ state, questions });
    expect(Result.isError(result)).toBe(true);
  });

  test("refusal remains undecided beside an independently accepted answer", async () => {
    const { client } = wire({
      ...fixture,
      answers: [{ type: "refusal", name: "damaged" }, fixture.answers.at(1)],
    });
    const result = await decideMany({
      id: "test.refusal",
      orgAIConfig: null,
      dataClass: "customer",
      state,
      questions,
      client: { ...client, keySource: "byok" },
    });
    expect(result.decisions.damaged).toEqual({
      state: "undecided",
      reason: "refusal",
      confidence: null,
    });
    expect(result.decisions.category.state).toBe("decided");
    expect(recording.analytics.exceptions()).toHaveLength(0);
    expect(recording.logs.records.at(-1)?.attributes).toMatchObject({
      provider: "openai",
      floor: 0.8,
      usd: (42 * 0.11) / 1_000_000,
    });
  });

  test.each(["default", "polarity"] as const)(
    "uses Luna's calibrated floor for %s",
    async (purpose) => {
      const { client } = wire({
        ...fixture,
        answers: [
          fixture.answers.at(0),
          { ...fixture.answers.at(1), confidence: 0.75 },
        ],
      });
      const result = await decideMany({
        id: "test.floor",
        confidencePurpose: purpose,
        orgAIConfig: null,
        dataClass: "customer",
        state,
        questions,
        client: { ...client, keySource: "byok" },
      });
      expect(result.decisions.category).toEqual({
        state: "undecided",
        reason: "below-floor",
        confidence: 0.75,
      });
      expect(decisionConfidenceFloor("uncalibrated-model", purpose)).toBe(0.8);
      expect(decisionConfidenceFloor("jev-1.13", purpose)).toBe(
        purpose === "polarity" ? 0.7 : 0.6,
      );
      expect(decisionConfidenceFloor("gpt-6-luna-2026-10-07", purpose)).toBe(
        0.8,
      );
    },
  );

  test.each([400, 401, 403, 500, 529])(
    "does not retry HTTP %s",
    async (status) => {
      let attempts = 0;
      const client = createOpenAIDecisionsClient({
        apiKey: "fixture-key",
        fetcher: async () => {
          attempts += 1;
          return new Response("failure", { status });
        },
      });
      const result = await client.ask({ state, questions });
      expect(attempts).toBe(1);
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toMatchObject({ kind: "http", status });
      }
    },
  );

  test("retries 429 with bounded retry-after and stops after three attempts", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const client = createOpenAIDecisionsClient({
      apiKey: "fixture-key",
      fetcher: async () => {
        attempts += 1;
        return new Response("limited", {
          status: 429,
          headers: { "retry-after": "100" },
        });
      },
      sleep: async (delay) => {
        delays.push(delay);
      },
    });
    const result = await client.ask({ state, questions });
    expect(attempts).toBe(3);
    expect(delays).toEqual([5000, 5000]);
    if (Result.isError(result)) {
      expect(result.error.status).toBe(429);
    } else {
      throw new TypeError("Expected rate limit error");
    }
  });

  test("recovers after a 429 using exponential backoff", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const client = createOpenAIDecisionsClient({
      apiKey: "fixture-key",
      fetcher: async () => {
        attempts += 1;
        return attempts < 3
          ? new Response("limited", { status: 429 })
          : Response.json(fixture);
      },
      sleep: async (delay) => {
        delays.push(delay);
      },
    });
    const result = await client.ask({ state, questions });
    expect(Result.isOk(result)).toBe(true);
    expect(attempts).toBe(3);
    expect(delays).toEqual([400, 800]);
  });

  test("classifies malformed JSON and network failures without retry", async () => {
    for (const [kind, fetcher] of [
      ["invalid_response", async () => new Response("{broken")],
      [
        "network",
        async () => {
          throw new Error("offline");
        },
      ],
    ] as const) {
      const client = createOpenAIDecisionsClient({
        apiKey: "fixture-key",
        fetcher,
      });
      const result = await client.ask({ state, questions });
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.kind).toBe(kind);
        if (kind === "invalid_response") {
          expect(result.error.cause).toBeUndefined();
        }
      }
    }
  });

  test("caller cancellation stops retry backoff", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const client = createOpenAIDecisionsClient({
      apiKey: "fixture-key",
      fetcher: async () => {
        attempts += 1;
        controller.abort(new DOMException("cancelled", "AbortError"));
        return new Response("limited", { status: 429 });
      },
    });
    const result = await client.ask({
      state,
      questions,
      abortSignal: controller.signal,
    });
    expect(attempts).toBe(1);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.kind).toBe("aborted");
    }
  });

  test("enforces the local byte, question and option ceilings before fetch", async () => {
    const { client, calls } = wire();
    const requests: Parameters<typeof client.ask>[0][] = [
      { state: "č".repeat(150_000), questions },
      {
        state,
        questions: Object.fromEntries(
          Array.from({ length: 256 }, (_, index) => [
            String(index),
            noul("read"),
          ]),
        ),
      },
      {
        state,
        questions: {
          excessive: choice(
            "select",
            Object.fromEntries(
              Array.from({ length: 256 }, (_, index) => [
                String(index),
                "criterion",
              ]),
            ),
          ),
        },
      },
    ];
    for (const request of requests) {
      const result = await client.ask(request);
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.kind).toBe("invalid_request");
      }
    }
    expect(calls).toHaveLength(0);
  });
});

test.each([
  ["typesafe", "global", 0.042, 4200],
  ["typesafe", "eu", 0.042, 4200],
  ["openai", "global", 0.1, 10_000],
  ["openai", "eu", 0.11, 11_000],
] as const)(
  "shares %s/%s pricing between logging and metering",
  (provider, region, usd, units) => {
    const rate = decisionPrice({ provider, region });
    expect(rate.usdPerInputToken * 1_000_000).toBeCloseTo(usd, 10);
    expect(rate.microUnitsPerMillionInputTokens).toBe(units);
    expect(
      decisionUsageUnitsFromTokens({
        provider,
        region,
        inputTokens: 1_000_000,
        actionType: "chat",
        isByok: true,
      }),
    ).toEqual({ rawUsageMicroUnits: units, unitsConsumed: 0 });
  },
);

const serializedNames = (value: unknown) => {
  const serialized = JSON.stringify(value);
  return Object.keys(JSON.parse(serialized)).toSorted();
};

test.each(["typesafe", "openai"] as const)(
  "preserves provider-supported question names in %s answers and decisions",
  async (provider) => {
    const names = ["deliveryStatus", "itemCondition", "replacementRequested"];
    const boundaryQuestions = Object.fromEntries(
      names.map((name) => [name, noul("Read true")]),
    );
    const fetcher: Fetcher = async () =>
      Response.json({
        model: provider === "openai" ? "gpt-6-luna" : "jev-latest",
        answers:
          provider === "openai"
            ? names.map((name) => ({ type: "predicate", name, probability: 1 }))
            : Object.fromEntries(
                names.map((name) => [name, { type: "noul", noul: 1 }]),
              ),
        usage: { input_tokens: 42, output_tokens: 0 },
      });
    const client =
      provider === "openai"
        ? createOpenAIDecisionsClient({ apiKey: "fixture", fetcher })
        : createSystemOneClient({ apiKey: "fixture", fetcher });
    const asked = await client.ask({ state, questions: boundaryQuestions });
    expect(Result.isOk(asked)).toBe(true);
    if (Result.isOk(asked)) {
      expect(Object.keys(asked.value.answers).toSorted()).toEqual(
        names.toSorted(),
      );
      expect(serializedNames(asked.value.answers)).toEqual(names.toSorted());
    }
    const result = await decideMany({
      id: "test.question-names",
      orgAIConfig: null,
      dataClass: "customer",
      state,
      questions: boundaryQuestions,
      client: { ...client, keySource: "byok" },
    });
    expect(Object.keys(result.decisions).toSorted()).toEqual(names.toSorted());
    expect(serializedNames(result.decisions)).toEqual(names.toSorted());
    expect(
      Object.values(result.decisions).every(
        (decision) => decision.state === "decided",
      ),
    ).toBe(true);
    const skipped = await decideMany({
      id: "test.question-names",
      orgAIConfig: null,
      dataClass: "customer",
      state,
      questions: boundaryQuestions,
      client: null,
    });
    expect(Object.keys(skipped.decisions).toSorted()).toEqual(names.toSorted());
  },
);

test("accepts questions, options and UTF-8 body exactly at each local ceiling", async () => {
  const boundaryQuestions = Object.fromEntries(
    Array.from({ length: 255 }, (_, index) => [String(index), noul("read")]),
  );
  const predicates = Object.keys(boundaryQuestions).map((name) => ({
    name,
    type: "predicate",
    probability: 1,
  }));
  const askPredicates = wire({ ...fixture, answers: predicates });
  expect(
    Result.isOk(
      await askPredicates.client.ask({ state, questions: boundaryQuestions }),
    ),
  ).toBe(true);
  const criteria = Object.fromEntries(
    Array.from({ length: 255 }, (_, index) => [String(index), "criterion"]),
  );
  const choices = { category: choice("select", criteria) };
  const askChoice = wire({
    ...fixture,
    answers: [
      {
        type: "choice",
        name: "category",
        choice: "0",
        confidence: 1,
        probabilities: Object.keys(criteria).map((value) => ({
          value,
          probability: value === "0" ? 1 : 0,
        })),
      },
    ],
  });
  expect(
    Result.isOk(await askChoice.client.ask({ state, questions: choices })),
  ).toBe(true);
  const byteQuestions = { damaged: noul("read") };
  const overhead = new TextEncoder().encode(
    serializeOpenAIDecisionRequest({
      state: "",
      model: "gpt-6-luna",
      questions: byteQuestions,
    }),
  ).byteLength;
  const exactState =
    "č".repeat(Math.floor((150_000 - overhead) / 2)) +
    "a".repeat((150_000 - overhead) % 2);
  expect(
    new TextEncoder().encode(
      serializeOpenAIDecisionRequest({
        state: exactState,
        model: "gpt-6-luna",
        questions: byteQuestions,
      }),
    ).byteLength,
  ).toBe(150_000);
  const askBytes = wire({ ...fixture, answers: [fixture.answers.at(0)] });
  expect(
    Result.isOk(
      await askBytes.client.ask({
        state: exactState,
        questions: byteQuestions,
      }),
    ),
  ).toBe(true);
  const tooLarge = await askBytes.client.ask({
    state: `${exactState}a`,
    questions: byteQuestions,
  });
  expect(Result.isError(tooLarge)).toBe(true);
  expect(askBytes.calls).toHaveLength(1);
});

test("expires the idle response read when the transport stops producing data", async () => {
  let attemptSignal: AbortSignal | null | undefined;
  const client = createOpenAIDecisionsClient({
    apiKey: "fixture",
    timeoutMs: 1,
    fetcher: async (_url, init) => {
      attemptSignal = init?.signal;
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"model":'));
            const signal = init?.signal;
            if (!signal) {
              throw new Error("Expected transport timeout signal");
            }
            signal.addEventListener(
              "abort",
              () => stream.error(signal.reason),
              { once: true },
            );
          },
        }),
      );
    },
  });
  const asked = await client.ask({ state, questions });
  expect(attemptSignal?.aborted).toBe(true);
  expect(Result.isError(asked)).toBe(true);
});

test("accepts the response byte ceiling and cancels overflow before JSON parsing", async () => {
  const maxBytes = 8 * 1024 * 1024;
  const json = JSON.stringify(fixture);
  const atCap = `${json}${" ".repeat(maxBytes - new TextEncoder().encode(json).byteLength)}`;
  let cancelled = false;
  const makeClient = (body: string) =>
    createOpenAIDecisionsClient({
      apiKey: "fixture",
      timeoutMs: 1000,
      fetcher: async () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode(body));
              if (body === atCap) {
                stream.close();
              }
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
  expect(Result.isOk(await makeClient(atCap).ask({ state, questions }))).toBe(
    true,
  );
  const overflow = await makeClient(`${atCap} `).ask({ state, questions });
  expect(Result.isError(overflow)).toBe(true);
  if (Result.isError(overflow)) {
    expect(overflow.error).toMatchObject({
      kind: "invalid_response",
      message: "OpenAI decision response exceeds the local body limit",
    });
  }
  expect(cancelled).toBe(true);
});
