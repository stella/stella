import { describe, expect, test } from "bun:test";

import {
  JOURNEY_PREREQUISITE,
  JOURNEY_PREREQUISITES_PATH,
} from "@stll/api-contract/journey-prerequisites";
import type { JourneyPrerequisitesReport } from "@stll/api-contract/journey-prerequisites";

import { establishJourneyPrerequisites } from "../helpers/journey-prerequisites";

const API_URL = "https://api.example.test";
const DUE_AT = "2026-11-08T20:25:00.000Z";
const JOB_ID = "sanctions.refreshSources.twoHourly";

type Call = { method: string; url: URL; headers: Record<string, string> };

/** A deployment that answers the bring-forward, then each report in turn. */
const deployment = (
  reports: readonly (JourneyPrerequisitesReport | Response)[],
  forward: Response = Response.json({ dueAt: DUE_AT, jobIds: [JOB_ID] }),
) => {
  const calls: Call[] = [];
  let polls = 0;
  let clock = 0;
  const sleeps: number[] = [];
  return {
    calls,
    sleeps,
    options: {
      apiUrl: API_URL,
      headers: { "x-edge": "edge-token" },
      journey: JOURNEY_PREREQUISITE.sanctionsScreening,
      secret: "smoke-secret",
      intervalMs: 5000,
      timeoutMs: 15_000,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      fetcher: async (
        url: URL,
        init: { method: "GET" | "POST"; headers: Record<string, string> },
      ) => {
        calls.push({ method: init.method, url, headers: init.headers });
        if (init.method === "POST") {
          return forward;
        }
        const report = reports.at(Math.min(polls, reports.length - 1));
        polls += 1;
        if (report === undefined) {
          throw new Error("The test deployment has no report left");
        }
        return report instanceof Response ? report : Response.json(report);
      },
    },
  };
};

const pending = (detail: string): JourneyPrerequisitesReport => ({
  prerequisites: [{ jobId: JOB_ID, state: "pending", detail }],
});
const ready: JourneyPrerequisitesReport = {
  prerequisites: [{ jobId: JOB_ID, state: "ready" }],
};

describe("establishJourneyPrerequisites", () => {
  test("brings the jobs forward, then polls from that instant until they are ready", async () => {
    const { calls, options, sleeps } = deployment([
      pending(`${JOB_ID} is due and not yet claimed`),
      pending(`${JOB_ID} has been running since ${DUE_AT}`),
      ready,
    ]);

    await establishJourneyPrerequisites(options);

    expect(calls.map(({ method }) => method)).toEqual([
      "POST",
      "GET",
      "GET",
      "GET",
    ]);
    const [forward, report] = calls;
    expect(forward?.url.pathname).toBe(JOURNEY_PREREQUISITES_PATH);
    expect(forward?.url.searchParams.get("journey")).toBe(
      "sanctions-screening",
    );
    expect(report?.url.searchParams.get("journey")).toBe("sanctions-screening");
    expect(report?.url.searchParams.get("since")).toBe(DUE_AT);
    for (const call of calls) {
      expect(call.headers).toEqual({
        "x-edge": "edge-token",
        "x-smoke-secret": "smoke-secret",
      });
    }
    expect(sleeps).toEqual([5000, 5000]);
  });

  test("fails at once with the job's own failure instead of waiting", async () => {
    const { calls, options } = deployment([
      {
        prerequisites: [
          {
            jobId: JOB_ID,
            state: "failed",
            detail: `${JOB_ID} ran, but eu stale (last verified 2026-11-06T05:00:00.000Z; last fetch failed 2026-11-08T20:26:00.000Z: fetch-failed)`,
          },
        ],
      },
    ]);

    let thrown: unknown;
    try {
      await establishJourneyPrerequisites(options);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain(
      "The sanctions-screening journey's scheduled jobs failed: sanctions.refreshSources.twoHourly ran, but eu stale",
    );
    expect(String(thrown)).toContain("fetch-failed");
    expect(calls).toHaveLength(2);
  });

  test("names what is still pending when the wait runs out", async () => {
    const { calls, options } = deployment([
      pending(`${JOB_ID} has been running since ${DUE_AT}`),
    ]);

    let thrown: unknown;
    try {
      await establishJourneyPrerequisites(options);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(String(thrown)).toContain(
      `did not run within 15 s: ${JOB_ID} has been running since ${DUE_AT}`,
    );
    // Polls at 0, 5, 10 and 15 s; the deadline is reached on the last.
    expect(calls.filter(({ method }) => method === "GET")).toHaveLength(4);
  });

  test("a refused bring-forward fails with the deployment's answer", async () => {
    const { calls, options } = deployment(
      [ready],
      new Response("Not available", { status: 404 }),
    );

    let thrown: unknown;
    try {
      await establishJourneyPrerequisites(options);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(String(thrown)).toContain(
      `POST ${JOURNEY_PREREQUISITES_PATH} -> 404: Not available`,
    );
    expect(calls).toHaveLength(1);
  });

  test("a report of an unexpected shape fails instead of passing", async () => {
    const { options } = deployment([
      Response.json({ prerequisites: [{ jobId: JOB_ID, state: "done" }] }),
    ]);

    let thrown: unknown;
    try {
      await establishJourneyPrerequisites(options);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(String(thrown)).toContain("answered an unexpected shape");
  });

  test("the state decides, so a failure without a detail still fails", async () => {
    const { options } = deployment([
      { prerequisites: [{ jobId: JOB_ID, state: "failed", detail: "" }] },
    ]);

    let thrown: unknown;
    try {
      await establishJourneyPrerequisites(options);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(String(thrown)).toContain(`scheduled jobs failed: ${JOB_ID}`);
  });

  test("a pending job without a detail keeps the journey waiting", async () => {
    const { calls, options } = deployment([
      { prerequisites: [{ jobId: JOB_ID, state: "pending", detail: "" }] },
      ready,
    ]);

    await establishJourneyPrerequisites(options);

    expect(calls.filter(({ method }) => method === "GET")).toHaveLength(2);
  });

  test("a report that names no job is not proof", async () => {
    const { options } = deployment([{ prerequisites: [] }]);

    let thrown: unknown;
    try {
      await establishJourneyPrerequisites(options);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(String(thrown)).toContain("answered an unexpected shape");
  });
});
