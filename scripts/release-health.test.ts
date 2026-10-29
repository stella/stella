import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildQuery,
  evaluateRelease,
  gatePromotion,
  previousRelease,
  RELEASE_HEALTH_ASSET,
  summarize,
  windowEnd,
} from "./release-health";

const FIXTURES = path.join(import.meta.dir, "__fixtures__/release-health");
const RELEASE = "v1.4.1";
const PREVIOUS_RELEASE = "v1.4.0";
const CHECKED_AT = "2026-10-17T13:00:00Z";

const recorded = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf-8"));

const evaluateFixture = (name: string) =>
  evaluateRelease({
    release: RELEASE,
    baselineRelease: PREVIOUS_RELEASE,
    response: recorded(name),
    checkedAt: CHECKED_AT,
  });

describe("post-release regression check", () => {
  test("a fingerprint the previous release never produced fires", () => {
    const evaluation = evaluateFixture("new-fingerprint");

    expect(evaluation.verdict).toEqual({
      verdict: "unhealthy",
      release: RELEASE,
      checkedAt: CHECKED_AT,
      findings: 1,
    });
    expect(evaluation.findings).toEqual([
      {
        type: "new_fingerprint",
        fingerprint: {
          handler: "/v1/summaries",
          errorClass: "SummaryGenerationError",
          errorCode: "model_output_incomplete",
        },
        occurrences: 10,
      },
    ]);
  });

  const currentOnlyResponse = {
    columns: [
      "release",
      "kind",
      "handler",
      "error_class",
      "error_code",
      "failure_reason",
      "occurrences",
    ],
    hasMore: false,
    results: [
      [
        "1.4.1",
        "fingerprint",
        "/v1/summaries",
        "SummaryGenerationError",
        "model_output_incomplete",
        "model_output_incomplete",
        10,
      ],
    ],
  };

  test("the first release has no baseline, so no fingerprint is new", () => {
    const evaluation = evaluateRelease({
      release: RELEASE,
      baselineRelease: null,
      response: currentOnlyResponse,
      checkedAt: CHECKED_AT,
    });

    expect(evaluation.findings).toEqual([]);
    expect(evaluation.verdict.verdict).toBe("healthy");
  });

  test("a previous release without failures makes every fingerprint new", () => {
    const evaluation = evaluateRelease({
      release: RELEASE,
      baselineRelease: PREVIOUS_RELEASE,
      response: currentOnlyResponse,
      checkedAt: CHECKED_AT,
    });

    expect(evaluation.findings.map(({ type }) => type)).toEqual([
      "new_fingerprint",
    ]);
    expect(evaluation.verdict.verdict).toBe("unhealthy");
  });

  test("known fingerprints and new ones below the threshold do not fire", () => {
    const evaluation = evaluateFixture("known-fingerprint");

    expect(evaluation.findings).toEqual([]);
    expect(evaluation.verdict.verdict).toBe("healthy");
  });

  test("an unclassified failure fires even when the previous release had it", () => {
    const evaluation = evaluateFixture("unclassified");

    expect(evaluation.findings).toEqual([
      {
        type: "unclassified",
        fingerprint: {
          handler: "/v1/summaries",
          errorClass: "HandlerError",
          errorCode: "HandlerError",
        },
        occurrences: 1,
      },
    ]);
    expect(evaluation.verdict.verdict).toBe("unhealthy");
  });

  test("failures past the fingerprint budget fire, since none can be compared", () => {
    expect(evaluateFixture("overflow").findings).toEqual([
      { type: "overflow", occurrences: 12 },
    ]);
  });

  test("a failed, malformed or full query is inconclusive, never healthy", () => {
    const valid = recorded("known-fingerprint");
    if (typeof valid !== "object" || valid === null) {
      throw new TypeError("fixture must be an object");
    }
    const cases = [
      { response: null, cause: "query_failed" },
      { response: { ...valid, columns: ["release"] }, cause: "result_invalid" },
      {
        response: { ...valid, results: [["1.4.1", "fingerprint", null]] },
        cause: "result_invalid",
      },
      {
        response: {
          ...valid,
          results: Array.from({ length: 10_000 }, () => [
            "1.4.1",
            "overflow",
            null,
            null,
            null,
            null,
            1,
          ]),
        },
        cause: "result_truncated",
      },
    ] as const;
    for (const { response, cause } of cases) {
      expect(
        evaluateRelease({
          release: RELEASE,
          baselineRelease: PREVIOUS_RELEASE,
          response,
          checkedAt: CHECKED_AT,
        }).verdict,
      ).toEqual({
        verdict: "inconclusive",
        release: RELEASE,
        checkedAt: CHECKED_AT,
        cause,
      });
    }
  });

  test("the summary names fingerprints but never counts", () => {
    const summary = summarize(evaluateFixture("new-fingerprint"));

    expect(summary).toContain("v1.4.1 is unhealthy");
    expect(summary).toContain("`/v1/summaries` SummaryGenerationError");
    expect(summary).not.toContain("10");
  });

  test("the generated environment predicate excludes staging RC traffic", () => {
    const { query } = buildQuery({
      release: RELEASE,
      previous: PREVIOUS_RELEASE,
      until: CHECKED_AT,
    });
    const predicate = query.query
      .split("\n")
      .find((line) => line.includes("properties.deploy_environment"));
    expect(predicate).toBe("AND properties.deploy_environment = {environment}");
    if (predicate === undefined) {
      throw new TypeError(
        "Release health query has no deployment environment predicate",
      );
    }
    const environment = query.values["environment"];
    if (environment === undefined) {
      throw new TypeError("Release health query has no environment binding");
    }
    const database = new Database(":memory:");
    try {
      database.run(
        "CREATE TABLE properties (deploy_environment TEXT, occurrences INTEGER)",
      );
      database.run(
        "INSERT INTO properties VALUES ('staging', 999), ('production', 7), (NULL, 500)",
      );
      const rows = database
        .query(
          `SELECT SUM(occurrences) AS occurrences FROM properties WHERE ${predicate.replace(/^AND /u, "").replace("{environment}", "$environment")}`,
        )
        .all({ $environment: environment });
      expect(rows).toEqual([{ occurrences: 7 }]);
    } finally {
      database.close();
    }
  });

  test("versions travel as placeholders, without the tag prefix", () => {
    const { query } = buildQuery({
      release: RELEASE,
      previous: "v1.4.0",
      until: CHECKED_AT,
    });

    expect(query.values).toEqual({
      event: "release_failure_window",
      environment: "production",
      until: CHECKED_AT,
      version_0: "1.4.1",
      version_1: "1.4.0",
    });
    expect(query.query).not.toContain("1.4");
    expect(query.query).toContain(
      "AND properties.deploy_environment = {environment}",
    );
    expect(() =>
      buildQuery({ release: "v1.4.1'", previous: null, until: CHECKED_AT }),
    ).toThrow("is not a stable release ref");
  });
});

const release = (
  tag: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: "2026-10-01T10:00:00Z",
  assets: [],
  ...overrides,
});

describe("previous release", () => {
  test("is the highest published stable release below the current one", () => {
    const releases = [
      release("v1.5.0"),
      release("v1.4.1"),
      release("v1.4.0-rc.2", { prerelease: true }),
      release("v1.3.10", {
        assets: [{ id: 77, name: RELEASE_HEALTH_ASSET }],
      }),
      release("v1.3.9"),
      release("v1.4.0", { draft: true }),
    ];

    expect(previousRelease("v1.4.1", releases)).toEqual({
      tag: "v1.3.10",
      publishedAt: "2026-10-01T10:00:00Z",
      verdictAssetId: 77,
    });
    expect(previousRelease("v1.3.9", releases)).toBeNull();
  });

  test("the window closes an hour after publication", () => {
    expect(windowEnd("2026-10-17T12:00:00Z")).toBe("2026-10-17T13:00:00.000Z");
  });
});

describe("promote gate", () => {
  const previous = {
    tag: "v1.4.0",
    publishedAt: "2026-10-17T10:00:00Z",
    verdictAssetId: 1,
  };
  const now = "2026-10-17T12:00:00Z";
  const verdict = (value: string) => ({
    verdict: value,
    release: "v1.4.0",
    checkedAt: "2026-10-17T11:01:00Z",
  });

  test("refuses after an unhealthy or inconclusive release unless acknowledged", () => {
    for (const recordedVerdict of ["unhealthy", "inconclusive"] as const) {
      expect(
        gatePromotion({
          previous,
          verdict: verdict(recordedVerdict),
          acknowledged: "",
          now,
        }),
      ).toEqual({ type: "refuse", reason: recordedVerdict });
      expect(
        gatePromotion({
          previous,
          verdict: verdict(recordedVerdict),
          acknowledged: "v1.3.9",
          now,
        }),
      ).toEqual({ type: "refuse", reason: recordedVerdict });
      expect(
        gatePromotion({
          previous,
          verdict: verdict(recordedVerdict),
          acknowledged: "v1.4.0",
          now,
        }),
      ).toEqual({ type: "pass", reason: "acknowledged" });
    }
  });

  test("passes a healthy release and none at all", () => {
    expect(
      gatePromotion({
        previous,
        verdict: verdict("healthy"),
        acknowledged: "",
        now,
      }),
    ).toEqual({ type: "pass", reason: "healthy" });
    expect(
      gatePromotion({ previous: null, verdict: null, acknowledged: "", now }),
    ).toEqual({ type: "pass", reason: "no_previous_release" });
  });

  test("waits for a verdict while the window and its check can still run", () => {
    expect(
      gatePromotion({
        previous,
        verdict: null,
        acknowledged: "",
        now: "2026-10-17T11:20:00Z",
      }),
    ).toEqual({ type: "refuse", reason: "window_open" });
    expect(
      gatePromotion({ previous, verdict: null, acknowledged: "", now }),
    ).toEqual({ type: "pass", reason: "no_verdict" });
  });

  test("rejects a verdict recorded for another release", () => {
    expect(() =>
      gatePromotion({
        previous,
        verdict: { ...verdict("healthy"), release: "v1.3.9" },
        acknowledged: "",
        now,
      }),
    ).toThrow("names another release");
  });
});

describe("command line", () => {
  test("evaluate writes the verdict and appends the summary", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "release-health-"));
    const verdictFile = path.join(directory, RELEASE_HEALTH_ASSET);
    const summaryFile = path.join(directory, "summary.md");
    writeFileSync(summaryFile, "");

    const result = Bun.spawnSync([
      "bun",
      path.join(import.meta.dir, "release-health.ts"),
      "evaluate",
      "--release",
      RELEASE,
      "--result",
      path.join(FIXTURES, "unclassified.json"),
      "--now",
      CHECKED_AT,
      "--verdict",
      verdictFile,
      "--summary",
      summaryFile,
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(verdictFile, "utf-8"))).toEqual({
      verdict: "unhealthy",
      release: RELEASE,
      checkedAt: CHECKED_AT,
      findings: 1,
    });
    expect(readFileSync(summaryFile, "utf-8")).toContain(
      "unclassified failure",
    );
  });
});
