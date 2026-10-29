import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  baselineEnvironment,
  buildQuery,
  evaluateRelease,
  gatePromotion,
  previousRelease,
  readPrivateRecord,
  readPublicRecord,
  RELEASE_HEALTH_ASSET,
  summarize,
  windowEnd,
} from "./release-health";

const FIXTURES = path.join(import.meta.dir, "__fixtures__/release-health");
const RELEASE = "v1.4.1";
const PREVIOUS_RELEASE = "v1.4.0";
/** Published after environments were recorded: read for production alone. */
const RECORDED_BASELINE = {
  ref: PREVIOUS_RELEASE,
  publishedAt: "2026-10-29T05:00:00Z",
};
/** Its window closed before environments were recorded. */
const LEGACY_BASELINE = {
  ref: PREVIOUS_RELEASE,
  publishedAt: "2026-10-27T11:51:20Z",
};
const CHECKED_AT = "2026-10-17T13:00:00Z";
const PRIVATE_BASELINE = {
  ref: PREVIOUS_RELEASE,
  publishedAt: "2026-10-17T12:00:00Z",
};

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

  test("the public summary exposes only the verdict, count and opaque reference", () => {
    const summary = summarize(evaluateFixture("new-fingerprint"));

    expect(summary).toContain("v1.4.1 is unhealthy");
    expect(summary).toContain("Findings: 1");
    expect(summary).toContain("release-health:v1.4.1");
    for (const detail of [
      "/v1/summaries",
      "SummaryGenerationError",
      "model_output_incomplete",
    ]) {
      expect(summary).not.toContain(detail);
    }
    expect(summary).not.toContain("10");
  });

  test("the generated environment predicate excludes staging RC traffic", () => {
    const { query } = buildQuery({
      release: RELEASE,
      previous: RECORDED_BASELINE,
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

  test("a legacy baseline counts its unrecorded events, the checked release never does", () => {
    const { query } = buildQuery({
      release: RELEASE,
      previous: LEGACY_BASELINE,
      until: CHECKED_AT,
    });
    const predicate = query.query
      .split("\n")
      .find((line) => line.includes("properties.deploy_environment"));
    if (predicate === undefined) {
      throw new TypeError(
        "Release health query has no deployment environment predicate",
      );
    }
    const database = new Database(":memory:");
    try {
      database.run(
        "CREATE TABLE properties (deploy_environment TEXT, app_version TEXT, occurrences INTEGER)",
      );
      database.run(
        "INSERT INTO properties VALUES ('staging', '1.4.0', 999), ('production', '1.4.0', 7), (NULL, '1.4.0', 500), (NULL, '1.4.1', 300), ('production', '1.4.1', 2)",
      );
      const sql = predicate
        .replace(/^AND /u, "")
        .replaceAll("properties.", "")
        .replaceAll("{environment}", "$environment")
        .replaceAll("{version_1}", "$baseline");
      const sum = (version: string) =>
        database
          .query(
            `SELECT SUM(occurrences) AS occurrences FROM properties WHERE app_version = $version AND ${sql}`,
          )
          .all({
            $environment: "production",
            $baseline: "1.4.0",
            $version: version,
          });
      expect(sum("1.4.0")).toEqual([{ occurrences: 507 }]);
      expect(sum("1.4.1")).toEqual([{ occurrences: 2 }]);
    } finally {
      database.close();
    }
  });

  test("only a baseline whose window closed before environments were recorded is legacy", () => {
    expect(baselineEnvironment(LEGACY_BASELINE)).toBe("unrecorded");
    expect(baselineEnvironment(RECORDED_BASELINE)).toBe("recorded");
    // Its window closes after the cutoff, so it stays production-only.
    expect(
      baselineEnvironment({
        ref: PREVIOUS_RELEASE,
        publishedAt: "2026-10-29T04:00:00Z",
      }),
    ).toBe("recorded");
    const recordedQuery = buildQuery({
      release: RELEASE,
      previous: RECORDED_BASELINE,
      until: CHECKED_AT,
    });
    expect(recordedQuery.query.query).not.toContain("IS NULL");
  });

  test("versions travel as placeholders, without the tag prefix", () => {
    const { query } = buildQuery({
      release: RELEASE,
      previous: RECORDED_BASELINE,
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
    ...(value === "unhealthy" ? { findings: 1 } : {}),
    ...(value === "inconclusive" ? { cause: "query_failed" } : {}),
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
  test("evaluate preserves every finding privately and publishes only metadata", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "release-health-"));
    try {
      const verdictFile = path.join(directory, RELEASE_HEALTH_ASSET);
      const summaryFile = path.join(directory, "summary.md");
      const recordFile = path.join(directory, "private.json");
      const resultFile = path.join(directory, "query.json");
      const fixtures = ["unclassified", "new-fingerprint", "overflow"].map(
        recorded,
      );
      const response = {
        columns: [
          "release",
          "kind",
          "handler",
          "error_class",
          "error_code",
          "failure_reason",
          "occurrences",
        ],
        results: fixtures.flatMap((fixture) => {
          if (
            typeof fixture !== "object" ||
            fixture === null ||
            !("results" in fixture) ||
            !Array.isArray(fixture.results)
          ) {
            throw new TypeError("fixture requires results");
          }
          return fixture.results;
        }),
      };
      const evaluation = evaluateRelease({
        release: RELEASE,
        baselineRelease: PREVIOUS_RELEASE,
        checkedAt: CHECKED_AT,
        response,
      });
      expect(new Set(evaluation.findings.map(({ type }) => type))).toEqual(
        new Set(["unclassified", "new_fingerprint", "overflow"]),
      );
      writeFileSync(resultFile, JSON.stringify(response));
      writeFileSync(summaryFile, "existing summary\n");
      const result = Bun.spawnSync([
        "bun",
        path.join(import.meta.dir, "release-health.ts"),
        "evaluate",
        "--release",
        RELEASE,
        "--previous",
        PREVIOUS_RELEASE,
        "--previous-published-at",
        PRIVATE_BASELINE.publishedAt,
        "--result",
        resultFile,
        "--now",
        CHECKED_AT,
        "--until",
        CHECKED_AT,
        "--record",
        recordFile,
        "--verdict",
        verdictFile,
        "--summary",
        summaryFile,
      ]);
      expect(result.exitCode).toBe(0);
      const publicJson = readFileSync(verdictFile, "utf-8");
      expect(JSON.parse(publicJson)).toEqual({
        ...evaluation.verdict,
        findings: evaluation.findings.length,
        record: `release-health:${RELEASE}`,
      });
      expect(
        readPrivateRecord(JSON.parse(readFileSync(recordFile, "utf-8"))),
      ).toEqual({
        version: 1,
        verdict: evaluation.verdict,
        baseline: { release: PREVIOUS_RELEASE, environment: "unrecorded" },
        query: buildQuery({
          release: RELEASE,
          previous: PRIVATE_BASELINE,
          until: CHECKED_AT,
        }).query,
        window: {
          start: "2026-10-17T12:00:00.000Z",
          end: CHECKED_AT,
          baselineLookbackDays: 14,
        },
        findings: evaluation.findings,
      });
      const summary = readFileSync(summaryFile, "utf-8");
      expect(summary).toBe(`existing summary\n${summarize(evaluation)}`);
      for (const finding of evaluation.findings) {
        if (finding.type === "overflow") {
          continue;
        }
        for (const detail of Object.values(finding.fingerprint)) {
          expect(publicJson).not.toContain(detail);
          expect(summary).not.toContain(detail);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

const privateRecord = () =>
  ({
    version: 1,
    verdict: {
      verdict: "unhealthy",
      release: RELEASE,
      checkedAt: CHECKED_AT,
      findings: 3,
    },
    baseline: { release: PREVIOUS_RELEASE, environment: "unrecorded" },
    query: buildQuery({
      release: RELEASE,
      previous: PRIVATE_BASELINE,
      until: CHECKED_AT,
    }).query,
    window: {
      start: "2026-10-17T12:00:00Z",
      end: CHECKED_AT,
      baselineLookbackDays: 14,
    },
    findings: [
      ...evaluateFixture("unclassified").findings,
      ...evaluateFixture("new-fingerprint").findings,
      ...evaluateFixture("overflow").findings,
    ],
  }) as const satisfies ReturnType<typeof readPrivateRecord>;

describe("persisted release health records", () => {
  test("legacy count-only assets have unknown detail availability", () => {
    expect(
      readPublicRecord({
        verdict: "unhealthy",
        release: "v0.9.68",
        checkedAt: CHECKED_AT,
        findings: 6,
      }).details,
    ).toEqual({ type: "unknown" });
  });

  test("invalid ISO instants cannot enter public verdict records", () => {
    expect(() =>
      readPublicRecord({
        verdict: "healthy",
        release: RELEASE,
        checkedAt: "2026-99-99T99:99:99Z",
      }),
    ).toThrow("Timestamp is not a UTC ISO instant");
  });

  test("all finding variants roundtrip with their baseline and window", () => {
    const record = privateRecord();
    expect(readPrivateRecord(structuredClone(record))).toEqual(record);
    expect(
      readPublicRecord({
        ...record.verdict,
        record: `release-health:${RELEASE}`,
      }).details,
    ).toEqual({
      type: "private",
      count: 3,
      reference: `release-health:${RELEASE}`,
    });
  });

  test("preserves the historical query and bindings without rebuilding them", () => {
    const record = privateRecord();
    const historical = {
      ...record,
      query: {
        kind: "HogQLQuery",
        query: "SELECT historical_predicate",
        values: { environment: "historical-case", previous: "0.9.68" },
      },
    };
    expect(readPrivateRecord(historical).query).toEqual(historical.query);
  });

  test("rejects malformed findings, counts, baseline and window", () => {
    const record = privateRecord();
    const invalid = [
      { ...record, baseline: { release: "main", environment: "unrecorded" } },
      {
        ...record,
        baseline: { release: PREVIOUS_RELEASE, environment: "unknown" },
      },
      ...[
        null,
        [],
        { ...record.query, kind: "OtherQuery" },
        { ...record.query, query: null },
        { ...record.query, values: [] },
        { ...record.query, values: { environment: 1 } },
      ].map((query) => ({ ...record, query })),
      { ...record, window: { ...record.window, baselineLookbackDays: 1 } },
      { ...record, window: { ...record.window, end: "2026-10-17T14:00:00Z" } },
      { ...record, findings: record.findings.slice(1) },
      ...["future", "overflow", "unclassified", "new_fingerprint"].map(
        (type) => ({ ...record, findings: [{ type, occurrences: -1 }] }),
      ),
      ...["unclassified", "new_fingerprint"].map((type) => ({
        ...record,
        findings: [{ type, occurrences: 1, fingerprint: { handler: null } }],
      })),
      { ...record, findings: [{ type: "future", occurrences: 1 }] },
    ];
    for (const value of invalid) {
      expect(() => readPrivateRecord(value)).toThrow(/release|stable/u);
    }
    expect(() =>
      readPublicRecord({ ...record.verdict, record: "release-health:v1.4.0" }),
    ).toThrow("Invalid release health reference");
  });

  test("gate refusal provides the exact authenticated findings command", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "release-health-gate-"));
    try {
      const previous = path.join(directory, "previous.json");
      const verdict = path.join(directory, "verdict.json");
      writeFileSync(
        previous,
        JSON.stringify({
          tag: RELEASE,
          publishedAt: "2026-10-17T10:00:00Z",
          verdictAssetId: 1,
        }),
      );
      writeFileSync(verdict, JSON.stringify(privateRecord().verdict));
      const result = Bun.spawnSync([
        "bun",
        path.join(import.meta.dir, "release-health.ts"),
        "gate",
        "--previous-release",
        previous,
        "--verdict",
        verdict,
        "--now",
        CHECKED_AT,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(
        `bun scripts/release-health.ts findings --release ${RELEASE}.`,
      );
      expect(result.stderr.toString()).not.toContain("/v1/summaries");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("private records through the authenticated CLI", () => {
  let directory = "";
  let recordFile = "";
  let storedFile = "";

  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), "release-health-store-"));
    recordFile = path.join(directory, "record.json");
    storedFile = path.join(directory, "stored.json");
    const gh = path.join(directory, "gh");
    writeFileSync(recordFile, JSON.stringify(privateRecord()));
    writeFileSync(
      gh,
      `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const state = JSON.parse(readFileSync(new URL("./state.json", import.meta.url), "utf8"));
const stored = new URL("./stored.json", import.meta.url);
const args = process.argv.slice(2);
const endpoint = args.find((arg) => arg.startsWith("repos/"));
if (args[0] === "api") {
  if (endpoint?.endsWith("actions/variables/STAGING_DEPLOY_REPOSITORY")) process.stdout.write("private-records");
  else if (endpoint === "repos/test-owner/private-records") process.stdout.write(state.privateStore);
  else process.exit(5);
} else if (args[0] === "release" && args[1] === "view") {
  if (state.draft === "inaccessible") { process.stderr.write("gh: PRIVATE_RECORD_SENTINEL (HTTP 404)"); process.exit(1); }
  process.stdout.write(JSON.stringify({isDraft: state.draft}));
} else if (args[0] === "release" && args[1] === "upload") {
  const record = JSON.parse(readFileSync(args[3], "utf8"));
  if (state.corrupt === "true") record.window.start = "2026-10-17T12:00:00.000Z";
  if (state.corrupt === "baseline") record.baseline.release = "PRIVATE_RECORD_SENTINEL";
  writeFileSync(stored, state.corrupt === "json" ? "{PRIVATE_RECORD_SENTINEL" : JSON.stringify(record));
} else if (args[0] === "release" && args[1] === "download") {
  const destination = args.at(args.indexOf("--dir") + 1);
  writeFileSync(destination + "/v1.4.1.json", readFileSync(stored));
} else process.exit(2);
`,
    );
    chmodSync(gh, 0o700);
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  type CliOptions = {
    command: "record" | "findings";
    privateStore?: boolean;
    corrupt?: "none" | "true" | "baseline" | "json";
    draft?: boolean | "inaccessible";
  };
  const cli = ({
    command,
    privateStore = true,
    corrupt = "none",
    draft = true,
  }: CliOptions) => {
    writeFileSync(
      path.join(directory, "state.json"),
      JSON.stringify({ privateStore: String(privateStore), corrupt, draft }),
    );
    return Bun.spawnSync(
      [
        "bun",
        path.join(import.meta.dir, "release-health.ts"),
        command,
        "--release",
        RELEASE,
        "--record",
        recordFile,
        "--store",
        "test-owner/private-records",
      ],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env["PATH"] ?? ""}`,
          GH_TOKEN: "",
          GITHUB_REPOSITORY: "test-owner/public-app",
        },
      },
    );
  };

  test("refuses a public store", () => {
    const refused = cli({ command: "record", privateStore: false });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toString()).toContain(
      "store must be a private repository",
    );
  });

  test("refuses a store that is no longer a draft", () => {
    const publishedStore = cli({ command: "record", draft: false });
    expect(publishedStore.exitCode).not.toBe(0);
    expect(publishedStore.stderr.toString()).toContain(
      "must remain a draft release",
    );
  });

  test("names an inaccessible draft without echoing the response", () => {
    const inaccessible = cli({ command: "findings", draft: "inaccessible" });
    expect(inaccessible.exitCode).not.toBe(0);
    expect(inaccessible.stderr.toString()).toContain("contents:write");
    expect(inaccessible.stderr.toString()).toContain("404");
    expect(inaccessible.stderr.toString()).not.toContain(
      "PRIVATE_RECORD_SENTINEL",
    );
    expect(inaccessible.stderr.toString()).not.toContain("/v1/summaries");
  });

  test("records, re-records and reads the record back", () => {
    const uploaded = cli({ command: "record" });
    expect(uploaded.exitCode).toBe(0);
    expect(uploaded.stdout.toString()).toBe("");
    expect(JSON.parse(readFileSync(storedFile, "utf-8"))).toEqual(
      privateRecord(),
    );
    const updated = cli({ command: "record" });
    expect(updated.exitCode).toBe(0);
    const downloaded = cli({ command: "findings" });
    expect(downloaded.exitCode).toBe(0);
    expect(JSON.parse(downloaded.stdout.toString())).toEqual(privateRecord());
  });

  test("refuses a record that reads back differently", () => {
    const corrupted = cli({ command: "record", corrupt: "true" });
    expect(corrupted.exitCode).not.toBe(0);
    expect(corrupted.stderr.toString()).toContain("readback");
  });

  for (const corruption of ["baseline", "json"] as const) {
    test(`refuses a malformed stored record (${corruption})`, () => {
      const malformed = cli({ command: "record", corrupt: corruption });
      expect(malformed.exitCode).not.toBe(0);
      expect(malformed.stderr.toString()).toContain("malformed");
      expect(malformed.stderr.toString()).not.toContain(
        "PRIVATE_RECORD_SENTINEL",
      );
    });
  }
});
