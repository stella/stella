import { describe, expect, test } from "bun:test";

import {
  type CanaryFetcher,
  RESEARCH_CANARY_DECISION_ID,
  runResearchColumnJourney,
} from "./mcp-canary";

const API_URL = "https://api.example";
const APP_URL = "https://app.example";
const EMAIL = "review@stll.app";
const COLUMN_ID = "44444444-4444-4444-8444-444444444444";

type Cell = { state: string; failureReason: string | null };

type Observed = { method: string; path: string; body: string; cookie: string };

/**
 * The browser API as the research journey sees it: sign-in sets the session
 * cookie on the app origin, and every research route answers only with it.
 * `cells` is what successive lookups report for the per-run column.
 */
const researchFetcher = (
  cells: readonly Cell[],
  observed: Observed[],
): CanaryFetcher => {
  let lookups = 0;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : "";
    const cookie = headers.get("cookie") ?? "";
    observed.push({ method, path: url.pathname, body, cookie });
    if (url.origin !== APP_URL) {
      return new Response(null, { status: 404 });
    }
    if (url.pathname === "/api/auth/sign-in/email") {
      return Response.json(
        { user: { email: EMAIL } },
        { headers: { "set-cookie": "session=review-cookie; Path=/" } },
      );
    }
    if (cookie !== "session=review-cookie") {
      return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
    }
    switch (`${method} ${url.pathname}`) {
      case "GET /api/auth/get-session":
        return Response.json({
          user: { email: EMAIL },
          session: { activeOrganizationId: "org_review" },
        });
      case "POST /api/v1/case/research/columns":
        return Response.json({ id: COLUMN_ID });
      case "POST /api/v1/case/research/answers/run":
        return Response.json({ queued: 1 });
      case "POST /api/v1/case/research/answers/lookup": {
        const cell = cells[Math.min(lookups, cells.length - 1)];
        lookups += 1;
        return Response.json({
          items: [
            {
              columnId: COLUMN_ID,
              decisionId: RESEARCH_CANARY_DECISION_ID,
              updatedAt: "2026-11-04T00:00:00.000Z",
              ...cell,
            },
          ],
        });
      }
      case `DELETE /api/v1/case/research/columns/${COLUMN_ID}`:
        return Response.json({ success: true });
      default:
        return new Response(null, { status: 404 });
    }
  };
};

const runJourney = async (cells: readonly Cell[]) => {
  const observed: Observed[] = [];
  const waits: number[] = [];
  let clock = 0;
  const results = await runResearchColumnJourney(
    {
      baseUrl: API_URL,
      configuredBaseUrl: API_URL,
      frontendUrl: APP_URL,
      email: EMAIL,
      password: "review-password-secret",
      mode: "full",
      environment: "production",
      wait: async (ms) => {
        waits.push(ms);
        clock += ms;
        await Promise.resolve();
      },
      now: () => clock,
    },
    researchFetcher(cells, observed),
  );
  return { results, observed, waits };
};

const failures = (results: readonly { status: string; name: string }[]) =>
  results.filter(({ status }) => status === "failed").map(({ name }) => name);

describe("case-law research column journey", () => {
  test("asks one question of the known decision and passes once it is answered", async () => {
    const { results, observed, waits } = await runJourney([
      { state: "pending", failureReason: null },
      { state: "answered", failureReason: null },
    ]);
    expect(failures(results)).toEqual([]);
    expect(results.map(({ name }) => name)).toEqual([
      "case-law research column: sign-in",
      "case-law research column: session",
      "case-law research column: create column",
      "case-law research column: run",
      "case-law research column: answer",
      "case-law research column: delete column",
    ]);
    expect(waits).toEqual([5000]);
    const run = observed.find(({ path }) => path.endsWith("/answers/run"));
    expect(JSON.parse(run?.body ?? "null")).toEqual({
      columnIds: [COLUMN_ID],
      decisionIds: [RESEARCH_CANARY_DECISION_ID],
      force: true,
    });
  });

  test("fails on a failed cell, naming the reason, and still deletes the column", async () => {
    const { results, observed } = await runJourney([
      { state: "failed", failureReason: "decision_unavailable" },
    ]);
    expect(failures(results)).toEqual(["case-law research column: answer"]);
    expect(
      results.find(({ name }) => name === "case-law research column: answer")
        ?.detail,
    ).toContain("failed (decision_unavailable)");
    expect(
      observed.some(
        ({ method, path }) =>
          method === "DELETE" && path.endsWith(`/columns/${COLUMN_ID}`),
      ),
    ).toBe(true);
  });

  test("fails a cell that never settles within the deadline", async () => {
    const { results, waits } = await runJourney([
      { state: "pending", failureReason: null },
    ]);
    expect(failures(results)).toEqual(["case-law research column: answer"]);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(180_000);
  });

  test("runs only in production full mode, against the configured endpoint", async () => {
    const fetcher = researchFetcher([], []);
    expect(
      await runResearchColumnJourney(
        {
          baseUrl: API_URL,
          configuredBaseUrl: API_URL,
          frontendUrl: APP_URL,
          password: "review-password-secret",
          mode: "frequent",
          environment: "production",
        },
        fetcher,
      ),
    ).toEqual([]);
    expect(
      await runResearchColumnJourney(
        {
          baseUrl: "https://elsewhere.example",
          configuredBaseUrl: API_URL,
          frontendUrl: APP_URL,
          password: "review-password-secret",
          mode: "full",
          environment: "production",
        },
        fetcher,
      ),
    ).toMatchObject([{ status: "skipped" }]);
    // Staging and the served CI bundle hold neither the decision nor a model.
    expect(
      await runResearchColumnJourney(
        {
          baseUrl: API_URL,
          configuredBaseUrl: API_URL,
          frontendUrl: APP_URL,
          password: "review-password-secret",
          mode: "full",
          environment: "staging",
        },
        fetcher,
      ),
    ).toMatchObject([{ status: "not_applicable" }]);
  });
});
