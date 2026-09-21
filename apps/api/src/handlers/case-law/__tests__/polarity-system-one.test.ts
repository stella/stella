import { describe, expect, test } from "bun:test";

import type { Fetcher } from "@stll/fetch";

import type { ScopedDb } from "@/api/db/safe-db";
import { classifyCitation } from "@/api/handlers/case-law/polarity/classifier";
import { CLASSIFIABLE_POLARITIES } from "@/api/handlers/case-law/polarity/consts";
import { POLARITY_GUIDANCE } from "@/api/handlers/case-law/polarity/guidance";
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
      CLASSIFIABLE_POLARITIES.map((polarity) => [
        polarity,
        polarity === choice ? confidence : (1 - confidence) / 3,
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
  test("asks one choice over the polarity vocabulary with the shared guidance as criteria", async () => {
    const { client, requests } = fakeClient("negative", 0.9);
    const reading = await classifyWithSystemOne({
      client,
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
          criteria: Object.fromEntries(
            CLASSIFIABLE_POLARITIES.map((polarity) => [
              polarity,
              POLARITY_GUIDANCE[polarity],
            ]),
          ),
        },
      },
    });
  });

  test("a reading under the floor is undecided, so the generative tier reads", async () => {
    const { client } = fakeClient(
      "negative",
      SYSTEM_ONE_POLARITY_ACCEPT_CONFIDENCE - 0.05,
    );
    const reading = await classifyWithSystemOne({
      client,
      context,
      citationText: "sp. zn. 21 Cdo 1234/2020",
      language: "cs",
    });

    expect(reading).toMatchObject({
      state: "undecided",
      reason: "below-floor",
    });
  });

  /**
   * The tier is the only thing between the regex tier and the generative one,
   * and it returns a label only on `state === "decided"`, so an undecided
   * reading is the pre-existing LLM path. Asserted here rather than through
   * `classifyCitation`, which would call the generative model.
   */
  test("with no decision model nothing is asked and nothing is decided", async () => {
    const reading = await classifyWithSystemOne({
      client: null,
      context,
      citationText: "sp. zn. 21 Cdo 1234/2020",
      language: "cs",
    });

    expect(reading).toEqual({
      state: "undecided",
      reason: "no-backend",
      confidence: null,
    });
  });
});

describe("classifyCitation with the System One tier", () => {
  test("a confident reading is the label, attributed to the tier, with no rule id", async () => {
    const { client } = fakeClient("negative", 0.92);
    const result = await classifyCitation({
      contexts: [context],
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
    });
  });

  test("the acceptance floor is a real floor", () => {
    expect(SYSTEM_ONE_POLARITY_ACCEPT_CONFIDENCE).toBeGreaterThan(0.5);
    expect(SYSTEM_ONE_POLARITY_ACCEPT_CONFIDENCE).toBeLessThan(1);
  });
});
