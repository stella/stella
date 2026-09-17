import { Result } from "better-result";
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
import { createSystemOneClient } from "@/api/lib/typesafe/system-one";
import type { SystemOneClient } from "@/api/lib/typesafe/system-one";

/**
 * A client over a fake wire that answers the polarity question with a fixed
 * distribution, so the test exercises the real transport and its answer
 * binding rather than a hand-typed answer.
 */
const fakeClient = (
  choice: string,
  confidence: number,
): { client: SystemOneClient; requests: unknown[] } => {
  const requests: unknown[] = [];
  const fetcher: Fetcher = async (_input, init) => {
    requests.push(
      typeof init?.body === "string" ? JSON.parse(init.body) : null,
    );
    const probabilities = Object.fromEntries(
      CLASSIFIABLE_POLARITIES.map((polarity) => [
        polarity,
        polarity === choice ? confidence : (1 - confidence) / 3,
      ]),
    );
    return await Promise.resolve(
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            polarity: { type: "choice", choice, probabilities, confidence },
          },
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

    expect(Result.isOk(reading)).toBe(true);
    if (Result.isError(reading)) {
      return;
    }
    expect(reading.value.polarity).toBe("negative");
    expect(reading.value.model).toBe("jev-1.13.0");
    expect(reading.value.inputTokens).toBe(80);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "jev-latest",
      state: {
        language: "cs",
        citation: "sp. zn. 21 Cdo 1234/2020",
        excerpt: context,
      },
      questions: {
        polarity: {
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
});

describe("classifyCitation with the System One tier", () => {
  test("a confident reading is the label, attributed to the tier, with no rule id", async () => {
    const { client } = fakeClient("negative", 0.92);
    const result = await classifyCitation({
      context,
      citationText: "sp. zn. 21 Cdo 1234/2020",
      language: "cs",
      observedAt: new Date("2026-09-17T00:00:00Z"),
      scopedDb: scopedDbThatMustNotRun,
      options: {
        ruleCache: emptyRuleCache("cs"),
        dryRun: true,
        systemOne: client,
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
