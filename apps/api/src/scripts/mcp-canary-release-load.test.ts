import { describe, expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import { mcpToolLatencyBudgetMs } from "@/api/mcp/tool-latency-budgets";

import { type CanaryFetcher, runReleaseLoadProbe } from "./mcp-canary";
import {
  jobsRunDuringLoad,
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
    const { samples, window } = await runReleaseLoad({
      decisionIds: ["a", "b"],
      now: clock.now,
      wait: async (ms) => clock.advance(ms),
      wallNow: () => 1_000_000 + clock.now(),
      durationMs: 10_000,
      concurrency: 2,
      call: async (call) => {
        called.push(call);
        clock.advance(250);
        return "answered";
      },
    });
    expect(samples.length).toBe(called.length);
    // The window is the calls' own span, from the first start to the last end.
    expect(window?.startMs).toBe(1_000_000);
    expect(window?.endMs).toBe(1_000_000 + clock.now());
    expect(called.length).toBeGreaterThanOrEqual(
      10_000 / RELEASE_LOAD.callerIntervalMs,
    );
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

  test.each([0, 20, 700])(
    "paces calls taking %s ms below the transport budget",
    async (callMs) => {
      const clock = fakeClock();
      const starts: number[] = [];
      await runReleaseLoad({
        decisionIds: ["a"],
        now: clock.now,
        wallNow: clock.now,
        wait: async (ms) => clock.advance(ms),
        durationMs: 60_000,
        concurrency: 1,
        call: async () => {
          const previous = starts.at(-1);
          if (previous !== undefined) {
            expect(clock.now() - previous).toBeGreaterThanOrEqual(
              RELEASE_LOAD.callerIntervalMs,
            );
          }
          starts.push(clock.now());
          clock.advance(callMs);
          return "answered";
        },
      });
      expect(starts.length).toBeGreaterThan(1);
      expect(starts.length * RELEASE_LOAD.concurrency).toBeLessThan(600);
      for (let index = 1; index < starts.length; index++) {
        expect(
          (starts.at(index) ?? 0) - (starts.at(index - 1) ?? 0),
        ).toBeGreaterThanOrEqual(RELEASE_LOAD.callerIntervalMs);
      }
    },
  );

  test("a rejected call is sampled and every concurrent caller settles", async () => {
    const clock = fakeClock();
    const entered = Promise.withResolvers<undefined>();
    const finish = Promise.withResolvers<undefined>();
    let calls = 0;
    let settled = false;
    const load = runReleaseLoad({
      decisionIds: ["a"],
      now: clock.now,
      wallNow: clock.now,
      durationMs: 1,
      concurrency: 2,
      call: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TypeError("Transport unavailable");
        }
        entered.resolve(undefined);
        await finish.promise;
        clock.advance(10);
        return "answered";
      },
    });
    const observed = load.then(
      (value) => {
        settled = true;
        return value;
      },
      () => {
        settled = true;
        return null;
      },
    );
    await entered.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish.resolve(undefined);
    const result = await observed;
    expect(result?.samples.map(({ outcome }) => outcome).toSorted()).toEqual([
      "answered",
      "failed",
    ]);
    expect(result?.window?.endMs).toBe(10);
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

  test("the probe requires a job run that overlaps the load itself", async () => {
    const dueAt = "2026-10-25T20:00:00.000Z";
    // The load's calls span 20:00:10 to 20:01:10.
    const window = {
      startMs: Temporal.Instant.from("2026-10-25T20:00:10.000Z")
        .epochMilliseconds,
      endMs: Temporal.Instant.from("2026-10-25T20:01:10.000Z")
        .epochMilliseconds,
    };
    const seen: string[] = [];
    const fetcherFor =
      (
        runs: readonly {
          jobId: string;
          startedAt: string;
          finishedAt: string | null;
        }[],
      ): CanaryFetcher =>
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
          return Response.json({ runs });
        }
        return Response.json({ hits: [{ decisionId: "d1" }] });
      };
    const load: typeof runReleaseLoad = async ({ decisionIds }) => {
      expect(decisionIds).toEqual(["d1"]);
      return { samples: everyTool(100), window };
    };
    const target = {
      baseUrl: "https://api.example",
      token: "canary-token",
      smokeSecret: "smoke",
    };
    const freshness = "caseLaw.reportFreshness.fiveMinute";
    const overlapping = await runReleaseLoadProbe(
      target,
      fetcherFor([
        {
          jobId: freshness,
          startedAt: "2026-10-25T20:00:40.000Z",
          finishedAt: "2026-10-25T20:00:55.000Z",
        },
      ]),
      load,
    );
    expect(overlapping.status).toBe("passed");
    expect(seen).toEqual([
      "POST /smoke/scheduled-jobs",
      "POST /v1/case/decisions/search",
      "GET /smoke/scheduled-jobs",
    ]);
    // Brought forward, run and finished while the probe was still finding
    // decisions to read: after the due time, but before the first call.
    const finishedBeforeLoad = await runReleaseLoadProbe(
      target,
      fetcherFor([
        {
          jobId: freshness,
          startedAt: "2026-10-25T20:00:01.000Z",
          finishedAt: "2026-10-25T20:00:05.000Z",
        },
      ]),
      load,
    );
    expect(finishedBeforeLoad.status).toBe("failed");
    expect(finishedBeforeLoad.detail).toContain(
      "no scheduled corpus job ran during the load",
    );
  });

  test("a run overlaps the load when it starts before the load ends and finishes after it starts", () => {
    const window = {
      startMs: Temporal.Instant.from("2026-10-25T20:00:10.000Z")
        .epochMilliseconds,
      endMs: Temporal.Instant.from("2026-10-25T20:01:10.000Z")
        .epochMilliseconds,
    };
    expect(
      jobsRunDuringLoad(
        [
          {
            jobId: "inside",
            startedAt: "2026-10-25T20:00:20.000Z",
            finishedAt: "2026-10-25T20:00:30.000Z",
          },
          {
            jobId: "spanning",
            startedAt: "2026-10-25T20:00:00.000Z",
            finishedAt: "2026-10-25T20:02:00.000Z",
          },
          {
            jobId: "running",
            startedAt: "2026-10-25T20:01:00.000Z",
            finishedAt: null,
          },
          {
            jobId: "before",
            startedAt: "2026-10-25T20:00:01.000Z",
            finishedAt: "2026-10-25T20:00:09.000Z",
          },
          {
            jobId: "after",
            startedAt: "2026-10-25T20:01:11.000Z",
            finishedAt: null,
          },
        ],
        window,
      ),
    ).toEqual(["inside", "spanning", "running"]);
  });
});
