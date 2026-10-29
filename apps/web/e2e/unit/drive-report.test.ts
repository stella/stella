import { describe, expect, test } from "bun:test";

import {
  DEFAULT_VIEWPORT,
  formatSummaryTable,
  hasBlockingFindings,
  isMeasureSummary,
  type MeasureSample,
  pageTotals,
  parseDriveArgs,
  summarizeSamples,
} from "../agent/drive-report";
import type { NetworkCapture } from "../helpers/network";

const sample = (overrides: Partial<MeasureSample> = {}): MeasureSample => ({
  apiRequests: 1,
  dbQueries: 1,
  domContentLoadedMs: 100,
  largestContentfulPaintMs: 200,
  responseBytes: 1024,
  settledMs: 300,
  waterfallDepth: 1,
  ...overrides,
});

const request = (dbQueries: number | null, responseBytes: number | null) =>
  ({
    dbQueries,
    dbQueryHeaderMissing: dbQueries === null,
    method: "GET",
    pathname: "/v1/contacts",
    responseBytes,
    responseBodyReadFailure: null,
  }) satisfies NetworkCapture["requests"][number];

describe("parseDriveArgs", () => {
  test("snap takes several paths and the defaults", () => {
    expect(parseDriveArgs(["snap", "/workspaces", "/chat/new"])).toEqual({
      type: "ok",
      args: {
        command: "snap",
        options: {
          colorScheme: "light",
          compare: undefined,
          fullPage: false,
          flows: "all",
          samples: 3,
          save: undefined,
          viewport: DEFAULT_VIEWPORT,
          waitFor: undefined,
        },
        targets: ["/workspaces", "/chat/new"],
      },
    });
  });

  test("census takes no target and accepts a sample count", () => {
    expect(
      parseDriveArgs(["census", "--samples", "5", "--flows", "matter,chat"]),
    ).toMatchObject({
      type: "ok",
      args: {
        command: "census",
        targets: [],
        options: { samples: 5, flows: "matter,chat" },
      },
    });
    expect(parseDriveArgs(["census"])).toMatchObject({
      type: "ok",
      args: { options: { samples: 3 } },
    });
  });

  test("measure reads its flags", () => {
    const parsed = parseDriveArgs([
      "measure",
      "/workspaces",
      "--samples",
      "5",
      "--save",
      "before",
      "--viewport",
      "1280x720",
      "--color-scheme",
      "dark",
    ]);

    expect(parsed).toMatchObject({
      type: "ok",
      args: {
        options: {
          colorScheme: "dark",
          samples: 5,
          save: "before",
          viewport: { height: 720, width: 1280 },
        },
      },
    });
  });

  test.each([
    [[], "Unknown command"],
    [["census", "/workspaces"], "does not take targets"],
    [["census", "--flows", "../chat"], "comma-separated flow names"],
    [["run", "flow.ts", "--flows", "chat"], "only applies to census"],
    [["census", "--save", "before"], "only apply to measure"],
    [["census", "--compare", "before"], "only apply to measure"],
    [["snap"], "needs at least one target"],
    [["snap", "workspaces"], "must start with /"],
    [["measure", "/a", "/b"], "exactly one target"],
    [["snap", "/a", "--viewport", "wide"], "--viewport"],
    [["snap", "/a", "--color-scheme", "sepia"], "--color-scheme"],
    [["measure", "/a", "--samples", "0"], "--samples"],
    [["measure", "/a", "--save", "../x"], "file-safe label"],
    [["snap", "/a", "--samples", "2"], "only apply to measure"],
    [["snap", "/a", "--wait-for"], "requires a value"],
    [["snap", "/a", "--bogus"], "Unknown flag"],
  ])("rejects %j", (argv, message) => {
    const parsed = parseDriveArgs(argv);

    expect(parsed.type).toBe("error");
    if (parsed.type === "error") {
      expect(parsed.message).toContain(message);
    }
  });

  test("run accepts a script path that is not an app path", () => {
    expect(parseDriveArgs(["run", "checks/flow.ts"])).toMatchObject({
      type: "ok",
      args: { command: "run", targets: ["checks/flow.ts"] },
    });
  });
});

describe("hasBlockingFindings", () => {
  const none = {
    browserErrors: [],
    failedRequests: [],
    navigationProblems: [],
  };

  test("a 4xx alone does not block, a 5xx does", () => {
    expect(
      hasBlockingFindings({ ...none, failedRequests: ["GET /v1/x -> 404"] }),
    ).toBe(false);
    expect(
      hasBlockingFindings({ ...none, failedRequests: ["GET /v1/x -> 502"] }),
    ).toBe(true);
  });

  test("browser errors and navigation problems block", () => {
    expect(
      hasBlockingFindings({ ...none, browserErrors: ["pageerror: x"] }),
    ).toBe(true);
    expect(
      hasBlockingFindings({ ...none, navigationProblems: ["redirected"] }),
    ).toBe(true);
  });
});

describe("pageTotals", () => {
  test("counts a repeated endpoint every time it is called", () => {
    expect(
      pageTotals({
        depthChain: [],
        requests: [request(3, 1000), request(3, 1000), request(null, null)],
      }),
    ).toEqual({ apiRequests: 3, dbQueries: 6, responseBytes: 2000 });
  });
});

describe("summarizeSamples", () => {
  test("takes medians for timings and counts, the maximum for depth", () => {
    const summary = summarizeSamples("/workspaces", [
      sample({
        dbQueries: 4,
        responseBytes: 2048,
        settledMs: 900,
        waterfallDepth: 2,
      }),
      sample({
        apiRequests: 2,
        dbQueries: 6,
        largestContentfulPaintMs: null,
        responseBytes: 4096,
        settledMs: 300,
        waterfallDepth: 3,
      }),
      sample({
        dbQueries: 5,
        largestContentfulPaintMs: 400,
        responseBytes: 3072,
        settledMs: 500,
        waterfallDepth: 2,
      }),
    ]);

    expect(summary).toEqual({
      apiRequests: 1,
      dbQueries: 5,
      domContentLoadedMs: 100,
      largestContentfulPaintMs: 300,
      path: "/workspaces",
      responseKiB: 3,
      samples: 3,
      settledMs: 500,
      spreadMs: {
        domContentLoadedMs: 0,
        largestContentfulPaintMs: 200,
        settledMs: 600,
      },
      waterfallDepth: 3,
    });
    expect(isMeasureSummary(summary)).toBe(true);
  });
});

describe("formatSummaryTable", () => {
  test("shows deltas against a saved measurement", () => {
    const before = summarizeSamples("/a", [sample({ settledMs: 400 })]);
    const after = summarizeSamples("/a", [sample({ settledMs: 300 })]);

    expect(
      formatSummaryTable(after, { label: "before", summary: before }),
    ).toContain("| Settled (ms) | 400 | 300 | -100 (-25%) |");
  });

  test("marks a timing delta inside the sample spread as noise", () => {
    const before = summarizeSamples("/a", [
      sample({ settledMs: 300 }),
      sample({ settledMs: 500 }),
    ]);
    const after = summarizeSamples("/a", [
      sample({ settledMs: 350 }),
      sample({ settledMs: 370 }),
    ]);

    expect(
      formatSummaryTable(after, { label: "before", summary: before }),
    ).toContain("| Settled (ms) | 400 | 360 | -40 (-10%), within noise |");
  });
});
