import { describe, expect, test } from "bun:test";

import type { Fetcher } from "@stll/fetch";

import type { ScopedDb } from "@/api/db/safe-db";
import { classifyCitation } from "@/api/handlers/case-law/polarity/classifier";
import {
  MODEL_READING_GUIDANCE,
  POLARITY_READINGS,
} from "@/api/handlers/case-law/polarity/model-readings";
import type { RuleCache } from "@/api/handlers/case-law/polarity/rule-engine";
import {
  classifyWithSystemOne,
  SYSTEM_ONE_POLARITY_ACCEPT_CONFIDENCE,
} from "@/api/handlers/case-law/polarity/system-one-classifier";
import { createSystemOneClient } from "@/api/lib/workflow/decisions/system-one";
import type { SystemOneClient } from "@/api/lib/workflow/decisions/system-one";

/** The question keys a request asked under; the decision primitive names them. */
const questionKeysOf = (body: unknown): string[] => {
  if (typeof body !== "object" || body === null || !("questions" in body)) {
    return [];
  }
  const { questions } = body;
  return typeof questions === "object" && questions !== null
    ? Object.keys(questions)
    : [];
};

/**
 * A client over a fake wire that answers every question of the request with a
 * fixed distribution, so the test exercises the real transport and its answer
 * binding rather than a hand-typed answer.
 */
const fakeClient = (
  choice: string,
  confidence: number,
): { client: SystemOneClient; requests: unknown[] } => {
  const requests: unknown[] = [];
  const fetcher: Fetcher = async (_input, init) => {
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push(body);
    const probabilities = Object.fromEntries(
      Object.keys(MODEL_READING_GUIDANCE).map((polarity) => [
        polarity,
        polarity === choice
          ? confidence
          : (1 - confidence) / (Object.keys(MODEL_READING_GUIDANCE).length - 1),
      ]),
    );
    const answers = Object.fromEntries(
      questionKeysOf(body).map((key) => [
        key,
        { type: "choice", choice, probabilities, confidence },
      ]),
    );
    return await Promise.resolve(
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers,
          usage: { input_tokens: 80, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
  return {
    client: createSystemOneClient({ apiKey: "key-test", fetcher }),
    requests,
  };
};

/** No rule for the language, so the regex tier finds nothing and asks no database. */
const emptyRuleCache = (language: string): RuleCache =>
  new Map([[language, []]]);

const scopedDbThatMustNotRun: ScopedDb = () => {
  throw new Error("the cascade must not touch the database in this test");
};

const context =
  "Na rozdíl od rozsudku Nejvyššího soudu sp. zn. 21 Cdo 1234/2020 dospěl " +
  "soud k závěru, že nárok promlčen nebyl.";

describe("classifyWithSystemOne", () => {
  test("asks one choice over valid kind and polarity pairs with shared guidance", async () => {
    const { client, requests } = fakeClient("negative", 0.9);
    const reading = await classifyWithSystemOne({
      client,
      generator: async () => {
        throw new Error("Generation unavailable in this test");
      },
      context,
      citationText: "sp. zn. 21 Cdo 1234/2020",
      language: "cs",
    });

    if (reading.state !== "decided") {
      throw new Error("expected a decided reading");
    }
    expect(reading.answer.choice).toBe("negative");
    expect(reading.confidence).toBe(0.9);

    expect(requests).toHaveLength(1);
    const [request] = requests;
    const [questionKey] = questionKeysOf(request);
    expect(questionKey).toBeDefined();
    expect(request).toMatchObject({
      model: "jev-latest",
      state: {
        language: "cs",
        citation: "sp. zn. 21 Cdo 1234/2020",
        excerpt: context,
      },
      questions: {
        [String(questionKey)]: {
          type: "choice",
          criteria: MODEL_READING_GUIDANCE,
        },
      },
    });
  });

  test("the decision owner supplies generative polarity when the model cannot settle it", async () => {
    const { client } = fakeClient("negative", 0.6);
    const reading = await classifyWithSystemOne({
      client,
      context,
      citationText: "sp. zn. 21 Cdo 1234/2020",
      language: "cs",
      generator: async ({ questions, state }) => {
        expect(state).toMatchObject({ excerpt: context });
        expect(Object.keys(questions)).toEqual(["answer"]);
        return {
          model: "test-generative",
          output: {
            answers: [
              {
                id: "answer",
                answer: {
                  type: "choice",
                  choice: "negative",
                  probabilities: {
                    positive: 0.02,
                    negative: 0.94,
                    neutral: 0.01,
                    supportive: 0.02,
                    form: 0.01,
                  },
                  confidence: 0.94,
                },
                evidence: "Na rozdíl od",
              },
            ],
          },
        };
      },
    });
    expect(reading).toMatchObject({
      state: "decided",
      source: "generative",
      evidence: "Na rozdíl od",
      answer: { choice: "negative" },
    });
  });

  test("a generative failure after an answer under the floor stays undecided", async () => {
    const { client } = fakeClient(
      "negative",
      SYSTEM_ONE_POLARITY_ACCEPT_CONFIDENCE - 0.05,
    );
    const reading = await classifyWithSystemOne({
      client,
      generator: async () => {
        throw new Error("Generation unavailable in this test");
      },
      context,
      citationText: "sp. zn. 21 Cdo 1234/2020",
      language: "cs",
    });

    expect(reading).toMatchObject({
      state: "undecided",
      reason: "failed",
    });
  });

  test("a generative failure without a decision model stays undecided", async () => {
    const reading = await classifyWithSystemOne({
      client: null,
      generator: async () => {
        throw new Error("Generation unavailable in this test");
      },
      context,
      citationText: "sp. zn. 21 Cdo 1234/2020",
      language: "cs",
    });

    expect(reading).toEqual({
      state: "undecided",
      reason: "failed",
      confidence: null,
      source: "generative",
      model: null,
    });
  });
});

describe("classifyCitation with the System One tier", () => {
  test("a confident reading is the label, attributed to the tier, with no rule id", async () => {
    const { client } = fakeClient("negative", 0.92);
    const result = await classifyCitation({
      windows: {
        mentions: [context],
        contexts: [context],
        evidenceWindows: [{ start: 0, end: context.length }],
        contextEvidenceWindows: [{ start: 0, end: context.length }],
      },
      citationText: "sp. zn. 21 Cdo 1234/2020",
      language: "cs",
      observedAt: new Date("2026-09-17T00:00:00Z"),
      scopedDb: scopedDbThatMustNotRun,
      options: {
        ruleCache: emptyRuleCache("cs"),
        dryRun: true,
        decisionModel: client,
      },
    });
    expect(result).toEqual({
      polarity: "negative",
      ruleId: null,
      source: "system-one",
      confidence: 0.92,
      classifierVersion: "citation-polarity-v2",
      evidenceWindows: [{ start: 0, end: context.length }],
      citedPart: "not-stated",
    });
  });

  test.each([null, "", "  ", "invented phrase", "x".repeat(101)])(
    "does not promote unsupported or oversized evidence %p",
    async (evidence) => {
      let writes = 0;
      const scopedDb: ScopedDb = () => {
        writes += 1;
        throw new Error("Promotion must not write unsupported evidence");
      };
      const excerpt =
        evidence !== null && evidence !== "invented phrase"
          ? `${context} ${evidence}`
          : context;
      const result = await classifyCitation({
        windows: {
          mentions: [excerpt],
          contexts: [excerpt],
          evidenceWindows: [{ start: 0, end: excerpt.length }],
          contextEvidenceWindows: [{ start: 0, end: excerpt.length }],
        },
        citationText: "sp. zn. 21 Cdo 1234/2020",
        language: "cs",
        observedAt: new Date("2026-09-17T00:00:00Z"),
        scopedDb,
        options: {
          ruleCache: emptyRuleCache("cs"),
          decisionModel: null,
          generator: async () => ({
            model: "test-generative",
            output: {
              answers: [
                {
                  id: "answer",
                  answer: {
                    type: "choice",
                    choice: "negative",
                    probabilities: {
                      positive: 0.02,
                      negative: 0.94,
                      neutral: 0.01,
                      supportive: 0.02,
                      form: 0.01,
                    },
                    confidence: 0.94,
                  },
                  evidence,
                },
              ],
            },
          }),
        },
      });
      expect(result).toMatchObject({ polarity: "negative", source: "llm" });
      expect(writes).toBe(0);
    },
  );

  test("the acceptance floor is a real floor", () => {
    expect(SYSTEM_ONE_POLARITY_ACCEPT_CONFIDENCE).toBeGreaterThan(0.5);
    expect(SYSTEM_ONE_POLARITY_ACCEPT_CONFIDENCE).toBeLessThan(1);
  });
});

test.each(Object.entries(POLARITY_READINGS))(
  "each valid model reading gives its specified polarity: %s",
  async (readingChoice, treatment) => {
    const result = await classifyCitation({
      windows: {
        mentions: [context],
        contexts: [context],
        evidenceWindows: [{ start: 0, end: context.length }],
        contextEvidenceWindows: [{ start: 0, end: context.length }],
      },
      citationText: "sp. zn. 21 Cdo 1234/2020",
      language: "cs",
      observedAt: new Date("2026-09-17T00:00:00Z"),
      scopedDb: scopedDbThatMustNotRun,
      options: {
        ruleCache: emptyRuleCache("cs"),
        decisionModel: null,
        dryRun: true,
        generator: async ({ questions }) => {
          expect(Object.keys(questions)).toEqual(["answer"]);
          return {
            model: "test-generative",
            output: {
              answers: [
                {
                  id: "answer",
                  answer: {
                    type: "choice",
                    choice: readingChoice,
                    probabilities: Object.fromEntries(
                      Object.keys(MODEL_READING_GUIDANCE).map((key) => [
                        key,
                        key === readingChoice ? 1 : 0,
                      ]),
                    ),
                    confidence: 1,
                  },
                  evidence: "Na rozdíl od",
                },
              ],
            },
          };
        },
      },
    });
    expect(result).toMatchObject({
      polarity: treatment.polarity,
      source: "llm",
      confidence: 1,
    });
  },
);
