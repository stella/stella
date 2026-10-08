import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  DOC_SOURCE_EXCLUSIONS,
  type NoLlmsTxtExclusion,
} from "../.claude/mcp/doc-sources";
import { RELEASE_AGE_EXCEPTION_SOURCES } from "./check-stll-quarantine-excludes";
import {
  collectWaivers,
  DAY_MS,
  DOC_SOURCE_FILE,
  dueWaivers,
  loadWaivers,
  trackedPolicyFiles,
  uncoveredExpirySources,
  waiverWarnings,
  type DatedWaiver,
} from "./dated-waivers";

const now = new Date("2026-10-01T00:00:00.000Z");
const doc = {
  dependency: "doc-package",
  reason: "no-llms-txt",
  explanation: "https://example.com/llms.txt returns 404",
  checkedAt: "2026-09-06T00:00:00.000Z",
  expiresAt: "2026-10-06T00:00:00.000Z",
} as const satisfies NoLlmsTxtExclusion;
const fixture = {
  [DOC_SOURCE_FILE]: '\nconst exclusions = ["doc-package"];',
  "bunfig.toml":
    '[install]\nminimumReleaseAgeExcludes = [\n  "new-package", # quarantine-expires: 2026-10-02T01:02:03.000Z\n]\n',
  "scripts/dependency-audit-baseline.json":
    '{"accepted":[\n{"id":"GHSA-test","expiresOn":"2026-10-03"}]}',
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
      {
        id: "SW-0002",
        kind: "permanent",
        rule: "test/test",
        file: "other.ts",
        symbol: "other",
        count: 1,
        reason: "Structural fixture",
        evidence: "other.test.ts",
      },
    ],
  }),
} as const;
const read = (file: string): string => {
  const value = new Map(Object.entries(fixture)).get(file);
  if (value === undefined) {
    throw new TypeError(`Unknown fixture file: ${file}`);
  }
  return value;
};
const inventory = () =>
  collectWaivers({
    read,
    docs: [doc],
    audit: [
      { id: "GHSA-test", package: "pkg", expiresOn: "2026-10-03" },
      { id: "permanent", package: "pkg" },
    ],
    bunfigs: ["bunfig.toml"],
    releaseAgeSources: {
      "docker-compose.yml":
        "# release-age-quarantine-exception: 2026-10-05T00:00:00.000Z",
    },
  });
const waiver = (expiresAt: string): DatedWaiver => ({
  source: "config.ts",
  line: 12,
  id: "pkg",
  kind: "no-llms-txt",
  expiresAt,
});

describe("dated waiver inventory", () => {
  test("enumerates each owner kind with source anchors and owner-written deadlines", () => {
    const entries = inventory();
    expect(entries.map(({ kind }) => kind)).toEqual([
      "release-age-exclusion",
      "dependency-audit",
      "release-age-exception",
      "suppression-waiver",
      "no-llms-txt",
    ]);
    expect(entries).toContainEqual({
      source: "bunfig.toml",
      line: 3,
      id: "new-package",
      kind: "release-age-exclusion",
      expiresAt: "2026-10-02T01:02:03.000Z",
    });
    expect(
      entries.find(({ kind }) => kind === "dependency-audit")?.expiresAt,
    ).toBe("2026-10-03");
    expect(
      entries.find(({ kind }) => kind === "suppression-waiver")?.expiresAt,
    ).toBe("2026-10-04");
    expect(entries.find(({ kind }) => kind === "no-llms-txt")).toEqual({
      source: DOC_SOURCE_FILE,
      line: 2,
      id: doc.dependency,
      kind: "no-llms-txt",
      checkedAt: doc.checkedAt,
      expiresAt: doc.expiresAt,
    });
    expect(
      entries.find(({ kind }) => kind === "release-age-exception")?.line,
    ).toBe(1);
  });

  test("date-only deadlines hold through the owner-written UTC day", () => {
    const acceptance = inventory().filter(
      ({ kind }) => kind === "dependency-audit",
    );
    expect(acceptance).toHaveLength(1);
    expect(
      dueWaivers(acceptance, new Date("2026-10-03T23:59:59.999Z"), 0),
    ).toEqual([]);
    expect(
      dueWaivers(acceptance, new Date("2026-10-04T00:00:00.000Z"), 0),
    ).toEqual(acceptance);
    expect(
      dueWaivers(acceptance, new Date("2026-09-29T00:00:00.000Z")),
    ).toEqual(acceptance);
    expect(
      dueWaivers(acceptance, new Date("2026-09-28T23:59:59.999Z")),
    ).toEqual([]);
  });

  test("all committed documentation entries are inventoried from their typed owner", async () => {
    const entries = await loadWaivers();
    expect(
      entries
        .filter(({ kind }) => kind === "no-llms-txt")
        .map(({ id }) => id)
        .toSorted(),
    ).toEqual(
      DOC_SOURCE_EXCLUSIONS.map(({ dependency }) => dependency).toSorted(),
    );
    for (const entry of entries.filter(
      ({ kind }) => kind !== "release-age-exception",
    )) {
      const content = readFileSync(
        path.join(import.meta.dir, "..", entry.source),
        "utf-8",
      );
      expect(content.split("\n").at(entry.line - 1)).toContain(entry.id);
    }
  });

  test("invalid expiry and missing source anchors fail visibly", () => {
    expect(() =>
      collectWaivers({
        read,
        docs: [{ ...doc, expiresAt: "2026-02-30T00:00:00.000Z" }],
        audit: [],
        bunfigs: [],
        releaseAgeSources: {},
      }),
    ).toThrow("Invalid dated waiver expiry");
    expect(() =>
      collectWaivers({
        read,
        docs: [{ ...doc, dependency: "missing" }],
        audit: [],
        bunfigs: [],
        releaseAgeSources: {},
      }),
    ).toThrow("source anchor missing");
    expect(() =>
      collectWaivers({
        read,
        docs: [],
        audit: [],
        bunfigs: [],
        releaseAgeSources: {
          "docker-compose.yml": "# release-age-quarantine-exception: tomorrow",
        },
      }),
    ).toThrow("missing an exact UTC expiry");
  });

  test("warning windows include the exact boundary and expired entries, excluding later ones", () => {
    const entries = [
      waiver(new Date(now.getTime() + 5 * DAY_MS).toISOString()),
      waiver(new Date(now.getTime() + 5 * DAY_MS + 1).toISOString()),
      waiver(now.toISOString()),
      waiver(new Date(now.getTime() - DAY_MS).toISOString()),
      waiver("2027-01-01T00:00:00.000Z"),
    ];
    expect(dueWaivers(entries, now)).toEqual([
      entries[0],
      entries[2],
      entries[3],
    ]);
    expect(
      dueWaivers(
        [
          waiver("2026-10-15T00:00:00.000Z"),
          waiver("2026-10-15T00:00:00.001Z"),
        ],
        now,
        14,
      ),
    ).toHaveLength(1);
    expect(waiverWarnings(entries, now)).toHaveLength(3);
    expect(
      waiverWarnings([waiver("2026-10-06T00:00:00.000Z")], now).at(0),
    ).toContain(
      "::warning file=config.ts,line=12::pkg (no-llms-txt) expires at 2026-10-06T00:00:00.000Z;",
    );
  });

  test("warning annotations escape workflow-command control characters", () => {
    const entry = {
      ...waiver(now.toISOString()),
      source: "config,with:colon%\n.ts",
      id: "pkg%\r\n::error::",
    };
    const warning = waiverWarnings([entry], now).at(0);
    expect(warning).toContain("file=config%2Cwith%3Acolon%25%0A.ts,line=12");
    expect(warning).toContain("pkg%25%0D%0A::error::");
    expect(warning).not.toContain("\n");
  });

  test("census rejects new expiry shapes in unregistered policy files", () => {
    const sources = {
      "known.ts": 'expiresAt: "2026-10-02T00:00:00.000Z"',
      "new.json": '{"expiresOn":"2026-10-02"}',
      "review.yml": 'review-by: "2026-10-03"',
      "bunfig.toml": '"pkg", # quarantine-expires: 2026-10-04T00:00:00.000Z',
      "history.json": '{"recordedAt":"2026-10-02"}',
    };
    expect(uncoveredExpirySources(sources, new Set(["known.ts"]))).toEqual([
      "new.json",
      "review.yml",
      "bunfig.toml",
    ]);
  });

  test("every tracked policy expiry declaration has a registered owner", () => {
    const root = path.resolve(import.meta.dir, "..");
    const files = trackedPolicyFiles().filter(
      (file) =>
        /(?:^(?:scripts\/|\.claude\/mcp\/|\.oxlint-plugins\/|\.github\/)|config|baseline|waivers|allowances|bunfig\.toml$)/u.test(
          file,
        ) &&
        /\.(?:ts|json|toml|ya?ml)$/u.test(file) &&
        !/(?:\.test\.|\.spec\.|fixtures\/|__fixtures__\/)/u.test(file),
    );
    const sources = Object.fromEntries(
      files.map((file) => [file, readFileSync(path.join(root, file), "utf-8")]),
    );
    const covered = new Set([
      DOC_SOURCE_FILE,
      "scripts/suppression-waivers.ts",
      "scripts/suppression-waivers.json",
      "scripts/dependency-audit-baseline.json",
      ...RELEASE_AGE_EXCEPTION_SOURCES,
      ...trackedPolicyFiles().filter((file) => file.endsWith("bunfig.toml")),
    ]);
    expect(uncoveredExpirySources(sources, covered)).toEqual([]);
  });
});

const dueStepWorkflowSchema = v.object({
  jobs: v.object({
    recheck: v.object({
      steps: v.array(
        v.object({ id: v.optional(v.string()), run: v.optional(v.string()) }),
      ),
    }),
  }),
});

describe("review window step", () => {
  const dueStep = (): string => {
    const workflow = v.parse(
      dueStepWorkflowSchema,
      Bun.YAML.parse(
        readFileSync(
          new URL(
            "../.github/workflows/dated-waiver-recheck.yml",
            import.meta.url,
          ),
          "utf-8",
        ),
      ),
    );
    return (
      workflow.jobs.recheck.steps.find((step) => step.id === "due")?.run ??
      panic("dated-waiver-recheck.yml has no due step")
    );
  };
  // GitHub runs `run` scripts with `bash -e`; the inventory command is
  // replaced so the step's own shell handling is what is under test.
  const runStep = (command: string) => {
    const output = path.join(
      mkdtempSync(path.join(tmpdir(), "dated-waiver-due-")),
      "output",
    );
    writeFileSync(output, "");
    const script = dueStep().replace(
      "bun scripts/dated-waivers.ts --due",
      () => command,
    );
    const result = Bun.spawnSync(["bash", "-e", "-c", script], {
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    return { exitCode: result.exitCode, output: readFileSync(output, "utf-8") };
  };

  test("an inventory failure fails the step instead of reporting no work", () => {
    expect(dueStep()).toContain("bun scripts/dated-waivers.ts --due");
    expect(runStep("false").exitCode).not.toBe(0);
  });

  test("a due inventory is written to the step output", () => {
    expect(runStep("echo true")).toEqual({
      exitCode: 0,
      output: "due=true\n",
    });
  });
});
