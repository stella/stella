import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  CITATION_RELATIONS,
  CITATION_RELATION_UNCERTAIN,
} from "@stll/api-contract/citation-check";
import type { Fetcher } from "@stll/fetch";

import { checkCitationWithSystemOne } from "@/api/handlers/case-law/citations/check-with-system-one";
import {
  CITATION_RELATION_CRITERIA,
  NO_PASSAGE_CRITERION,
} from "@/api/handlers/case-law/citations/check.logic";
import {
  NO_SOURCE,
  SYSTEM_ONE_ACCEPT_CONFIDENCE,
} from "@/api/lib/typesafe/answer-questions";
import { createSystemOneClient } from "@/api/lib/typesafe/system-one";
import type { SystemOneClient } from "@/api/lib/typesafe/system-one";

type FakeAnswer = {
  relation: string;
  confidence: number;
  where: string;
};

/**
 * A client over a fake wire, so the test exercises the real transport and its
 * answer binding rather than a hand-typed answer. Nothing reaches the network:
 * the fetcher is the only thing the client can call.
 */
const fakeClient = (
  { confidence, relation, where }: FakeAnswer,
  passageIds: readonly string[],
): { client: SystemOneClient; requests: unknown[] } => {
  const requests: unknown[] = [];
  const fetcher: Fetcher = async (_input, init) => {
    requests.push(
      typeof init?.body === "string" ? JSON.parse(init.body) : null,
    );
    const relationProbabilities = Object.fromEntries(
      CITATION_RELATIONS.map((candidate) => [
        candidate,
        candidate === relation
          ? confidence
          : (1 - confidence) / (CITATION_RELATIONS.length - 1),
      ]),
    );
    const whereOptions = [...passageIds, NO_SOURCE];
    const whereProbabilities = Object.fromEntries(
      whereOptions.map((option) => [
        option,
        option === where ? 0.8 : 0.2 / (whereOptions.length - 1),
      ]),
    );
    return await Promise.resolve(
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            relation: {
              type: "choice",
              choice: relation,
              probabilities: relationProbabilities,
              confidence,
            },
            where: {
              type: "choice",
              choice: where,
              probabilities: whereProbabilities,
              confidence: 0.8,
            },
          },
          usage: { input_tokens: 940, output_tokens: 2 },
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

const decision = {
  caseNumber: "21 Cdo 1234/2020",
  court: "Nejvyšší soud",
  country: "CZE",
  decisionDate: "2020-06-01",
  language: "cs",
};

const sources = [
  {
    id: "b12",
    text: "Nárok na náhradu škody se promlčuje v subjektivní tříleté lhůtě.",
  },
  { id: "b31", text: "Dovolání se odmítá." },
];
const passageIds = sources.map((source) => source.id);

const claim =
  "A claim for damages under Czech law is time-barred three years after the injured party learns of the damage.";

describe("asking Jev how a decision stands to a cited sentence", () => {
  test("asks one request carrying both questions and the decision as state", async () => {
    const { client, requests } = fakeClient(
      { relation: "supports", confidence: 0.91, where: "b12" },
      passageIds,
    );

    const read = await checkCitationWithSystemOne({
      claim,
      claimLanguage: "en",
      client,
      decision,
      sources,
    });

    expect(Result.isOk(read)).toBe(true);
    // One reading, not one per question: the relation and the passage it
    // rests on are the same judgment.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "jev-latest",
      state: {
        claim,
        claimLanguage: "en",
        decision: {
          caseNumber: "21 Cdo 1234/2020",
          court: "Nejvyšší soud",
          country: "CZE",
          decisionDate: "2020-06-01",
          language: "cs",
        },
        passages: [
          { id: "b12", text: sources[0]!.text },
          { id: "b31", text: sources[1]!.text },
        ],
      },
      questions: {
        relation: { type: "choice", criteria: CITATION_RELATION_CRITERIA },
        where: {
          type: "choice",
          criteria: {
            b12: sources[0]!.text,
            b31: sources[1]!.text,
            [NO_SOURCE]: NO_PASSAGE_CRITERION,
          },
        },
      },
    });
  });

  test("a confident reading carries the relation, the cost and the court's own words", async () => {
    const { client } = fakeClient(
      { relation: "contradicts", confidence: 0.88, where: "b31" },
      passageIds,
    );

    const read = await checkCitationWithSystemOne({
      claim,
      claimLanguage: "en",
      client,
      decision,
      sources,
    });
    expect(Result.isOk(read)).toBe(true);
    if (Result.isError(read)) {
      return;
    }
    expect(read.value.relation).toBe("contradicts");
    expect(read.value.probability).toBeCloseTo(0.88);
    expect(read.value.model).toBe("jev-1.13.0");
    expect(read.value.inputTokens).toBe(940);
    // The passage is the one the request offered, verbatim, which is what
    // makes it quotable next to the sentence being checked.
    expect(read.value.passage).toEqual({
      anchor: "b31",
      text: sources[1]!.text,
    });
  });

  test("an unsure reading is reported as uncertain with its distribution intact", async () => {
    const { client } = fakeClient(
      {
        relation: "does_not_address",
        confidence: SYSTEM_ONE_ACCEPT_CONFIDENCE - 0.05,
        where: NO_SOURCE,
      },
      passageIds,
    );

    const read = await checkCitationWithSystemOne({
      claim,
      claimLanguage: "en",
      client,
      decision,
      sources,
    });
    expect(Result.isOk(read)).toBe(true);
    if (Result.isError(read)) {
      return;
    }
    expect(read.value.relation).toBe(CITATION_RELATION_UNCERTAIN);
    expect(Object.keys(read.value.probabilities).toSorted()).toEqual(
      [...CITATION_RELATIONS].toSorted(),
    );
    expect(read.value.passage).toBeNull();
  });

  test("an answer outside the offered options is a transport error, not a reading", async () => {
    const { client } = fakeClient(
      { relation: "unclear", confidence: 0.9, where: "b12" },
      passageIds,
    );

    const read = await checkCitationWithSystemOne({
      claim,
      claimLanguage: "en",
      client,
      decision,
      sources,
    });
    expect(Result.isError(read)).toBe(true);
    if (Result.isOk(read)) {
      return;
    }
    expect(read.error.kind).toBe("invalid_response");
  });
});
