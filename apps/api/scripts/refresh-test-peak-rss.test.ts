import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { refreshTestPeakRss } from "./refresh-test-peak-rss";
import type { TestRssTable } from "./test-batch-plan";

const FIRST = "scripts/first.test.ts";
const SECOND = "src/second.test.tsx";
const ENVIRONMENT = {
  os: "linux",
  arch: "x64",
  bunVersion: "1.3.0",
  runnerImage: "ubuntu24:20261001",
};
const SOURCE = { runId: "123", job: "measure-1" };
const measurement = (file = FIRST, peakMb = 42, exitCode = 0) => ({
  file,
  peakMb,
  exitCode,
});
const artifact = (
  measurements = [measurement()],
  baselineMb = 30,
  source = SOURCE,
) => ({
  version: 1,
  environment: ENVIRONMENT,
  source,
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
    const firstArtifact = artifact([measurement()], 50);
    const secondArtifact = artifact(
      [measurement(SECOND, 99.5)],
      30,
      secondSource,
    );
    const table = {
      type: "measured",
      environment: ENVIRONMENT,
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
      biggestRelativeChange: undefined,
    });
    writeFileSync(path.join(f.apiRoot, "src/added.test.ts"), "");
    expect(() => f.refresh()).toThrow(
      "Incomplete test census: src/added.test.ts",
    );
  } finally {
    f.clean();
  }
});

test("refresh reports the largest relative magnitude and identifies new files", () => {
  const f = fixture();
  try {
    f.receipt(
      "a.json",
      artifact([measurement(FIRST, 42), measurement(SECOND, 99.5)]),
    );
    expect(f.refresh({ [FIRST]: 21, [SECOND]: 199 }).changes).toEqual({
      newFiles: [],
      biggestRelativeChange: {
        file: FIRST,
        previousPeakMb: 21,
        peakMb: 42,
        relativeChange: 1,
      },
    });
    expect(f.refresh({ [FIRST]: 84 }).changes).toEqual({
      newFiles: [SECOND],
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
    artifact([]),
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
    f.receipt("a.json", artifact([measurement(file)]));
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
    f.receipt("a.json", artifact());
    for (const field of ["os", "arch", "bunVersion", "runnerImage"]) {
      f.receipt("shard/b.json", {
        ...artifact([measurement(SECOND)]),
        environment: { ...ENVIRONMENT, [field]: "different" },
      });
      expect(() => f.refresh()).toThrow("Mixed measurement environments");
    }
  } finally {
    f.clean();
  }
});

test("stale, duplicate and incomplete artifact unions cannot replace the census", () => {
  const f = fixture();
  try {
    f.receipt("a.json", artifact([measurement("src/deleted.test.ts")]));
    expect(() => f.refresh()).toThrow("Stale test measurement");
    f.receipt("a.json", artifact());
    expect(() => f.refresh()).toThrow(`Incomplete test census: ${SECOND}`);
    f.receipt("shard/b.json", artifact());
    expect(() => f.refresh()).toThrow(`Duplicate test measurement: ${FIRST}`);
  } finally {
    f.clean();
  }
});

test("shards from different measurement runs cannot form a census", () => {
  const f = fixture();
  try {
    f.receipt("a.json", artifact([measurement()], 50));
    f.receipt(
      "b.json",
      artifact([measurement(SECOND, 99.5)], 30, {
        runId: "456",
        job: "measure-2",
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
