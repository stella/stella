import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

import {
  QUARANTINE_REGISTRY_ENV,
  QUARANTINE_REPORT_DIR_ENV,
  quarantineRecordSchema,
  serializeRegistry,
  type QuarantineEntry,
  type QuarantineRecord,
} from "./flaky-test-quarantine";

const PRELOAD = path.join(import.meta.dir, "flaky-test-quarantine-preload.ts");
const FIXTURE = "pkg/flaky.test.ts";
const SOURCE = `import { describe, expect, it, test } from "bun:test";
import { existsSync } from "node:fs";

describe("outer", () => {
  describe("inner", () => {
    test("throws", () => {
      expect(1).toBe(2);
    });
  });
  test("passes", () => {
    expect(1).toBe(1);
  });
});
it("rejects", async () => {
  await Promise.reject(new Error("network flake"));
});
test("calls done with an error", (done) => {
  setTimeout(() => done(new Error("late flake")), 1);
});
test("hangs", () => new Promise(() => {}), 50);
test.concurrent("concurrent throw", () => {
  throw new Error("concurrent flake");
});
test("unquarantined", () => {
  expect(existsSync("fail-unquarantined")).toBe(false);
});
`;
const RUNNER = `import { existsSync, readFileSync } from "node:fs";
const reportDir = process.env["${QUARANTINE_REPORT_DIR_ENV}"];
const registry = JSON.parse(readFileSync(process.env["${QUARANTINE_REGISTRY_ENV}"], "utf-8"));
if (reportDir && registry.entries.length > 0 && !existsSync(reportDir)) {
  throw new Error("quarantine preload did not initialize in the package runner");
}
const result = Bun.spawnSync({
  cmd: [process.execPath, "test", "./${FIXTURE}"],
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(result.exitCode);
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const entry = (name: string): QuarantineEntry => ({
  id: `${FIXTURE}::${name}`,
  owner: "octocat",
  reason: "Fails intermittently.",
  created: "2026-10-01",
  expires: "2026-10-15",
});

type RunOptions = {
  names: readonly string[];
  // Makes the fixture's unquarantined test fail too.
  failUnquarantined?: boolean;
  reportDir?: "set" | "unset";
};

const run = ({
  names,
  failUnquarantined = false,
  reportDir = "set",
}: RunOptions) => {
  const root = mkdtempSync(path.join(tmpdir(), "flaky-quarantine-"));
  roots.push(root);
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "pkg"));
  writeFileSync(
    path.join(root, "scripts/flaky-test-quarantine.json"),
    serializeRegistry({ entries: names.map(entry) }),
  );
  writeFileSync(path.join(root, FIXTURE), SOURCE);
  writeFileSync(path.join(root, "runner.ts"), RUNNER);
  if (failUnquarantined) {
    writeFileSync(path.join(root, "fail-unquarantined"), "");
  }
  const reports = path.join(root, "reports");
  const { BUN_OPTIONS: _options, ...inherited } = process.env;
  const result = Bun.spawnSync({
    // CI loads the preload into a package runner through BUN_OPTIONS; that
    // runner then spawns the actual Bun test process.
    cmd: [process.execPath, "runner.ts"],
    cwd: root,
    env: {
      ...inherited,
      BUN_OPTIONS: `--preload=${PRELOAD}`,
      [QUARANTINE_REGISTRY_ENV]: path.join(
        root,
        "scripts/flaky-test-quarantine.json",
      ),
      ...(reportDir === "set" ? { [QUARANTINE_REPORT_DIR_ENV]: reports } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const files = existsSync(reports) ? readdirSync(reports) : [];
  const records = files.flatMap((file) =>
    readFileSync(path.join(reports, file), "utf-8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line): QuarantineRecord =>
        v.parse(quarantineRecordSchema, JSON.parse(line)),
      ),
  );
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
    records,
  };
};

const compareTuple = (
  left: readonly string[],
  right: readonly string[],
): number => compareCodeUnit(left.join("\0"), right.join("\0"));

const FAILING = [
  "outer > inner > throws",
  "rejects",
  "calls done with an error",
  "hangs",
  "concurrent throw",
];

describe("flaky-test quarantine preload", () => {
  test("a run whose only failures are quarantined exits zero and records each one", () => {
    const { exitCode, records, output } = run({ names: FAILING });
    expect(output).toContain("(quarantined fail)");
    expect(exitCode).toBe(0);
    expect(
      records
        .flatMap((record) =>
          record.type === "failed" ? [[record.id, record.message]] : [],
        )
        .toSorted(compareTuple),
    ).toEqual(
      [
        [`${FIXTURE}::calls done with an error`, "late flake"],
        [`${FIXTURE}::concurrent throw`, "concurrent flake"],
        [`${FIXTURE}::hangs`, "timed out after 50ms"],
        [
          `${FIXTURE}::outer > inner > throws`,
          "expect(received).toBe(expected)",
        ],
        [`${FIXTURE}::rejects`, "network flake"],
      ].toSorted(compareTuple),
    );
    expect(records).toContainEqual({ type: "loaded", file: FIXTURE });
  });

  test("the same failures fail the run without their entries", () => {
    const { exitCode, records } = run({ names: [] });
    expect(exitCode).not.toBe(0);
    expect(records).toEqual([]);
  });

  test("an unquarantined failure still fails a run with quarantined failures", () => {
    const { exitCode } = run({
      names: FAILING,
      failUnquarantined: true,
    });
    expect(exitCode).not.toBe(0);
  });

  test("a quarantined test that passes is recorded as passed", () => {
    const { records } = run({ names: [...FAILING, "outer > passes"] });
    expect(records).toContainEqual(
      expect.objectContaining({
        type: "passed",
        id: `${FIXTURE}::outer > passes`,
      }),
    );
  });

  test("an entry naming no registered test is detectable as stale", () => {
    const { records } = run({ names: [...FAILING, "outer > renamed"] });
    const registered = new Set(
      records.flatMap((record) =>
        record.type === "registered" ? [record.id] : [],
      ),
    );
    expect(registered.has(`${FIXTURE}::outer > passes`)).toBe(false);
    expect(registered.has(`${FIXTURE}::outer > renamed`)).toBe(false);
    expect([...registered].toSorted()).toEqual(
      FAILING.map((name) => `${FIXTURE}::${name}`).toSorted(),
    );
  });

  test("without a report directory the preload changes nothing", () => {
    const { exitCode, records } = run({ names: FAILING, reportDir: "unset" });
    expect(exitCode).not.toBe(0);
    expect(records).toEqual([]);
  });
});
