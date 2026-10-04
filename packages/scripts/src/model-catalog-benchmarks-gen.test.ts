import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  buildBenchmarkSnapshot,
  diffBenchmarkSnapshots,
  parseArenaPage,
  parseArenaRow,
  referencedSourceModelIds,
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
