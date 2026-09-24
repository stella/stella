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

/**
 * Stands in for the public decision read and the analysis read. The analysis
 * answers from `analysisAnswers` in turn, holding the last; every request's
 * path is recorded.
 */
const mockReads = (analysisAnswers: readonly unknown[]) => {
  const paths: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const { pathname } = new URL(new Request(input, init).url);
      paths.push(pathname);
      if (pathname.endsWith(ANALYSIS_PATH)) {
        const served = paths.filter((path) =>
          path.endsWith(ANALYSIS_PATH),
        ).length;
        return json(
          analysisAnswers.at(served - 1) ?? analysisAnswers.at(-1) ?? null,
        );
      }
      expect(pathname).toEndWith(DECISION_PATH);
      // The public read never carries the analysis.
      return json({ id: DECISION_ID, caseNumber: "1 A 1/2026" });
    },
    { preconnect: previousFetch.preconnect },
  );
  const count = (suffix: string) =>
    paths.filter((path) => path.endsWith(suffix)).length;
  return {
    analysisReads: () => count(ANALYSIS_PATH),
    decisionReads: () => count(DECISION_PATH),
  };
};

const newQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("decision analysis query", () => {
  test("a decision refetch keeps the finished analysis and does not ask for it again", async () => {
    const reads = mockReads([DONE]);
    const queryClient = newQueryClient();

    await queryClient.query(decisionOptions(DECISION_ID));
    await queryClient.query(decisionAnalysisOptions(DECISION_ID));

    await queryClient.invalidateQueries(publicDecisionReadFilter(DECISION_ID));
    await queryClient.refetchQueries(publicDecisionReadFilter(DECISION_ID));
    await queryClient.query(decisionOptions(DECISION_ID));

    expect(reads.decisionReads()).toBeGreaterThan(1);
    expect(
      await queryClient.query(decisionAnalysisOptions(DECISION_ID)),
    ).toEqual({ kind: "done", analysis });
    expect(reads.analysisReads()).toBe(1);
  });

  test("a run still generating is asked again until it finishes, then held", async () => {
    const reads = mockReads([GENERATING, GENERATING, DONE]);
    const queryClient = newQueryClient();
    const options = decisionAnalysisOptions(DECISION_ID);

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
