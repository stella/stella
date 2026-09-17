import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Fetcher } from "@stll/fetch";

import {
  choice,
  createSystemOneClient,
  noul,
  score,
} from "@/api/lib/typesafe/system-one";

type Call = { url: string; body: unknown; headers: Headers };

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const requestUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

/** A fetcher that answers from a queue and records what it was sent. */
const queuedFetcher = (responses: Response[]) => {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (input, init) => {
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({
      url: requestUrl(input),
      body,
      headers: new Headers(init?.headers),
    });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error("no queued response");
    }
    return await Promise.resolve(next);
  };
  return { fetcher, calls };
};

const client = (responses: Response[]) => {
  const queue = queuedFetcher(responses);
  return {
    ...queue,
    client: createSystemOneClient({
      apiKey: "key-test",
      fetcher: queue.fetcher,
      sleep: async () => {},
    }),
  };
};

const wireAnswers = {
  model: "jev-1.13.0",
  answers: {
    treatment: {
      type: "choice",
      choice: "negative",
      probabilities: { negative: 0.8, positive: 0.15, neutral: 0.05 },
      confidence: 0.77,
    },
    urgent: { type: "noul", noul: 0.91 },
    severity: {
      type: "score",
      score: 1.4,
      legend: { "0": "Calm", "1": "Tense", "2": "Angry" },
      probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 },
      confidence: 0.6,
    },
  },
  usage: { input_tokens: 120, output_tokens: 3 },
};

describe("System One client", () => {
  test("sends the state, model and questions and reads every answer under its id", async () => {
    const { client: systemOne, calls } = client([jsonResponse(wireAnswers)]);
    const asked = await systemOne.ask({
      state: { excerpt: "Na rozdíl od rozsudku 21 Cdo 1/2020 …" },
      questions: {
        treatment: choice("How is the citation treated?", {
          negative: "departs",
          positive: "follows",
          neutral: null,
        }),
        urgent: noul("Is it urgent?"),
        severity: score("How severe?", ["Calm", "Tense", "Angry"]),
      },
    });

    expect(Result.isOk(asked)).toBe(true);
    if (Result.isError(asked)) {
      return;
    }
    expect(asked.value.model).toBe("jev-1.13.0");
    expect(asked.value.answers.treatment.choice).toBe("negative");
    expect(asked.value.answers.treatment.probabilities.positive).toBe(0.15);
    expect(asked.value.answers.urgent.noul).toBe(0.91);
    expect(asked.value.answers.severity.score).toBe(1.4);
    expect(asked.value.usage).toEqual({ inputTokens: 120, outputTokens: 3 });

    const [call] = calls;
    expect(call?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(call?.headers.get("authorization")).toBe("Bearer key-test");
    expect(call?.body).toEqual({
      state: { excerpt: "Na rozdíl od rozsudku 21 Cdo 1/2020 …" },
      model: "jev-latest",
      questions: {
        treatment: {
          type: "choice",
          instructions: "How is the citation treated?",
          criteria: { negative: "departs", positive: "follows", neutral: null },
        },
        urgent: { type: "noul", instructions: "Is it urgent?" },
        severity: {
          type: "score",
          instructions: "How severe?",
          criteria: ["Calm", "Tense", "Angry"],
        },
      },
    });
  });

  test("rejects a choice outside its own criteria as an invalid response", async () => {
    const { client: systemOne } = client([
      jsonResponse({
        model: "jev-1.13.0",
        answers: {
          treatment: {
            type: "choice",
            choice: "supportive",
            probabilities: { negative: 0.2, positive: 0.1, supportive: 0.7 },
            confidence: 0.6,
          },
        },
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    ]);
    const asked = await systemOne.ask({
      state: "text",
      questions: {
        treatment: choice("treatment", { negative: null, positive: null }),
      },
    });
    expect(Result.isError(asked)).toBe(true);
    if (Result.isOk(asked)) {
      return;
    }
    expect(asked.error.kind).toBe("invalid_response");
  });

  test("rejects an answer of another type than its question", async () => {
    const { client: systemOne } = client([
      jsonResponse({
        model: "jev-1.13.0",
        answers: { urgent: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    ]);
    const asked = await systemOne.ask({
      state: "text",
      questions: { urgent: choice("which", { a: null, b: null }) },
    });
    expect(Result.isError(asked)).toBe(true);
  });

  test("reports a missing answer rather than an undefined value", async () => {
    const { client: systemOne } = client([
      jsonResponse({
        model: "jev-1.13.0",
        answers: {},
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    ]);
    const asked = await systemOne.ask({
      state: "text",
      questions: { urgent: noul("urgent?") },
    });
    expect(Result.isError(asked)).toBe(true);
  });

  test("retries a rate-limited request and honours retry-after", async () => {
    const waits: number[] = [];
    const queue = queuedFetcher([
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "2" },
      }),
      jsonResponse({
        model: "jev-1.13.0",
        answers: { urgent: { type: "noul", noul: 0.2 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    ]);
    const systemOne = createSystemOneClient({
      apiKey: "key-test",
      fetcher: queue.fetcher,
      sleep: async (ms) => {
        waits.push(ms);
        await Promise.resolve();
      },
    });
    const asked = await systemOne.ask({
      state: "text",
      questions: { urgent: noul("urgent?") },
    });
    expect(Result.isOk(asked)).toBe(true);
    expect(waits).toEqual([2000]);
    expect(queue.calls).toHaveLength(2);
  });

  test("surfaces a validation failure as an http error with its status", async () => {
    const { client: systemOne, calls } = client([
      new Response('{"detail":"criteria missing"}', { status: 422 }),
    ]);
    const asked = await systemOne.ask({
      state: "text",
      questions: { urgent: noul("urgent?") },
    });
    expect(Result.isError(asked)).toBe(true);
    if (Result.isOk(asked)) {
      return;
    }
    expect(asked.error.kind).toBe("http");
    expect(asked.error.status).toBe(422);
    expect(calls).toHaveLength(1);
  });
});
