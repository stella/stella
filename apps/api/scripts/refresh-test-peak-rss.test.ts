import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { refreshTestPeakRss } from "./refresh-test-peak-rss";
import type { TestRssShard, TestRssTable } from "./test-batch-plan";

const FIRST = "scripts/first.test.ts";
const SECOND = "src/second.test.tsx";
const ENVIRONMENT = {
  os: "linux",
  arch: "x64",
  bunVersion: "1.3.0",
  runnerImage: "ubuntu24:20261001",
};
const SOURCE = { runId: "123", job: "measure-1" };
const MEASURED_AT = "2026-10-04T03:10:00.000Z";
const LATER_MEASURED_AT = "2026-10-04T03:40:00.000Z";
const ONLY_SHARD = { index: 1, count: 1 };
const measurement = (file = FIRST, peakMb = 42, exitCode = 0) => ({
  file,
  peakMb,
  exitCode,
});
type ArtifactOptions = {
  measurements?: ReturnType<typeof measurement>[];
  baselineMb?: number;
  source?: typeof SOURCE;
  measuredAt?: string;
  shard?: TestRssShard;
  plannedFiles?: number;
};
const artifact = ({
  measurements = [measurement()],
  baselineMb = 30,
  source = SOURCE,
  measuredAt = MEASURED_AT,
  shard = ONLY_SHARD,
  plannedFiles = measurements.length,
}: ArtifactOptions = {}) => ({
  version: 3,
  environment: ENVIRONMENT,
  source,
  measuredAt,
  shard,
  plannedFiles,
  baselineMb,
  measurements,
});
const fixture = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "test-rss-refresh-"));
  const apiRoot = path.join(directory, "api");
  const artifactDirectory = path.join(directory, "artifacts");
  mkdirSync(path.join(apiRoot, "scripts"), { recursive: true });
  mkdirSync(path.join(apiRoot, "src"), { recursive: true });
  mkdirSync(path.join(artifactDirectory, "shard"), { recursive: true });
  writeFileSync(path.join(apiRoot, FIRST), "");
  writeFileSync(path.join(apiRoot, SECOND), "");
  const receipt = (name: string, payload: unknown) =>
    writeFileSync(path.join(artifactDirectory, name), JSON.stringify(payload));
  const refresh = (previousPeaks: Readonly<Record<string, number>> = {}) =>
    refreshTestPeakRss({ artifactDirectory, apiRoot, previousPeaks });
  const clean = () => rmSync(directory, { recursive: true, force: true });
  return { artifactDirectory, apiRoot, receipt, refresh, clean };
};

test("refresh preserves per-shard baselines and provenance in stable sorted bytes", () => {
  const f = fixture();
  try {
    const secondSource = { runId: "123", job: "measure-2" };
    const firstArtifact = artifact({
      baselineMb: 50,
      shard: { index: 1, count: 2 },
    });
    const secondArtifact = artifact({
      measurements: [measurement(SECOND, 99.5)],
      source: secondSource,
      measuredAt: LATER_MEASURED_AT,
      shard: { index: 2, count: 2 },
    });
    const table = {
      environment: ENVIRONMENT,
      measuredAt: LATER_MEASURED_AT,
      baselineMb: 50,
      files: {
        [FIRST]: { peakMb: 42, baselineMb: 50, source: SOURCE },
        [SECOND]: { peakMb: 99.5, baselineMb: 30, source: secondSource },
      },
    } as const satisfies TestRssTable;
    const expected = `${JSON.stringify(table, null, 2)}\n`;
    f.receipt("z.json", secondArtifact);
    f.receipt("shard/a.json", firstArtifact);
    expect(f.refresh().content).toBe(expected);
    // A peak below its own empty-process baseline is valid measurement noise.
    f.receipt("z.json", firstArtifact);
    f.receipt("shard/a.json", secondArtifact);
    expect(f.refresh().content).toBe(expected);
    expect(f.refresh().changes).toEqual({
      newFiles: [FIRST, SECOND],
      unmeasuredFiles: [],
      removedFiles: [],
      biggestRelativeChange: undefined,
    });
  } finally {
    f.clean();
  }
});

test("a complete run refreshes a tree that moved on since it was measured", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.apiRoot, "src/added.test.ts"), "");
    f.receipt(
      "a.json",
      artifact({
        measurements: [
          measurement(FIRST, 42),
          measurement("src/deleted.test.ts", 70),
          measurement(SECOND, 99.5),
        ],
      }),
    );
    const refreshed = f.refresh();
    expect(Object.keys(JSON.parse(refreshed.content).files)).toEqual([
      FIRST,
      SECOND,
    ]);
    expect(refreshed.changes).toEqual({
      newFiles: [FIRST, SECOND],
      unmeasuredFiles: ["src/added.test.ts"],
      removedFiles: ["src/deleted.test.ts"],
      biggestRelativeChange: undefined,
    });
  } finally {
    f.clean();
  }
});

test("refresh reports the largest relative magnitude and identifies new files", () => {
  const f = fixture();
  try {
    f.receipt(
      "a.json",
      artifact({
        measurements: [measurement(FIRST, 42), measurement(SECOND, 99.5)],
      }),
    );
    expect(f.refresh({ [FIRST]: 21, [SECOND]: 199 }).changes).toEqual({
      newFiles: [],
      unmeasuredFiles: [],
      removedFiles: [],
      biggestRelativeChange: {
        file: FIRST,
        previousPeakMb: 21,
        peakMb: 42,
        relativeChange: 1,
      },
    });
    expect(f.refresh({ [FIRST]: 84 }).changes).toEqual({
      newFiles: [SECOND],
      unmeasuredFiles: [],
      removedFiles: [],
      biggestRelativeChange: {
        file: FIRST,
        previousPeakMb: 84,
        peakMb: 42,
        relativeChange: -0.5,
      },
    });
    expect(() => f.refresh({ [FIRST]: 0 })).toThrow(
      "Invalid previous peak RSS",
    );
  } finally {
    f.clean();
  }
});

test.each(
  [
    null,
    [],
    {},
    { ...artifact(), version: 2 },
    { ...artifact(), measurements: "invalid" },
    artifact({ measurements: [] }),
    { ...artifact(), measurements: [null] },
  ].map((payload) => ({ payload })),
)("invalid or empty receipt %j is refused", ({ payload }) => {
  const f = fixture();
  try {
    f.receipt("a.json", payload);
    expect(() => f.refresh()).toThrow(/Invalid measurement/u);
  } finally {
    f.clean();
  }
});

test.each([
  null,
  {},
  { index: 0, count: 1 },
  { index: 2, count: 1 },
  { index: 1.5, count: 2 },
  { index: "1", count: 1 },
])("invalid shard %j is refused", (shard) => {
  const f = fixture();
  try {
    f.receipt("a.json", { ...artifact(), shard });
    expect(() => f.refresh()).toThrow("Invalid shard");
  } finally {
    f.clean();
  }
});

test.each([0, -1, 1.5, "1", null])(
  "invalid planned file count %s is refused",
  (plannedFiles) => {
    const f = fixture();
    try {
      f.receipt("a.json", { ...artifact(), plannedFiles });
      expect(() => f.refresh()).toThrow("Invalid planned file count");
    } finally {
      f.clean();
    }
  },
);

test.each([0, -1, Number.NaN, Infinity, "42", null])(
  "invalid peak %s is refused",
  (peakMb) => {
    const f = fixture();
    try {
      f.receipt("a.json", {
        ...artifact(),
        measurements: [{ file: FIRST, peakMb, exitCode: 0 }],
      });
      expect(() => f.refresh()).toThrow("Invalid peak RSS");
    } finally {
      f.clean();
    }
  },
);

test.each([0, -1, Number.NaN, Infinity, "30", null])(
  "invalid baseline %s is refused",
  (baselineMb) => {
    const f = fixture();
    try {
      f.receipt("a.json", { ...artifact(), baselineMb });
      expect(() => f.refresh()).toThrow("Invalid baseline RSS");
    } finally {
      f.clean();
    }
  },
);

test.each([1, -1, "0", null])(
  "failed or invalid exit %s is refused",
  (exitCode) => {
    const f = fixture();
    try {
      f.receipt("a.json", {
        ...artifact(),
        measurements: [{ file: FIRST, peakMb: 42, exitCode }],
      });
      expect(() => f.refresh()).toThrow("Failed test measurement");
    } finally {
      f.clean();
    }
  },
);

test.each([
  "../scripts/first.test.ts",
  "/scripts/first.test.ts",
  "C:\\first.test.ts",
  "C:first.test.ts",
  "scripts\\first.test.ts",
  "scripts/./first.test.ts",
  "scripts//first.test.ts",
  "scripts/first\0.test.ts",
])("unsafe path %s is refused", (file) => {
  const f = fixture();
  try {
    f.receipt("a.json", artifact({ measurements: [measurement(file)] }));
    expect(() => f.refresh()).toThrow("Unsafe test path");
  } finally {
    f.clean();
  }
});

test("malformed source and environment snapshots fail closed", () => {
  const f = fixture();
  try {
    for (const source of [
      null,
      {},
      { runId: 123, job: "measure" },
      { runId: "123", job: " " },
    ]) {
      f.receipt("a.json", { ...artifact(), source });
      expect(() => f.refresh()).toThrow(/Invalid (RSS source|run id|job)/u);
    }
    for (const environment of [
      null,
      {},
      { ...ENVIRONMENT, arch: 64 },
      { ...ENVIRONMENT, runnerImage: " " },
    ]) {
      f.receipt("a.json", { ...artifact(), environment });
      expect(() => f.refresh()).toThrow(
        /Invalid (RSS environment|OS|architecture|runner image)/u,
      );
    }
    f.receipt("a.json", artifact({ shard: { index: 1, count: 2 } }));
    for (const field of ["os", "arch", "bunVersion", "runnerImage"]) {
      f.receipt("shard/b.json", {
        ...artifact({
          measurements: [measurement(SECOND)],
          shard: { index: 2, count: 2 },
        }),
        environment: { ...ENVIRONMENT, [field]: "different" },
      });
      expect(() => f.refresh()).toThrow("Mixed measurement environments");
    }
  } finally {
    f.clean();
  }
});

test.each([
  null,
  1_759_547_400_000,
  "",
  "yesterday",
  "2026-10-04",
  "2026-10-04T03:10:00Z",
  "2026-02-30T03:10:00.000Z",
])("invalid measurement time %j is refused", (measuredAt) => {
  const f = fixture();
  try {
    f.receipt("a.json", { ...artifact(), measuredAt });
    expect(() => f.refresh()).toThrow("Invalid measurement time in a.json");
  } finally {
    f.clean();
  }
});

test("partial shards, missing shards and duplicates cannot replace the table", () => {
  const f = fixture();
  try {
    f.receipt("a.json", artifact({ plannedFiles: 2 }));
    expect(() => f.refresh()).toThrow(
      "Incomplete shard 1/1 in a.json: measured 1 of 2 files",
    );
    f.receipt("a.json", artifact({ shard: { index: 1, count: 3 } }));
    expect(() => f.refresh()).toThrow(
      "Incomplete measurement run: missing shard 2/3, 3/3",
    );
    f.receipt("shard/b.json", artifact({ shard: { index: 1, count: 3 } }));
    expect(() => f.refresh()).toThrow("Duplicate shard 1/3");
    f.receipt("shard/b.json", artifact({ shard: { index: 2, count: 2 } }));
    expect(() => f.refresh()).toThrow(
      "Measurement receipts disagree on the shard count: 3 and 2",
    );
    f.receipt("a.json", artifact({ shard: { index: 1, count: 2 } }));
    expect(() => f.refresh()).toThrow(`Duplicate test measurement: ${FIRST}`);
  } finally {
    f.clean();
  }
});

test("shards from different measurement runs cannot form a census", () => {
  const f = fixture();
  try {
    f.receipt(
      "a.json",
      artifact({ baselineMb: 50, shard: { index: 1, count: 2 } }),
    );
    f.receipt(
      "b.json",
      artifact({
        measurements: [measurement(SECOND, 99.5)],
        source: { runId: "456", job: "measure-2" },
        shard: { index: 2, count: 2 },
      }),
    );
    expect(() => f.refresh()).toThrow(
      "Measurement receipts come from different runs: 123 and 456",
    );
  } finally {
    f.clean();
  }
});

test("missing receipts, malformed JSON and overflowed peaks fail closed", () => {
  const f = fixture();
  try {
    expect(() => f.refresh()).toThrow("No JSON measurement receipts");
    writeFileSync(path.join(f.artifactDirectory, "a.json"), "{");
    expect(() => f.refresh()).toThrow("Invalid JSON receipt");
    const serialized = JSON.stringify(artifact()).replace(
      '"peakMb":42',
      '"peakMb":1e309',
    );
    writeFileSync(path.join(f.artifactDirectory, "a.json"), serialized);
    expect(() => f.refresh()).toThrow("Invalid peak RSS");
    rmSync(path.join(f.apiRoot, FIRST));
    rmSync(path.join(f.apiRoot, SECOND));
    expect(() => f.refresh()).toThrow("API test census is empty");
  } finally {
    f.clean();
  }
});
