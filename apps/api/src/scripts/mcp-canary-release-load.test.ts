import { describe, expect, test } from "bun:test";

import { mcpToolLatencyBudgetMs } from "@/api/mcp/tool-latency-budgets";

import { type CanaryFetcher, runReleaseLoadProbe } from "./mcp-canary";
import {
  jobsRunSince,
  judgeReleaseLoad,
  nearestRankPercentile,
  RELEASE_LOAD,
  type ReleaseLoadCall,
  releaseLoadRound,
  type ReleaseLoadSample,
  runReleaseLoad,
} from "./mcp-canary-release-load";

/** A clock that only moves when a call takes time. */
const fakeClock = () => {
  let current = 0;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
};

const samplesOf = (
  toolName: ReleaseLoadSample["toolName"],
  elapsed: readonly number[],
): ReleaseLoadSample[] =>
  elapsed.map((elapsedMs) => ({ toolName, elapsedMs, outcome: "answered" }));

const everyTool = (elapsedMs: number, count = 20): ReleaseLoadSample[] =>
  (
    [
      "search_legislation",
      "search_case_law",
      "case_law_coverage",
      "read_case_law_decision",
    ] as const
  ).flatMap((toolName) =>
    samplesOf(
      toolName,
      Array.from({ length: count }, () => elapsedMs),
    ),
  );

describe("release load", () => {
  test("callers run the four heavy tools in turn until the duration ends", async () => {
    const clock = fakeClock();
    const called: ReleaseLoadCall[] = [];
    const samples = await runReleaseLoad({
      decisionIds: ["a", "b"],
      now: clock.now,
      durationMs: 10_000,
      concurrency: 2,
      call: async (call) => {
        called.push(call);
        clock.advance(250);
        return "answered";
      },
    });
    expect(samples.length).toBe(called.length);
    expect(called.length).toBeGreaterThanOrEqual(10_000 / 250);
    expect(new Set(called.map(({ toolName }) => toolName))).toEqual(
      new Set([
        "search_legislation",
        "search_case_law",
        "case_law_coverage",
        "read_case_law_decision",
      ]),
    );
    // Inputs rotate, so the load is not one cached answer repeated.
    const queries = new Set(
      called
        .filter(({ toolName }) => toolName === "search_legislation")
        .map(({ arguments: args }) => args["query"]),
    );
    expect(queries.size).toBeGreaterThan(1);
    expect(clock.now()).toBeLessThan(10_000 + 2 * 250);
  });

  test("a round without a decision to read omits that tool", () => {
    expect(releaseLoadRound(0, []).map(({ toolName }) => toolName)).toEqual([
      "search_legislation",
      "search_case_law",
      "case_law_coverage",
    ]);
  });

  test("the nearest-rank 95th percentile of twenty samples is the nineteenth", () => {
    const values = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(nearestRankPercentile(values, 95)).toBe(19);
    expect(nearestRankPercentile([7], 95)).toBe(7);
  });

  test("every tool within its budget passes", () => {
    expect(judgeReleaseLoad(everyTool(100)).failures).toEqual([]);
  });

  test("a tool whose p95 is over its budget fails, naming the tool", () => {
    const budget = mcpToolLatencyBudgetMs("case_law_coverage");
    const samples = [
      ...everyTool(100).filter(
        ({ toolName }) => toolName !== "case_law_coverage",
      ),
      ...samplesOf("case_law_coverage", [
        ...Array.from({ length: 18 }, () => 100),
        budget + 1,
        budget + 1,
      ]),
    ];
    expect(judgeReleaseLoad(samples).failures).toEqual([
      `case_law_coverage p95 ${String(budget + 1)} ms is over its ${String(budget)} ms budget`,
    ]);
  });

  test("failed, rate-limited and missing calls fail the load", () => {
    const samples: ReleaseLoadSample[] = [
      ...everyTool(100).filter(
        ({ toolName }) =>
          toolName !== "search_case_law" &&
          toolName !== "read_case_law_decision",
      ),
      ...samplesOf(
        "search_case_law",
        Array.from({ length: 10 }, () => 100),
      ),
      { toolName: "search_case_law", elapsedMs: 5, outcome: "failed" },
      { toolName: "search_case_law", elapsedMs: 5, outcome: "rate_limited" },
    ];
    expect(judgeReleaseLoad(samples).failures).toEqual([
      "search_case_law had 1 failed and 1 rate-limited calls",
      `read_case_law_decision answered 0 calls, fewer than ${String(RELEASE_LOAD.minSamplesPerTool)}`,
    ]);
  });

  test("the probe brings the jobs forward, loads, and requires a job inside the window", async () => {
    const dueAt = "2026-10-25T20:00:00.000Z";
    const seen: string[] = [];
    const fetcherFor =
      (lastRunAt: string | null): CanaryFetcher =>
      async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        const method = input instanceof Request ? input.method : init.method;
        seen.push(`${method ?? "GET"} ${url.pathname}`);
        if (url.pathname === "/smoke/scheduled-jobs" && method === "POST") {
          return Response.json({ dueAt, jobs: [] });
        }
        if (url.pathname === "/smoke/scheduled-jobs") {
          return Response.json({
            jobs: [
              {
                id: "caseLaw.reportFreshness.fiveMinute",
                lastRunAt,
                lockedAt: null,
              },
            ],
          });
        }
        return Response.json({ hits: [{ decisionId: "d1" }] });
      };
    const load: typeof runReleaseLoad = async ({ decisionIds }) => {
      expect(decisionIds).toEqual(["d1"]);
      return everyTool(100);
    };
    const target = {
      baseUrl: "https://api.example",
      token: "canary-token",
      smokeSecret: "smoke",
    };
    const overlapping = await runReleaseLoadProbe(
      target,
      fetcherFor("2026-10-25T20:00:30.000Z"),
      load,
    );
    expect(overlapping.status).toBe("passed");
    expect(seen).toEqual([
      "POST /smoke/scheduled-jobs",
      "POST /v1/case/decisions/search",
      "GET /smoke/scheduled-jobs",
    ]);
    const missed = await runReleaseLoadProbe(
      target,
      fetcherFor("2026-10-25T19:00:00.000Z"),
      load,
    );
    expect(missed.status).toBe("failed");
    expect(missed.detail).toContain(
      "no scheduled corpus job ran during the load",
    );
  });

  test("only jobs that started at or after the due time count as overlapping", () => {
    const dueAt = "2026-10-25T20:00:00.000Z";
    expect(
      jobsRunSince(
        [
          { id: "ran", lastRunAt: "2026-10-25T20:00:20.000Z", lockedAt: null },
          {
            id: "running",
            lastRunAt: "2026-10-25T19:00:00.000Z",
            lockedAt: "2026-10-25T20:00:40.000Z",
          },
          {
            id: "earlier",
            lastRunAt: "2026-10-25T19:59:00.000Z",
            lockedAt: null,
          },
          { id: "never", lastRunAt: null, lockedAt: null },
        ],
        dueAt,
      ),
    ).toEqual(["ran", "running"]);
  });
});
