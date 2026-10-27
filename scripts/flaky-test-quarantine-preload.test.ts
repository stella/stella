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
import ts from "typescript6";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { isPathInside } from "@stll/portable-path";

import {
  QUARANTINE_REGISTRY_ENV,
  QUARANTINE_REPORT_DIR_ENV,
  type QuarantineEntry,
  type QuarantineRecord,
  quarantineRecordSchema,
  serializeRegistry,
} from "./flaky-test-quarantine";

const PRELOAD = path.join(import.meta.dir, "flaky-test-quarantine-preload.ts");
const FIXTURE = "pkg/flaky.test.ts";
const FIXTURE_SELECTION_ENV = "FLAKY_TEST_FIXTURE_SELECTION";
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
describe.concurrent("modified group", () => {
  test("modified case", () => {
    throw new Error("describe modifier flake");
  });
});
describe.each([["one"]])("parameterized %s", () => {
  test("case", () => {
    throw new Error("parameterized group flake");
  });
});
describe.each([["word", "2", "3", "4.5", { x: 1 }, { y: 2 }]])(
  "formats %s %d %i %f %j %o %# %%",
  () => {
    test("case", () => {
      throw new Error("formatted placeholders flake");
    });
  },
);
describe.each([{ word: "one", nested: { value: 2 } }])(
  "object $word $nested.value",
  () => {
    test("case", () => {
      throw new Error("formatted variables flake");
    });
  },
);
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
  cmd: [process.execPath, "test", ...(process.env["${FIXTURE_SELECTION_ENV}"] === "only" ? ["--only"] : []), "./${FIXTURE}"],
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
  source?: string;
  selection?: "all" | "only";
  // Makes the fixture's unquarantined test fail too.
  failUnquarantined?: boolean;
  reportDir?: "set" | "unset";
};

const run = ({
  names,
  source = SOURCE,
  selection = "all",
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
  writeFileSync(path.join(root, FIXTURE), source);
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
      [FIXTURE_SELECTION_ENV]: selection,
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
    root,
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
  "modified group > modified case",
  "parameterized one > case",
  'formats word 2 3 4.5 {"x":1} { y: 2 } 0 % > case',
  "object one 2 > case",
];

describe("flaky-test quarantine preload", () => {
  test("reused describe.each registrars restart row IDs for each suite", () => {
    const names = [
      "outer > first 0 alpha > case",
      "outer > first 1 beta > case",
      "outer > second 0 alpha > case",
      "outer > second 1 beta > case",
    ];
    const result = run({
      names,
      source: `import { describe, test } from "bun:test";
describe("outer", () => {
  const cases = describe.each(["alpha", "beta"]);
  cases("first %# %s", () => {
    test("case", () => { throw new TypeError("fixture failure"); });
  });
  cases("second %# %s", () => {
    test("case", () => { throw new TypeError("fixture failure"); });
  });
});`,
    });
    expect(result.exitCode).toBe(0);
    expect(
      result.records
        .flatMap((record) => (record.type === "failed" ? [record.id] : []))
        .toSorted(),
    ).toEqual(names.map((name) => `${FIXTURE}::${name}`));
  });

  test.each(["skip", "only", "concurrent", "serial"])(
    "retains native test.%s.each receivers and behavior",
    (modifier) => {
      const result = run({
        names: ["sentinel"],
        selection: modifier === "only" ? "only" : "all",
        source: `import { expect, test } from "bun:test";
test("sentinel", () => {});
test.${modifier}.each([1])("native row %i", (value) => {
  ${modifier === "skip" ? 'throw new TypeError("Skipped body ran");' : "expect(value).toBe(1);"}
});`,
      });
      expect(result.output).not.toContain("ERR_INVALID_THIS");
      expect(result.output).not.toContain("is not a function");
      expect(result.exitCode, result.output).toBe(0);
    },
  );

  test.each(["skip", "only", "concurrent", "serial"])(
    "retains native describe.%s.each receivers and behavior",
    (modifier) => {
      const result = run({
        names: ["sentinel"],
        selection: modifier === "only" ? "only" : "all",
        source: `import { describe, expect, test } from "bun:test";
test("sentinel", () => {});
describe.${modifier}.each([1])("native scope %i", (value) => {
  test("native row", () => {
    ${modifier === "skip" ? 'throw new TypeError("Skipped body ran");' : "expect(value).toBe(1);"}
  });
});`,
      });
      expect(result.output).not.toContain("ERR_INVALID_THIS");
      expect(result.output).not.toContain("is not a function");
      expect(result.exitCode, result.output).toBe(0);
    },
  );

  test("its static import graph uses only builtins and relative scripts files", () => {
    const pending = [PRELOAD];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop();
      expect(file).toBeDefined();
      if (file === undefined || visited.has(file)) {
        continue;
      }
      visited.add(file);
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf-8"),
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.TS,
      );
      for (const statement of source.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          continue;
        }
        const specifier = statement.moduleSpecifier.text;
        if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
          continue;
        }
        expect(specifier.startsWith(".")).toBe(true);
        const resolved = path.resolve(path.dirname(file), specifier);
        expect(isPathInside(import.meta.dir, resolved)).toBe(true);
        pending.push(
          path.extname(resolved) === "" ? `${resolved}.ts` : resolved,
        );
      }
    }
  });

  test("loads without node_modules and records a quarantined failure", () => {
    const result = run({ names: FAILING });
    expect(existsSync(path.join(result.root, "node_modules"))).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("(quarantined fail)");
    expect(result.records).toContainEqual(
      expect.objectContaining({
        type: "failed",
        id: `${FIXTURE}::outer > inner > throws`,
      }),
    );
  });

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
        [
          `${FIXTURE}::modified group > modified case`,
          "describe modifier flake",
        ],
        [`${FIXTURE}::parameterized one > case`, "parameterized group flake"],
        [
          `${FIXTURE}::formats word 2 3 4.5 {"x":1} { y: 2 } 0 % > case`,
          "formatted placeholders flake",
        ],
        [`${FIXTURE}::object one 2 > case`, "formatted variables flake"],
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
