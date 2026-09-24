import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, test } from "bun:test";

import type { DecisionAnalysis } from "@stll/legal-ast/analysis";

import { decisionAnalysisOptions } from "@/features/case-law/queries/decision-analysis";
import {
  decisionOptions,
  publicDecisionReadFilter,
} from "@/features/case-law/queries/decisions";

const DECISION_ID = "01a02a37-2222-7222-8222-222222222222";
const ANALYSIS_PATH = `/case/decisions/${DECISION_ID}/analysis`;
const DECISION_PATH = `/case/decisions/${DECISION_ID}`;
const previousFetch = globalThis.fetch;

const analysis = {
  version: 2,
  generatedAt: "2026-08-23T10:00:00.000Z",
  model: "test-model",
  inputFingerprint: "f".repeat(64),
  tree: [
    {
      id: "h1",
      label: "Facts",
      category: "facts",
      startAnchorId: "a1",
      endAnchorId: "a2",
      annotations: [],
      children: [],
    },
  ],
} satisfies DecisionAnalysis;

const GENERATING = { status: "generating" } as const;
const DONE = { status: "done", analysis } as const;

afterEach(() => {
  globalThis.fetch = previousFetch;
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });

const VERSION_1 = "2026-09-01T10:00:00.000Z";
const VERSION_2 = "2026-09-02T10:00:00.000Z";

/** Answers `answers` in turn, holding the last once they run out. */
const inTurn = (answers: readonly unknown[], served: number): unknown =>
  answers.at(served - 1) ?? answers.at(-1) ?? null;

type MockReadsOptions = {
  analysisAnswers: readonly unknown[];
  /** The `updatedAt` each public decision read answers, in turn. */
  decisionVersions: readonly string[];
};

/**
 * Stands in for the public decision read and the analysis read; every
 * request's path is recorded.
 */
const mockReads = ({ analysisAnswers, decisionVersions }: MockReadsOptions) => {
  const paths: string[] = [];
  const count = (suffix: string) =>
    paths.filter((path) => path.endsWith(suffix)).length;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const { pathname } = new URL(new Request(input, init).url);
      paths.push(pathname);
      if (pathname.endsWith(ANALYSIS_PATH)) {
        return json(inTurn(analysisAnswers, count(ANALYSIS_PATH)));
      }
      expect(pathname).toEndWith(DECISION_PATH);
      // The public read never carries the analysis.
      return json({
        id: DECISION_ID,
        caseNumber: "1 A 1/2026",
        updatedAt: inTurn(decisionVersions, count(DECISION_PATH)),
      });
    },
    { preconnect: previousFetch.preconnect },
  );
  return {
    analysisReads: () => count(ANALYSIS_PATH),
    decisionReads: () => count(DECISION_PATH),
  };
};

const newQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** The analysis options as the reader builds them from the decision it holds. */
const analysisOfReadDecision = async (queryClient: QueryClient) => {
  const decision = await queryClient.query(decisionOptions(DECISION_ID));
  return decisionAnalysisOptions({
    decisionId: DECISION_ID,
    decisionUpdatedAt: decision.updatedAt,
  });
};

const refetchDecision = async (queryClient: QueryClient) => {
  await queryClient.invalidateQueries(publicDecisionReadFilter(DECISION_ID));
  await queryClient.refetchQueries(publicDecisionReadFilter(DECISION_ID));
};

describe("decision analysis query", () => {
  test("a decision refetch at the same version keeps the finished analysis without asking again", async () => {
    const reads = mockReads({
      analysisAnswers: [DONE],
      decisionVersions: [VERSION_1],
    });
    const queryClient = newQueryClient();

    await queryClient.query(await analysisOfReadDecision(queryClient));
    await refetchDecision(queryClient);

    expect(
      await queryClient.query(await analysisOfReadDecision(queryClient)),
    ).toEqual({ kind: "done", analysis });
    expect(reads.decisionReads()).toBe(2);
    expect(reads.analysisReads()).toBe(1);
  });

  test("a decision read at a new version asks for its analysis again", async () => {
    const reads = mockReads({
      analysisAnswers: [DONE, GENERATING],
      decisionVersions: [VERSION_1, VERSION_2],
    });
    const queryClient = newQueryClient();

    await queryClient.query(await analysisOfReadDecision(queryClient));
    await refetchDecision(queryClient);

    expect(
      await queryClient.query(await analysisOfReadDecision(queryClient)),
    ).toEqual({ kind: "generating", tree: [] });
    expect(reads.analysisReads()).toBe(2);
  });

  test("a run still generating is asked again until it finishes, then held", async () => {
    const reads = mockReads({
      analysisAnswers: [GENERATING, GENERATING, DONE],
      decisionVersions: [VERSION_1],
    });
    const queryClient = newQueryClient();
    const options = await analysisOfReadDecision(queryClient);

    expect(await queryClient.query(options)).toEqual({
      kind: "generating",
      tree: [],
    });
    expect((await queryClient.query(options)).kind).toBe("generating");
    expect(await queryClient.query(options)).toEqual({
      kind: "done",
      analysis,
    });
    await queryClient.query(options);

    expect(reads.analysisReads()).toBe(3);
  });
});
