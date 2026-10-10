import { expect, test } from "bun:test";

import { DOC_SOURCE_EXCLUSIONS } from "../.claude/mcp/doc-sources";
import {
  collectWaivers,
  DAY_MS,
  DOC_SOURCE_FILE,
  dueWaivers,
  expiryInstant,
  loadWaivers,
  readTestQuarantines,
  uncoveredExpirySources,
} from "./dated-waivers";

const doc = {
  dependency: "doc-package",
  reason: "no-llms-txt",
  explanation: "https://example.com/llms.txt returns 404",
  checkedAt: "2026-09-06T00:00:00.000Z",
  expiresAt: "2026-10-06T00:00:00.000Z",
} as const;
const sources = {
  [DOC_SOURCE_FILE]: 'const exclusions = ["doc-package"];',
  "bunfig.toml":
    '[install]\nminimumReleaseAgeExcludes = [\n "new-package", # quarantine-expires: 2026-10-02T01:02:03.000Z\n]\n',
  "scripts/dependency-audit-baseline.json":
    '{"accepted":[{"id":"GHSA-test","expiresOn":"2026-10-03"}]}',
  "scripts/suppression-waivers.json": JSON.stringify({
    waivers: [
      {
        id: "SW-0001",
        kind: "temporary",
        rule: "test/test",
        file: "example.ts",
        symbol: "example",
        count: 1,
        reason: "Fixture invariant",
        evidence: "example.test.ts",
        expires: "2026-10-04",
      },
    ],
  }),
};
const read = (file: string) => new Map(Object.entries(sources)).get(file) ?? "";
const inventory = () =>
  collectWaivers({
    read,
    docs: [doc],
    audit: [{ id: "GHSA-test", package: "pkg", expiresOn: "2026-10-03" }],
    bunfigs: ["bunfig.toml"],
    releaseAgeSources: {
      "docker-compose.yml":
        "# release-age-quarantine-exception: 2026-10-05T00:00:00.000Z",
    },
  });

test("owner inventory preserves every deadline and declares concrete stress commands", () => {
  const entries = inventory();
  expect(entries.map(({ kind }) => kind)).toEqual([
    "release-age-exclusion",
    "dependency-audit",
    "release-age-exception",
    "suppression-waiver",
    "no-llms-txt",
  ]);
  expect(entries.map(({ expiresAt }) => expiresAt)).toEqual([
    "2026-10-02T01:02:03.000Z",
    "2026-10-03",
    "2026-10-05T00:00:00.000Z",
    "2026-10-04",
    doc.expiresAt,
  ]);
  expect(
    entries.find(({ kind }) => kind === "release-age-exclusion")?.probe.command,
  ).toEqual([
    "bun",
    "scripts/check-lockfile-release-ages.ts",
    "--all",
    "--package",
    "new-package",
  ]);
  expect(
    entries.find(({ kind }) => kind === "suppression-waiver")?.probe.attempts,
  ).toBe(20);
  expect(
    entries.find(({ kind }) => kind === "no-llms-txt")?.probe.attempts,
  ).toBe(3);
});
test("complete owner UTC day and exact five-day grace boundary are preserved", () => {
  const entries = inventory().filter(({ kind }) => kind === "dependency-audit");
  expect(expiryInstant("2026-10-03")).toBe("2026-10-04T00:00:00.000Z");
  expect(dueWaivers(entries, new Date("2026-10-03T23:59:59.999Z"), 0)).toEqual(
    [],
  );
  expect(dueWaivers(entries, new Date("2026-10-04T00:00:00.000Z"), 0)).toEqual(
    entries,
  );
  const boundary = Date.parse(expiryInstant("2026-10-03")) - 5 * DAY_MS;
  expect(dueWaivers(entries, new Date(boundary))).toEqual(entries);
  expect(dueWaivers(entries, new Date(boundary - 1))).toEqual([]);
});
test("impossible dates, missing anchors and new expiry-bearing owners fail closed", () => {
  for (const value of ["2026-02-30", "2026-02-30T00:00:00.000Z", "tomorrow"]) {
    expect(() => expiryInstant(value)).toThrow("Invalid dated waiver expiry");
  }
  expect(() =>
    collectWaivers({
      read,
      docs: [{ ...doc, dependency: "missing" }],
      audit: [],
      bunfigs: [],
      releaseAgeSources: {},
    }),
  ).toThrow("source anchor missing");
  expect(
    uncoveredExpirySources(
      {
        "new.json": '{"expiresOn":"2026-10-02"}',
        "known.ts": 'expiresAt: "2026-10-02"',
        "history.json": '{"recordedAt":"2026-10-02"}',
      },
      new Set(["known.ts"]),
    ),
  ).toEqual(["new.json"]);
});
test("committed docs entries derive from their typed owner", async () => {
  const entries = await loadWaivers();
  expect(
    entries
      .filter(({ kind }) => kind === "no-llms-txt")
      .map(({ id }) => id)
      .toSorted(),
  ).toEqual(
    DOC_SOURCE_EXCLUSIONS.map(({ dependency }) => dependency).toSorted(),
  );
});
test("adjacent literal skipped tests declare twenty samples and lapse at expiry", () => {
  const quarantineSources = {
    "packages/example/src/a.test.ts":
      'import { test } from "bun:test";\n// test-quarantine-expires: 2026-10-05T00:00:00.000Z\ntest.skip("a case", () => {});\nconst fixture = "test-quarantine-expires: 2026-10-06";',
  };
  const entries = readTestQuarantines(quarantineSources);
  expect(entries).toHaveLength(1);
  expect(entries.at(0)?.probe).toEqual({
    command: [
      "bun",
      "--cwd=packages/example",
      "run",
      "test",
      "--",
      "src/a.test.ts",
      "-t",
      "a case",
    ],
    attempts: 20,
  });
  expect(dueWaivers(entries, new Date("2026-10-05T00:00:00.000Z"), 0)).toEqual(
    entries,
  );
  expect(() =>
    readTestQuarantines({
      "a.test.ts":
        '// test-quarantine-expires: 2026-10-05\ntest("case", () => {});',
    }),
  ).toThrow("Unowned dated test quarantine marker");
  expect(() =>
    readTestQuarantines({
      "a.test.ts":
        '// test-quarantine-expires: 2026-02-30\ntest.skip("case", () => {});',
    }),
  ).toThrow("Invalid dated waiver expiry");
});

test("literal metacharacters are escaped and duplicate test identities fail closed", () => {
  const contents =
    '// test-quarantine-expires: 2026-10-05T00:00:00.000Z\ntest.skip("case [x] (a)?", () => {});';
  const entries = readTestQuarantines({ "a.test.ts": contents });
  expect(entries.at(0)?.probe.command.at(-1)).toBe("case \\[x\\] \\(a\\)\\?");
  expect(() =>
    collectWaivers({
      read,
      docs: [],
      audit: [],
      bunfigs: [],
      releaseAgeSources: {},
      quarantineSources: { "a.test.ts": `${contents}\n${contents}` },
    }),
  ).toThrow("Duplicate dated waiver identity");
});
