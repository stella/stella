import { expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertProperty } from "@stll/property-testing";

import { baseWaiverReferences } from "./dated-waiver-inventory";
import { trackedPolicyFiles } from "./dated-waiver-tracked-files";
import {
  collectWaivers,
  DAY_MS,
  DocumentationExclusionParseError,
  DOC_SOURCE_FILE,
  dueWaivers,
  expiredWaiverAnnotations,
  expiredWaiverFailures,
  expiryInstant,
  exceptionInventory as inventoryJson,
  loadWaivers,
  readDocumentationExclusions,
  withinHours,
  readTestQuarantines,
  RECHECK_INSTRUCTIONS,
  uncoveredExpirySources,
  waiverKey,
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
        "command: bun install --minimum-release-age 0\n# release-age-quarantine-exception: 2026-10-05T01:00:00.000Z",
    },
  });

test("owner inventory orders preserved deadlines by expiry and declares concrete stress commands", () => {
  const entries = inventory();
  expect(entries.map(({ kind, expiresAt }) => ({ kind, expiresAt }))).toEqual([
    {
      kind: "release-age-exclusion",
      expiresAt: "2026-10-02T01:02:03.000Z",
    },
    { kind: "dependency-audit", expiresAt: "2026-10-03" },
    { kind: "suppression-waiver", expiresAt: "2026-10-04" },
    {
      kind: "release-age-exception",
      expiresAt: "2026-10-05T01:00:00.000Z",
    },
    { kind: "no-llms-txt", expiresAt: doc.expiresAt },
  ]);
  // Date-only waivers lapse at the following UTC midnight. Keep this fixture's
  // exact timestamp later so its order exercises expiry rather than tie breaks.
  let previous = Number.NEGATIVE_INFINITY;
  for (const { expiresAt } of entries) {
    const deadline = Date.parse(expiryInstant(expiresAt));
    expect(deadline).toBeGreaterThan(previous);
    previous = deadline;
  }
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
test("elapsed entries fail globally and warn only unrelated changes", () => {
  const entries = inventory();
  const now = new Date("2026-10-07T00:00:00.000Z");
  expect(expiredWaiverFailures(entries, now)).toHaveLength(entries.length);
  expect(expiredWaiverAnnotations(entries, now)).toEqual([]);
  for (const entry of entries) {
    const unrelated = {
      scope: { type: "changes" as const, changedFiles: new Set(["README.md"]) },
    };
    expect(expiredWaiverFailures([entry], now, unrelated)).toEqual([]);
    const warnings = expiredWaiverAnnotations([entry], now, unrelated);
    expect(warnings).toHaveLength(1);
    expect(warnings.at(0)).toContain(entry.id);
    expect(warnings.at(0)).toContain(RECHECK_INSTRUCTIONS[entry.kind]);
    const owner = {
      scope: {
        type: "changes" as const,
        changedFiles: new Set([entry.source]),
      },
    };
    expect(expiredWaiverFailures([entry], now, owner)).toHaveLength(1);
    expect(expiredWaiverAnnotations([entry], now, owner)).toEqual([]);
  }
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
test("documentation inventory derives from injected typed owners including none", () => {
  for (const docs of [
    [],
    [doc],
    [doc, { ...doc, dependency: "second-package" }],
  ]) {
    const entries = collectWaivers({
      read: (source) =>
        source === DOC_SOURCE_FILE ? JSON.stringify(docs) : '{"waivers":[]}',
      docs,
      audit: [],
      bunfigs: [],
      releaseAgeSources: {},
    });
    expect(entries.map(({ id }) => id).toSorted()).toEqual(
      docs.map(({ dependency }) => dependency).toSorted(),
    );
  }
});
test("documentation inventory preserves helper deadlines independently of similarly named constants", () => {
  const documentationSource = (expiresAt: string) =>
    `
const NO_LLMS_TXT_EXPLANATION = "https://example.com/llms.txt returns 404";
const NO_LLMS_TXT_CHECKED_AT = "2026-09-01T00:00:00.000Z";
const NO_LLMS_TXT_EXPIRES_AT = "2027-01-01T00:00:00.000Z";
const noLlmsTxt = (dependency: string) => ({
  checkedAt: NO_LLMS_TXT_CHECKED_AT,
  dependency,
  explanation: NO_LLMS_TXT_EXPLANATION,
  expiresAt: __EXPIRES_AT__,
  reason: "no-llms-txt",
});
export const DOC_SOURCE_EXCLUSIONS = ["doc-package"].map(noLlmsTxt);
`.replace("__EXPIRES_AT__", () => JSON.stringify(expiresAt));
  const inventoryFrom = (expiresAt: string) =>
    loadWaivers([DOC_SOURCE_FILE], (file) => {
      if (file === DOC_SOURCE_FILE) {
        return documentationSource(expiresAt);
      }
      if (file === "scripts/dependency-audit-baseline.json") {
        return '{"accepted":[]}';
      }
      if (file === "scripts/suppression-waivers.json") {
        return '{"waivers":[]}';
      }
      return "";
    });

  const baseDeadline = "2026-10-01T00:00:00.000Z";
  const headDeadline = "2026-11-01T00:00:00.000Z";
  expect(inventoryFrom(baseDeadline).at(0)?.expiresAt).toBe(baseDeadline);
  expect(inventoryFrom(headDeadline).at(0)?.expiresAt).toBe(headDeadline);
});
test("documentation registry resolves local const array aliases through static wrappers", () => {
  const entries = readDocumentationExclusions(`
const NO_LLMS_TXT_EXPLANATION = "https://example.com/llms.txt returns 404";
const NO_LLMS_TXT_CHECKED_AT = "2026-09-01T00:00:00.000Z";
const NO_LLMS_TXT_EXPIRES_AT = "2026-10-01T00:00:00.000Z";
const noLlmsTxt = (dependency: string) => ({
  checkedAt: NO_LLMS_TXT_CHECKED_AT,
  dependency,
  explanation: NO_LLMS_TXT_EXPLANATION,
  expiresAt: NO_LLMS_TXT_EXPIRES_AT,
  reason: "no-llms-txt",
});
const exclusions = (["doc-package"] as const) satisfies readonly string[];
export const DOC_SOURCE_EXCLUSIONS = exclusions.map(noLlmsTxt);
`);

  expect(entries).toEqual([
    {
      ...doc,
      checkedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-10-01T00:00:00.000Z",
    },
  ]);
});
test("documentation registry aliases ignore same-name constants in nested scopes", () => {
  const entries = readDocumentationExclusions(`
const NO_LLMS_TXT_EXPLANATION = "https://example.com/llms.txt returns 404";
const NO_LLMS_TXT_CHECKED_AT = "2026-09-01T00:00:00.000Z";
const NO_LLMS_TXT_EXPIRES_AT = "2026-10-01T00:00:00.000Z";
const noLlmsTxt = (dependency: string) => ({
  checkedAt: NO_LLMS_TXT_CHECKED_AT,
  dependency,
  explanation: NO_LLMS_TXT_EXPLANATION,
  expiresAt: NO_LLMS_TXT_EXPIRES_AT,
  reason: "no-llms-txt",
});
const exclusions = ["doc-package"];
function helper() {
  const exclusions = [];
  return exclusions;
}
export const DOC_SOURCE_EXCLUSIONS = exclusions.map(noLlmsTxt);
`);

  expect(entries).toEqual([
    {
      ...doc,
      checkedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-10-01T00:00:00.000Z",
    },
  ]);
});
test("documentation registry aliases reject duplicate module declarations", () => {
  const source = `
const exclusions = ["doc-package"];
const exclusions = [];
export const DOC_SOURCE_EXCLUSIONS = exclusions;
`;

  expect(() => readDocumentationExclusions(source)).toThrow(
    DocumentationExclusionParseError,
  );
});
test("documentation registry accepts its direct static array shorthand", () => {
  const source = `
const NO_LLMS_TXT_EXPLANATION = "https://example.com/llms.txt returns 404";
const NO_LLMS_TXT_CHECKED_AT = "2026-09-06T00:00:00.000Z";
const NO_LLMS_TXT_EXPIRES_AT = "2026-10-06T00:00:00.000Z";
const noLlmsTxt = (dependency: string) => ({
  checkedAt: NO_LLMS_TXT_CHECKED_AT,
  dependency,
  explanation: NO_LLMS_TXT_EXPLANATION,
  expiresAt: NO_LLMS_TXT_EXPIRES_AT,
  reason: "no-llms-txt",
});
export const DOC_SOURCE_EXCLUSIONS = ["doc-package"].map(noLlmsTxt);
`;

  expect(readDocumentationExclusions(source)).toEqual([doc]);
});
test("documentation registry rejects helper implementations without a proven static return", () => {
  for (const callback of [
    "(dependency) => lookup(dependency)",
    "(dependency) => { return lookup(dependency); }",
    "async (dependency) => ({ dependency })",
    "importedHelper",
  ]) {
    const source = `
const NO_LLMS_TXT_EXPLANATION = "${doc.explanation}";
const NO_LLMS_TXT_CHECKED_AT = "${doc.checkedAt}";
const NO_LLMS_TXT_EXPIRES_AT = "${doc.expiresAt}";
const noLlmsTxt = ${callback};
export const DOC_SOURCE_EXCLUSIONS = ["doc-package"].map(noLlmsTxt);
`;
    expect(() => readDocumentationExclusions(source)).toThrow(
      DocumentationExclusionParseError,
    );
  }
});
test("documentation registry reads literal object maps spread into concat without executing source", () => {
  for (const field of ["dependency", "dependency: dependency"]) {
    const source = `
export const DOC_SOURCE_EXCLUSIONS = [].concat(...(["doc-package"] as const).map(
  (dependency) => ({
    ${field},
    checkedAt: "${doc.checkedAt}",
    expiresAt: "${doc.expiresAt}",
    explanation: "${doc.explanation}",
    reason: "no-llms-txt",
  }) satisfies NoLlmsTxtExclusion,
));`;
    expect(readDocumentationExclusions(source)).toEqual([doc]);
  }
});
test("documentation registry rejects dynamic and imported spread expressions", () => {
  for (const registry of [
    "makeExclusions()",
    "[...importedExclusions]",
    "[].concat(...importedExclusions)",
    '[].concat(...["doc-package"].map((dependency) => makeExclusion(dependency)))',
    '[].concat(...["doc-package"].map((dependency) => ({ ...importedExclusion, dependency })))',
  ]) {
    expect(() =>
      readDocumentationExclusions(
        `export const DOC_SOURCE_EXCLUSIONS = ${registry};`,
      ),
    ).toThrow(DocumentationExclusionParseError);
  }
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

test("quarantine inventory is not derailed by template and regex syntax", () => {
  const contents = [
    ["const interpolated = `value $", "{x} suffix`;"].join(""),
    "const backticks = /``/u;",
    "// test-quarantine-expires: 2026-10-05",
    'test.skip("still inventoried", () => {});',
  ].join("\n");

  expect(
    readTestQuarantines({ "a.test.ts": contents }).map(({ id }) => id),
  ).toEqual(["still inventoried"]);
});

test("marker text in templates and strings is ignored", () => {
  const contents = [
    [
      "const interpolated = `value $",
      "{x} // test-quarantine-expires: 2026-10-05`;",
    ].join(""),
    'const quoted = "// test-quarantine-expires: 2026-10-06";',
  ].join("\n");

  expect(readTestQuarantines({ "a.test.ts": contents })).toEqual([]);
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

const exceptionInventory = (contents: string) =>
  collectWaivers({
    read,
    docs: [],
    audit: [],
    bunfigs: [],
    releaseAgeSources: { "docker-compose.yml": contents },
  }).filter(({ kind }) => kind === "release-age-exception");

test("all waiver kinds retain their keys when unrelated lines shift their locators", () => {
  const quarantined =
    '// test-quarantine-expires: 2026-10-05\ntest.skip("case", () => {});';
  const entriesAt = (prefix: string) =>
    collectWaivers({
      read: (file) => prefix + read(file),
      docs: [doc],
      audit: [{ id: "GHSA-test", package: "pkg", expiresOn: "2026-10-03" }],
      bunfigs: ["bunfig.toml"],
      releaseAgeSources: {
        "docker-compose.yml": `${prefix}command: bun install --minimum-release-age 0\n# release-age-quarantine-exception: 2026-10-05T01:00:00.000Z`,
      },
      quarantineSources: {
        "a.test.ts": `${prefix}${quarantined}`,
      },
    });
  const original = entriesAt("");
  expect(Object.keys(RECHECK_INSTRUCTIONS).toSorted()).toEqual(
    original.map(({ kind }) => kind).toSorted(),
  );
  assertProperty(
    "dated-waiver-line-independent-identity",
    fc.property(fc.integer({ min: 1, max: 30 }), (lines) => {
      const shifted = entriesAt("\n".repeat(lines));
      expect(shifted.map(waiverKey)).toEqual(original.map(waiverKey));
      expect(shifted.map(({ line }) => line)).toEqual(
        original.map(({ line }) => line + lines),
      );
    }),
    { seed: 261_020, numRuns: 40 },
  );
});

test("exception identity survives sibling removal and rejects ambiguous covered commands", () => {
  const marker = "# release-age-quarantine-exception: 2026-10-05T01:00:00.000Z";
  const first = `command: bun install --minimum-release-age 0\n${marker}`;
  const second = `command: bun install --production --minimum-release-age 0\n${marker}`;
  const before = exceptionInventory(`${first}\n${second}`);
  const after = exceptionInventory(second);
  const retained = before.find(({ id }) => id === after.at(0)?.id);
  expect(retained).toBeDefined();
  if (!retained || !after.at(0)) {
    throw new TypeError("Retained exception fixture missing");
  }
  expect(after.map(waiverKey)).toEqual([waiverKey(retained)]);
  expect(
    exceptionInventory(`${second}\n${first}`).map(waiverKey).toSorted(),
  ).toEqual(before.map(waiverKey).toSorted());
  expect(() => exceptionInventory(`${first}\n${first}`)).toThrow(
    "Duplicate dated waiver identity",
  );
  expect(() =>
    exceptionInventory(
      `${first}\n${first.replace("2026-10-05", "2026-10-06")}`,
    ),
  ).toThrow("Duplicate dated waiver identity");
  expect(() => exceptionInventory(marker)).toThrow(
    "Release-age exception has no covered zero-age command",
  );
});

test("check consumes validated tracked files without spawning under the offline preload", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dated-waiver-tracked-"));
  const trackedFiles = path.join(directory, "tracked-files");
  try {
    const git = Bun.spawnSync(["git", "ls-files", "-z"], {
      cwd: path.resolve(import.meta.dir, ".."),
    });
    expect(git.exitCode).toBe(0);
    writeFileSync(trackedFiles, git.stdout);
    writeFileSync(
      `${trackedFiles}.context.json`,
      JSON.stringify({
        scope: { type: "all" },
        baseBunfigs: {},
        basePackageManifests: {},
        baseProposals: {},
        baseEntries: null,
      }),
    );

    const checked = Bun.spawnSync(
      [
        "bun",
        "--preload",
        "./scripts/offline-network-preload.ts",
        "scripts/dated-waivers.ts",
        "--check",
        "--tracked-files",
        trackedFiles,
      ],
      { cwd: path.resolve(import.meta.dir, "..") },
    );
    expect(checked.stderr.toString()).toBe("");
    expect(checked.exitCode).toBe(0);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("check requires an explicit tracked-files input", () => {
  const checked = Bun.spawnSync(
    ["bun", "scripts/dated-waivers.ts", "--check"],
    {
      cwd: path.resolve(import.meta.dir, ".."),
    },
  );
  expect(checked.exitCode).not.toBe(0);
  expect(checked.stderr.toString()).toContain(
    "--check requires --tracked-files <NUL-separated-file>",
  );
});

test("tracked-files input rejects absolute and parent paths", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dated-waiver-invalid-"));
  try {
    for (const invalid of ["/absolute.ts", "scripts/../outside.ts"]) {
      const trackedFiles = path.join(directory, "tracked-files");
      writeFileSync(trackedFiles, `${invalid}\0`);
      const checked = Bun.spawnSync(
        [
          "bun",
          "scripts/dated-waivers.ts",
          "--check",
          "--tracked-files",
          trackedFiles,
        ],
        { cwd: path.resolve(import.meta.dir, "..") },
      );
      expect(checked.exitCode).not.toBe(0);
      expect(checked.stderr.toString()).toContain(
        `Invalid tracked-file path: ${invalid}`,
      );
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("radar JSON preserves owner identity, exact expiry and unknown removal state", () => {
  const entries = inventory();
  const before = inventoryJson(entries, new Date("2026-10-02T01:02:02.999Z"));
  expect(before.schemaVersion).toBe(1);
  expect(before.entries.at(0)).toMatchObject({
    kind: "release-age-exclusion",
    file: "bunfig.toml",
    entry: "new-package",
    owner: "bunfig.toml",
    expiryInstant: "2026-10-02T01:02:03.000Z",
    canRemoveYet: false,
    removal: "at-expiry",
  });
  expect(
    inventoryJson(entries, new Date("2026-10-02T01:02:03.000Z")).entries.at(0)
      ?.canRemoveYet,
  ).toBe(true);
  for (const entry of before.entries.filter(
    ({ kind }) => kind !== "release-age-exclusion",
  )) {
    expect(entry.canRemoveYet).toBeNull();
    expect(entry.removal).toBe("requires-probe");
  }
  expect(
    before.entries.find(({ kind }) => kind === "dependency-audit")
      ?.expiryInstant,
  ).toBe("2026-10-04T00:00:00.000Z");
});

test("radar selects exactly the inclusive hour horizon", () => {
  expect(withinHours("72h")).toBe(72);
  for (const invalid of ["72", "-1h", "3d", "1.5h"]) {
    expect(() => withinHours(invalid)).toThrow("--within requires");
  }
  for (const entry of inventory()) {
    const at = Date.parse(expiryInstant(entry.expiresAt));
    expect(
      dueWaivers(
        [entry],
        new Date(at - 72 * 3_600_000),
        withinHours("72h") / 24,
      ),
    ).toEqual([entry]);
    expect(dueWaivers([entry], new Date(at - 72 * 3_600_000 - 1), 3)).toEqual(
      [],
    );
  }
});

test("inventory rejects duplicate package exclusions regardless of deadline and retains cross-file owners", () => {
  const first = sources["bunfig.toml"];
  const twin = first.replace(
    "\n]\n",
    '\n "new-package", # quarantine-expires: 2026-10-03T01:02:03.000Z\n]\n',
  );
  const options = {
    read: (file: string) => (file.endsWith("bunfig.toml") ? twin : read(file)),
    docs: [],
    audit: [],
    bunfigs: ["bunfig.toml", ".claude/mcp/bunfig.toml"],
    releaseAgeSources: {},
  };
  expect(() => collectWaivers(options)).toThrow(
    "Duplicate dated waiver identity",
  );
  const entries = collectWaivers({
    ...options,
    read: (file) => (file.endsWith("bunfig.toml") ? first : read(file)),
  }).filter(({ kind }) => kind === "release-age-exclusion");
  expect(entries.map(({ source }) => source).toSorted()).toEqual([
    ".claude/mcp/bunfig.toml",
    "bunfig.toml",
  ]);
});

test("the base inventory read from git equals the inventory of the same tree", () => {
  const root = path.resolve(import.meta.dir, "..");
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  // Committed state only: the working tree may carry local edits.
  if (git("status", "--porcelain", "--untracked-files=no").trim() !== "") {
    return;
  }
  const head = git("rev-parse", "HEAD").trim();
  const files = git("ls-tree", "-r", "--name-only", "-z", head)
    .split("\0")
    .filter(Boolean);
  const references = baseWaiverReferences(head, files);
  expect(references.length).toBeGreaterThan(0);
  expect(references).toEqual(
    loadWaivers(trackedPolicyFiles()).map(
      ({ kind, source, id, expiresAt }) => ({ kind, source, id, expiresAt }),
    ),
  );
  // Both inventories read the whole repository.
}, 60_000);
