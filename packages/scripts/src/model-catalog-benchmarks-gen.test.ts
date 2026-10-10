import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MODEL_BENCHMARK_RATINGS,
  MODEL_BENCHMARK_PUBLISH_DATE,
} from "@stll/ai-catalog/benchmarks";
import { Temporal } from "@stll/time";

import {
  buildBenchmarkSnapshot,
  diffBenchmarkSnapshots,
  parseArenaPage,
  parseArenaRow,
  referencedSourceModelIds,
  runBenchmarkCheck,
} from "./model-catalog-benchmarks-gen";
import type { ArenaRow } from "./model-catalog-benchmarks-gen";

const upstreamRow = (overrides: Record<string, unknown> = {}) => ({
  row_idx: 0,
  row: {
    model_name: "claude-opus-5-high",
    organization: "anthropic",
    license: "Proprietary",
    rating: 1492.91,
    rating_lower: 1488.71,
    rating_upper: 1497.1,
    variance: 4.6,
    vote_count: 42_617,
    rank: 10,
    category: "overall",
    leaderboard_publish_date: "2026-09-13",
    ...overrides,
  },
  truncated_cells: [],
});

describe("Arena row validation", () => {
  test("accepts a published row", () => {
    const parsed = parseArenaRow(upstreamRow());

    expect(Result.isOk(parsed) ? parsed.value : parsed.error).toEqual({
      category: "overall",
      modelName: "claude-opus-5-high",
      publishDate: "2026-09-13",
      rank: 10,
      rating: 1492.91,
      ratingLower: 1488.71,
      ratingUpper: 1497.1,
      voteCount: 42_617,
    });
  });

  test.each([
    ["model_name", { model_name: "" }],
    ["leaderboard_publish_date", { leaderboard_publish_date: "13/09/2026" }],
    ["rating", { rating: "1492" }],
    ["rating bounds", { rating_lower: 1500 }],
    ["rank", { rank: 0 }],
    ["vote_count", { vote_count: 12.5 }],
  ])("rejects an invalid %s", (field, overrides) => {
    const parsed = parseArenaRow(upstreamRow(overrides));

    expect(Result.isError(parsed) ? parsed.error.message : null).toContain(
      `invalid ${field}`,
    );
  });

  test("rejects a page carrying one malformed row", () => {
    const page = parseArenaPage({
      num_rows_total: 2,
      rows: [upstreamRow(), upstreamRow({ rating: null })],
    });

    expect(Result.isError(page) ? page.error.message : null).toContain(
      "invalid rating",
    );
  });
});

const arenaRow = (modelName: string, rating = 1400): ArenaRow => ({
  category: "overall",
  modelName,
  publishDate: "2026-09-13",
  rank: 1,
  rating,
  ratingLower: rating - 3,
  ratingUpper: rating + 3,
  voteCount: 1000,
});

describe("benchmark snapshot", () => {
  test("names every referenced source id missing upstream", () => {
    const ids = referencedSourceModelIds();
    const missing = ids.slice(0, 2);
    const snapshot = buildBenchmarkSnapshot(
      ids.slice(2).map((modelName) => arenaRow(modelName)),
    );

    expect(missing).toHaveLength(2);
    expect(Result.isError(snapshot) ? snapshot.error.message : null).toContain(
      missing.join(", "),
    );
  });

  test("keeps referenced rows in catalogue order with rounded ratings", () => {
    const ids = referencedSourceModelIds();
    const snapshot = buildBenchmarkSnapshot([
      arenaRow("unreferenced-model"),
      ...ids.toReversed().map((modelName) => arenaRow(modelName, 1400.456)),
    ]);

    expect(Result.isOk(snapshot)).toBe(true);
    if (Result.isOk(snapshot)) {
      expect([...snapshot.value.ratings.keys()]).toEqual(ids);
      expect(snapshot.value.ratings.get(ids[0] ?? "")?.rating).toBe(1400.46);
    }
  });

  test("describes rating changes field by field", () => {
    const rating = {
      rank: 3,
      rating: 1450,
      ratingLower: 1445,
      ratingUpper: 1455,
      voteCount: 900,
    };
    expect(
      diffBenchmarkSnapshots({
        committed: {
          publishDate: "2026-09-06",
          ratings: new Map([
            ["kept", rating],
            ["dropped", rating],
          ]),
        },
        live: {
          publishDate: "2026-09-13",
          ratings: new Map([
            ["kept", { ...rating, rating: 1451 }],
            ["added", rating],
          ]),
        },
      }),
    ).toEqual([
      "publish date: 2026-09-06 -> 2026-09-13",
      "~ kept.rating: 1450 -> 1451",
      "+ added",
      "- dropped",
    ]);
  });
});

describe("benchmark check availability", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  const setup = async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "benchmark-check-"));
    directories.push(directory);
    const preload = path.join(directory, "fetch.ts");
    const responseFile = path.join(directory, "response.json");
    const stateFile = path.join(directory, "state.json");
    await Bun.write(
      preload,
      `
      const fixture = await Bun.file(${JSON.stringify(responseFile)}).json();
      if (fixture.slow) {
        const schedule = globalThis.setTimeout;
        globalThis.setTimeout = (callback, delay, ...args) => {
          if (delay !== 30_000) throw new Error("Unexpected transfer deadline");
          return schedule(callback, 0, ...args);
        };
      }
      globalThis.fetch = async (url) => {
        if (fixture.modelsDevUnavailable && String(url).includes("models.dev")) return new Response("unavailable", { status: 503 });
        if (fixture.network) throw new TypeError("network unavailable");
        const offset = Number(new URL(url).searchParams.get("offset"));
        if (offset > 0 && fixture.nextStatus) return new Response("unavailable", { status: fixture.nextStatus });
        if (fixture.slow) return new Response(new ReadableStream(), { status: 200 });
        const text = (fixture.rawBody ?? JSON.stringify(fixture.body)) + (fixture.oversized ? " ".repeat(2 * 1024 * 1024) : "");
        return new Response(text, { status: fixture.status });
      };
    `,
    );
    const run = async (
      fixture: unknown,
      script = "model-catalog-benchmarks-gen.ts",
    ) => {
      await Bun.write(responseFile, JSON.stringify(fixture));
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          preload,
          path.join(import.meta.dir, script),
          "--check",
          "--state-file",
          stateFile,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { exitCode, output: stdout + stderr };
    };
    return { run, stateFile };
  };

  const unavailable = async () => new Response("unavailable", { status: 500 });

  test("alerts only after an inconclusive response lasts more than 7 days", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "benchmark-check-"));
    directories.push(directory);
    const stateFile = path.join(directory, "state.json");
    const outputPath = path.join(directory, "benchmarks.gen.ts");
    await Bun.write(outputPath, "committed snapshot");
    const start = Temporal.Instant.from("2026-10-01T00:00:00.000Z");

    const dayOne = await runBenchmarkCheck({
      fetchArenaPage: unavailable,
      now: start,
      outputPath,
      statePath: stateFile,
    });
    expect(dayOne.exitCode).toBe(0);
    expect(dayOne.messages.join("\n")).toContain('"httpStatus":500');
    expect(await Bun.file(outputPath).text()).toBe("committed snapshot");
    expect(await Bun.file(stateFile).json()).toEqual({
      version: 2,
      lastFetchedAt: null,
      inconclusiveSince: start.toString(),
      lastOutcome: {
        status: "inconclusive",
        reason: "Arena page at offset 0 responded 500",
        httpStatus: 500,
        pageOffset: 0,
      },
    });

    const beforeThreshold = await runBenchmarkCheck({
      fetchArenaPage: unavailable,
      now: Temporal.Instant.from("2026-10-07T23:59:00.000Z"),
      outputPath,
      statePath: stateFile,
    });
    expect(beforeThreshold.exitCode).toBe(0);

    const atThreshold = await runBenchmarkCheck({
      fetchArenaPage: unavailable,
      now: Temporal.Instant.from("2026-10-08T00:00:00.000Z"),
      outputPath,
      statePath: stateFile,
    });
    expect(atThreshold.exitCode).toBe(0);

    const afterThreshold = await runBenchmarkCheck({
      fetchArenaPage: unavailable,
      now: Temporal.Instant.from("2026-10-08T00:01:00.000Z"),
      outputPath,
      statePath: stateFile,
    });
    expect(afterThreshold.exitCode).toBe(1);
    expect(afterThreshold.messages.join("\n")).toContain(
      `outage started ${start.toString()}, last good fetch none`,
    );
    expect(afterThreshold.messages.join("\n")).toContain('"httpStatus":500');
  });

  test.each([
    { network: true },
    { status: 200, body: { rows: "malformed" } },
    { status: 200, rawBody: "not JSON" },
    { status: 200, body: { num_rows_total: 2, rows: [] } },
  ])(
    "reports unavailable transport and malformed pages as inconclusive: %j",
    async (fixture) => {
      const { run } = await setup();
      const checked = await run(fixture);
      expect(checked.exitCode).toBe(0);
      expect(checked.output).toContain('"status":"inconclusive"');
      expect(checked.output).toContain('"pageOffset":0');
      expect(checked.output).toContain('"reason":');
    },
  );

  test("reports the failed page offset", async () => {
    const { run } = await setup();
    const checked = await run({
      status: 200,
      body: { rows: [upstreamRow()], num_rows_total: 2 },
      nextStatus: 502,
    });
    expect(checked.exitCode).toBe(0);
    expect(checked.output).toContain('"httpStatus":502');
    expect(checked.output).toContain('"pageOffset":1');
  });

  test("runs check mode against a 500 response fixture", async () => {
    const { run } = await setup();
    const checked = await run({ status: 500 });

    expect(checked.exitCode).toBe(0);
    expect(checked.output).toContain("[INCONCLUSIVE]");
    expect(checked.output).toContain('"httpStatus":500');
  });

  const currentPage = () => ({
    num_rows_total: Object.keys(MODEL_BENCHMARK_RATINGS).length,
    rows: Object.entries(MODEL_BENCHMARK_RATINGS).map(([modelName, rating]) =>
      upstreamRow({
        model_name: modelName,
        leaderboard_publish_date: MODEL_BENCHMARK_PUBLISH_DATE,
        rating: rating.rating,
        rating_lower: rating.ratingLower,
        rating_upper: rating.ratingUpper,
        rank: rating.rank,
        vote_count: rating.voteCount,
      }),
    ),
  });

  test.each([
    { oversized: true, reason: "exceeds" },
    { slow: true, reason: "Fetch timed out" },
  ])(
    "reports bounded transfer failures as inconclusive: %j",
    async (fixture) => {
      const { run, stateFile } = await setup();
      const checked = await run({
        ...fixture,
        status: 200,
        body: currentPage(),
      });
      expect(checked.exitCode).toBe(0);
      expect(checked.output).toContain('"status":"inconclusive"');
      expect(checked.output).toContain('"httpStatus":200');
      expect(checked.output).toContain('"pageOffset":0');
      expect(checked.output).toContain(fixture.reason);
      expect(await Bun.file(stateFile).json()).toMatchObject({
        version: 2,
        inconclusiveSince: expect.any(String),
        lastOutcome: { status: "inconclusive", httpStatus: 200, pageOffset: 0 },
      });
    },
  );

  test("a successful fetch clears the outage and records the fetch time", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "benchmark-check-"));
    directories.push(directory);
    const stateFile = path.join(directory, "state.json");
    const outputPath = path.join(directory, "benchmarks.gen.ts");
    await Bun.write(
      outputPath,
      await Bun.file(
        path.resolve(import.meta.dir, "../../ai-catalog/src/benchmarks.gen.ts"),
      ).text(),
    );
    await runBenchmarkCheck({
      fetchArenaPage: unavailable,
      now: Temporal.Instant.from("2026-10-01T00:00:00.000Z"),
      outputPath,
      statePath: stateFile,
    });
    const fetchedAt = Temporal.Instant.from("2026-10-02T03:04:05.000Z");
    const checked = await runBenchmarkCheck({
      fetchArenaPage: async () => Response.json(currentPage()),
      now: fetchedAt,
      outputPath,
      statePath: stateFile,
    });

    expect(checked.exitCode).toBe(0);
    expect(await Bun.file(stateFile).json()).toMatchObject({
      version: 2,
      lastFetchedAt: fetchedAt.toString(),
      inconclusiveSince: null,
      lastOutcome: { status: "fetched" },
    });
  });

  test("invalid persisted state fails rather than resetting the counter", async () => {
    const { run, stateFile } = await setup();
    await Bun.write(stateFile, '{"consecutiveInconclusive":1}');
    const checked = await run({ status: 503 });
    expect(checked.exitCode).toBe(1);
    expect(checked.output).toContain("Invalid benchmark check state");
  });

  test.each([
    {
      name: "an inconclusive outcome without an outage start",
      state: {
        version: 2,
        lastFetchedAt: null,
        inconclusiveSince: null,
        lastOutcome: {
          status: "inconclusive",
          reason: "Arena page at offset 0 responded 500",
          httpStatus: 500,
          pageOffset: 0,
        },
      },
    },
    {
      name: "a fetched outcome with an outage start",
      state: {
        version: 2,
        lastFetchedAt: "2026-10-01T00:00:00Z",
        inconclusiveSince: "2026-10-01T00:00:00Z",
        lastOutcome: { status: "fetched" },
      },
    },
  ])("rejects persisted state with $name", async ({ state }) => {
    const { run, stateFile } = await setup();
    await Bun.write(stateFile, JSON.stringify(state));
    const checked = await run({ status: 503 });
    expect(checked.exitCode).toBe(1);
    expect(checked.output).toContain(
      "lastOutcome and inconclusiveSince disagree",
    );
  });

  test("ID checks still fail immediately", async () => {
    const { run } = await setup();
    const checked = await run(
      { status: 200, body: { data: [] }, modelsDevUnavailable: true },
      "model-catalog-upstream.ts",
    );
    expect(checked.exitCode).toBe(1);
    expect(checked.output).toContain("[MISSING]");
    expect(checked.output).toContain("model catalog issue(s)");
  });

  test("capability checks use committed inputs during upstream outages", async () => {
    const { run } = await setup();
    const checked = await run(
      { network: true },
      "model-catalog-capabilities-gen.ts",
    );
    expect(checked.exitCode).toBe(0);
    expect(checked.output).toContain("capabilities.gen.ts is current");
  });

  test("rate checks use committed inputs during upstream outages", async () => {
    const { run } = await setup();
    const checked = await run({ status: 503 }, "model-catalog-rates-gen.ts");
    expect(checked.exitCode).toBe(0);
    expect(checked.output).toContain("model-rates.gen.ts is current");
  });

  test("snapshot drift fails and resets the availability streak", async () => {
    const { run, stateFile } = await setup();
    await run({ status: 503 });
    const page = currentPage();
    const checked = await run({
      status: 200,
      body: {
        num_rows_total: page.num_rows_total,
        rows: page.rows.map(({ row, ...entry }) => ({
          ...entry,
          row: { ...row, rank: row.rank + 1 },
        })),
      },
    });
    expect(checked.exitCode).toBe(1);
    expect(checked.output).toContain("benchmarks.gen.ts is stale");
    expect(await Bun.file(stateFile).json()).toMatchObject({
      version: 2,
      inconclusiveSince: null,
      lastOutcome: { status: "fetched" },
    });
  });
});
