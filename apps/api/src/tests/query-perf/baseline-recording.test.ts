import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Hex } from "@stll/sha256/bun";

import { parseQueryPerfBaselineFile } from "./baseline";
import { completeQueryPerfRun } from "./baseline-recording";
import { QUERY_PERF_PROFILES } from "./profiles";
import { QUERY_PERF_SEED_ID } from "./seed";
import { QUERY_PERF_SETTINGS } from "./settings";

test("the committed recording covers both profiles and unchanged measurements complete comparison without recording", async () => {
  const baseline = parseQueryPerfBaselineFile(
    await Bun.file(new URL("baseline.json", import.meta.url)).json(),
  );
  expect(baseline.seedId).toBe(QUERY_PERF_SEED_ID);
  expect(baseline.settingsDigest).toBe(
    sha256Hex(JSON.stringify(QUERY_PERF_SETTINGS)),
  );
  expect(
    QUERY_PERF_PROFILES.filter((profileId) =>
      Object.keys(baseline.entries).some((id) =>
        id.startsWith(`${profileId}-`),
      ),
    ),
  ).toEqual([...QUERY_PERF_PROFILES]);
  const directory = await mkdtemp(path.join(tmpdir(), "query-perf-compare-"));
  try {
    const baselinePath = path.join(directory, "baseline.json");
    const outputPath = path.join(directory, "outputs");
    await completeQueryPerfRun({
      mode: "compare",
      baseline,
      recorded: baseline.entries,
      seedId: baseline.seedId,
      settingsDigest: baseline.settingsDigest,
      baselinePath,
      outputPath,
    });
    expect(await Bun.file(baselinePath).exists()).toBe(false);
    expect(await Bun.file(outputPath).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing baselines produce a validated recording and still fail comparison", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "query-perf-record-"));
  try {
    const baselinePath = path.join(directory, "baseline.json");
    const outputPath = path.join(directory, "outputs");
    const metrics = { sharedBlocks: 100, executionTimeMs: 2 };
    const options = {
      recorded: { "small-document-search": metrics },
      seedId: "fixture-v1",
      settingsDigest: "a".repeat(64),
      baselinePath,
      outputPath,
    };
    expect(
      await rejectionOf(
        completeQueryPerfRun({ ...options, mode: "compare", baseline: null }),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "Commit the validated query-perf-baseline-record artifact",
      ),
    });
    const baseline = parseQueryPerfBaselineFile(
      JSON.parse(await readFile(baselinePath, "utf-8")),
    );
    expect(baseline.entries).toEqual(options.recorded);
    expect(await readFile(outputPath, "utf-8")).toBe(
      "baseline_recorded=true\n",
    );
    await completeQueryPerfRun({ ...options, mode: "compare", baseline });
    expect(await readFile(outputPath, "utf-8")).toBe(
      "baseline_recorded=true\n",
    );
    expect(
      await rejectionOf(
        completeQueryPerfRun({
          ...options,
          mode: "compare",
          baseline,
          recorded: {
            "small-document-search": { sharedBlocks: 110, executionTimeMs: 3 },
            "growth-document-search": metrics,
          },
        }),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "Missing query performance baselines: growth-document-search",
      ),
    });
    const extended = parseQueryPerfBaselineFile(
      JSON.parse(await readFile(baselinePath, "utf-8")),
    );
    expect(extended.entries).toEqual({
      ...baseline.entries,
      "growth-document-search": metrics,
    });
    await completeQueryPerfRun({ ...options, mode: "record", baseline: null });
    expect(
      parseQueryPerfBaselineFile(
        JSON.parse(await readFile(baselinePath, "utf-8")),
      ).entries,
    ).toEqual(options.recorded);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid measurements cannot produce an artifact or its upload marker", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "query-perf-record-"));
  try {
    const baselinePath = path.join(directory, "baseline.json");
    const outputPath = path.join(directory, "outputs");
    expect(
      await rejectionOf(
        completeQueryPerfRun({
          mode: "compare",
          baseline: null,
          recorded: {
            "small-document-search": { sharedBlocks: 0, executionTimeMs: 2 },
          },
          seedId: "fixture-v1",
          settingsDigest: "a".repeat(64),
          baselinePath,
          outputPath,
        }),
      ),
    ).toMatchObject({
      message: expect.stringContaining("Malformed query perf baseline entry"),
    });
    expect(await Bun.file(baselinePath).exists()).toBe(false);
    expect(await Bun.file(outputPath).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
