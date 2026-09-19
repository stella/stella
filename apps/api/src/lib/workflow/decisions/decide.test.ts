import { afterEach, describe, expect, test } from "bun:test";

import type { Fetcher } from "@stll/fetch";

import { decide, decideMany } from "@/api/lib/workflow/decisions/decide";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import {
  choice,
  createSystemOneClient,
  noul,
} from "@/api/lib/workflow/decisions/system-one";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

/**
 * Clients over a fake wire, so the floor is measured against answers that
 * came through the real transport and its per-question binding rather than
 * against hand-typed answer objects.
 */
type FakeWire = { client: DecisionModel; calls: () => number };

const decisionModel = (fetcher: Fetcher): DecisionModel => ({
  ...createSystemOneClient({ apiKey: "key-test", fetcher }),
  keySource: "byok",
});

const wireOver = (respond: () => Response): FakeWire => {
  let calls = 0;
  const fetcher: Fetcher = async () => {
    calls += 1;
    return await Promise.resolve(respond());
  };
  return {
    client: decisionModel(fetcher),
    calls: () => calls,
  };
};

const respondingWith = (answers: Record<string, unknown>): FakeWire =>
  wireOver(
    () =>
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers,
          usage: { input_tokens: 120, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );

// 400 is not retryable, so one call is one failure.
const failingWire = (): FakeWire =>
  wireOver(() => new Response("bad request", { status: 400 }));

const clientThatMustNotRun: DecisionModel = {
  model: "jev-test",
  keySource: "byok",
  ask: () => {
    throw new Error("no decision model is configured; nothing may be asked");
  },
};

const kindQuestion = choice(
  { task: "Which kind of contract is this?" },
  { purchase: "A sale of goods.", lease: "A letting of property." },
);
const signedQuestion = noul({ task: "Is the contract signed?" });

const choiceAnswer = (
  chosen: "purchase" | "lease",
  confidence: number,
): unknown => ({
  type: "choice",
  choice: chosen,
  probabilities: {
    purchase: chosen === "purchase" ? 0.9 : 0.1,
    lease: chosen === "lease" ? 0.9 : 0.1,
  },
  confidence,
});

const state = { text: "The seller sells and the buyer buys." };

let analytics: RecordingAnalytics | null = null;
let logs: RecordingLogger | null = null;

afterEach(() => {
  analytics?.restore();
  logs?.restore();
  analytics = null;
  logs = null;
});

describe("decideMany without a decision model", () => {
  test("every question is undecided, nothing is asked and nothing is logged", async () => {
    logs = installRecordingLogger();

    const { decisions, model } = await decideMany({
      id: "test.no-backend",
      orgAIConfig: null,
      state,
      questions: { kind: kindQuestion, signed: signedQuestion },
      client: null,
    });

    expect(model).toBeNull();
    expect(decisions.kind).toEqual({
      state: "undecided",
      reason: "no-backend",
      confidence: null,
    });
    expect(decisions.signed).toEqual({
      state: "undecided",
      reason: "no-backend",
      confidence: null,
    });
    expect(logs.records).toEqual([]);
  });

  test("an empty question set asks nothing even with a client", async () => {
    const { decisions, model } = await decideMany({
      id: "test.empty",
      orgAIConfig: null,
      state,
      questions: {},
      client: clientThatMustNotRun,
    });

    expect(decisions).toEqual({});
    expect(model).toBeNull();
  });
});

describe("the confidence floor, per answer type", () => {
  test("a choice is measured by its own confidence", async () => {
    const above = respondingWith({ kind: choiceAnswer("purchase", 0.82) });
    const decided = await decideMany({
      id: "test.choice",
      orgAIConfig: null,
      state,
      questions: { kind: kindQuestion },
      client: above.client,
    });
    expect(decided.decisions.kind).toEqual({
      state: "decided",
      answer: {
        type: "choice",
        choice: "purchase",
        probabilities: { purchase: 0.9, lease: 0.1 },
        confidence: 0.82,
      },
      probability: 0.9,
      confidence: 0.82,
    });
    expect(decided.model).toBe("jev-1.13.0");

    const below = respondingWith({ kind: choiceAnswer("purchase", 0.55) });
    const unsure = await decideMany({
      id: "test.choice",
      orgAIConfig: null,
      state,
      questions: { kind: kindQuestion },
      client: below.client,
    });
    expect(unsure.decisions.kind).toEqual({
      state: "undecided",
      reason: "below-floor",
      confidence: 0.55,
    });
  });

  test("a noul is measured by how far from even it sits", async () => {
    const sure = respondingWith({ signed: { type: "noul", noul: 0.93 } });
    const decided = await decideMany({
      id: "test.noul",
      orgAIConfig: null,
      state,
      questions: { signed: signedQuestion },
      client: sure.client,
    });
    const answer = decided.decisions.signed;
    if (answer.state !== "decided") {
      throw new Error("expected a decided noul");
    }
    expect(answer.probability).toBe(0.93);
    expect(answer.confidence).toBeCloseTo(0.86, 10);

    // 0.7 yes is a 0.4 reading: a yes the model is not sure enough of.
    const even = respondingWith({ signed: { type: "noul", noul: 0.7 } });
    const unsure = await decideMany({
      id: "test.noul",
      orgAIConfig: null,
      state,
      questions: { signed: signedQuestion },
      client: even.client,
    });
    expect(unsure.decisions.signed.state).toBe("undecided");
    if (unsure.decisions.signed.state !== "undecided") {
      return;
    }
    expect(unsure.decisions.signed.reason).toBe("below-floor");
    expect(unsure.decisions.signed.confidence).toBeCloseTo(0.4, 10);
  });

  test("a site whose wrong answer costs more passes its own floor", async () => {
    const wire = respondingWith({ kind: choiceAnswer("lease", 0.82) });
    const { decisions } = await decideMany({
      id: "test.floor",
      orgAIConfig: null,
      state,
      questions: { kind: kindQuestion },
      floor: 0.9,
      client: wire.client,
    });
    expect(decisions.kind).toEqual({
      state: "undecided",
      reason: "below-floor",
      confidence: 0.82,
    });
  });
});

describe("a failed call", () => {
  test("leaves every question undecided and is captured, not thrown", async () => {
    analytics = installRecordingAnalytics();
    const wire = failingWire();

    const { decisions, model } = await decideMany({
      id: "test.failed",
      orgAIConfig: null,
      state,
      questions: { kind: kindQuestion, signed: signedQuestion },
      client: wire.client,
    });

    expect(wire.calls()).toBe(1);
    expect(model).toBeNull();
    expect(decisions.kind).toEqual({
      state: "undecided",
      reason: "failed",
      confidence: null,
    });
    expect(decisions.signed).toEqual({
      state: "undecided",
      reason: "failed",
      confidence: null,
    });
    const [event] = analytics.exceptions();
    expect(event?.properties).toMatchObject({
      source: "decide",
      decision: "test.failed",
    });
  });

  test("an aborted call stops its enclosing operation without reporting a model outage", async () => {
    analytics = installRecordingAnalytics();
    const controller = new AbortController();
    controller.abort(new DOMException("Request cancelled", "AbortError"));
    const fetcher: Fetcher = async () => {
      throw controller.signal.reason;
    };

    expect(
      decideMany({
        id: "test.aborted",
        orgAIConfig: null,
        state,
        questions: { signed: signedQuestion },
        abortSignal: controller.signal,
        client: decisionModel(fetcher),
      }),
    ).rejects.toThrow("Request cancelled");
    expect(analytics.exceptions()).toEqual([]);
  });

  test("a decision timeout falls back and is reported as an operational failure", async () => {
    analytics = installRecordingAnalytics();
    const fetcher: Fetcher = async (_input, init) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) {
        throw new TypeError("decision requests must carry a timeout signal");
      }
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("Aborted", "AbortError"),
            ),
          { once: true },
        );
      });
    };

    const { decisions, model } = await decideMany({
      id: "test.timeout",
      orgAIConfig: null,
      state,
      questions: { signed: signedQuestion },
      timeoutMs: 1,
      client: decisionModel(fetcher),
    });

    expect(model).toBeNull();
    expect(decisions.signed).toEqual({
      state: "undecided",
      reason: "failed",
      confidence: null,
    });
    expect(analytics.exceptions()).toHaveLength(1);
  });
});

describe("the log line", () => {
  test("counts what was decided and what was not, with one reading per question", async () => {
    logs = installRecordingLogger();
    const wire = respondingWith({
      kind: choiceAnswer("purchase", 0.82),
      signed: { type: "noul", noul: 0.7 },
    });

    await decideMany({
      id: "test.log",
      orgAIConfig: null,
      state,
      questions: { kind: kindQuestion, signed: signedQuestion },
      client: wire.client,
    });

    const [record] = logs.at("INFO");
    expect(record?.message).toBe("ai.decision");
    expect(record?.attributes).toMatchObject({
      decision: "test.log",
      model: "jev-1.13.0",
      questionCount: 2,
      decidedCount: 1,
      undecidedCount: 1,
      floor: 0.6,
      inputTokens: 120,
    });
    const readings: unknown = JSON.parse(
      String(record?.attributes?.["readings"] ?? "[]"),
    );
    expect(readings).toMatchObject([
      { q: "kind", type: "choice", value: "purchase", state: "decided" },
      { q: "signed", type: "noul", value: 0.7, state: "below-floor" },
    ]);
  });
});

describe("decide", () => {
  test("returns the one question's decision", async () => {
    const wire = respondingWith({ answer: choiceAnswer("lease", 0.88) });

    const decision = await decide({
      id: "test.single",
      orgAIConfig: null,
      state,
      question: kindQuestion,
      client: wire.client,
    });

    expect(decision).toEqual({
      state: "decided",
      answer: {
        type: "choice",
        choice: "lease",
        probabilities: { purchase: 0.1, lease: 0.9 },
        confidence: 0.88,
      },
      probability: 0.9,
      confidence: 0.88,
    });
  });

  test("with no decision model it is undecided rather than absent", async () => {
    const decision = await decide({
      id: "test.single",
      orgAIConfig: null,
      state,
      question: kindQuestion,
      client: null,
    });

    expect(decision).toEqual({
      state: "undecided",
      reason: "no-backend",
      confidence: null,
    });
  });
});
