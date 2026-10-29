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
const RECEIVER_FIXTURE = "pkg/receivers.test.ts";
const RECEIVER_SOURCE = `import { describe, expect, test } from "bun:test";

test.skip("native skip", () => {
  throw new Error("test.skip ran");
});
test.skip.if(true)("conditional native skip", () => {
  throw new Error("test.skip.if ran");
});
test.if(false)("false native condition", () => {
  throw new Error("test.if(false) ran");
});
test.each([[1], [2]])("test row %i", (value) => {
  expect(value).toBeGreaterThan(0);
});
describe.each([["one"], ["two"]])("describe row %s", (value) => {
  test("runs", () => {
    expect(value.length).toBeGreaterThan(0);
  });
});
test("quarantined pass", () => {
  expect(true).toBe(true);
});
`;
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
  describe.if(true).each([["one"]])("conditional %s", () => {
    test("conditional case", () => {
      throw new Error("conditional group flake");
    });
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
  source?: string;
};

const run = ({
  names,
  failUnquarantined = false,
  reportDir = "set",
  source = SOURCE,
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
  const {
    BUN_OPTIONS: _options,
    FLAKY_TEST_QUARANTINE_REPORT_DIR: _reportDirectory,
    FLAKY_TEST_QUARANTINE_REGISTRY: _registry,
    ...inherited
  } = process.env;
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
    root,
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
    records,
  };
};

type ReceiverFixtureOptions = {
  preload: boolean;
  extraSource?: string;
  names?: readonly string[];
};

const runReceiverFixture = ({
  preload,
  extraSource = "",
  names = ["quarantined pass"],
}: ReceiverFixtureOptions) => {
  const root = mkdtempSync(path.join(tmpdir(), "flaky-quarantine-receivers-"));
  roots.push(root);
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "pkg"));
  writeFileSync(
    path.join(root, RECEIVER_FIXTURE),
    `${RECEIVER_SOURCE}\n${extraSource}`,
  );
  writeFileSync(
    path.join(root, "scripts/flaky-test-quarantine.json"),
    serializeRegistry({
      entries: names.map((name) => ({
        ...entry(name),
        id: `${RECEIVER_FIXTURE}::${name}`,
      })),
    }),
  );
  const reports = path.join(root, "reports");
  const {
    BUN_OPTIONS: _options,
    FLAKY_TEST_QUARANTINE_REPORT_DIR: _reportDirectory,
    FLAKY_TEST_QUARANTINE_REGISTRY: _registry,
    ...inherited
  } = process.env;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", `./${RECEIVER_FIXTURE}`],
    cwd: root,
    env: {
      ...inherited,
      ...(preload
        ? {
            BUN_OPTIONS: `--preload=${PRELOAD}`,
            [QUARANTINE_REGISTRY_ENV]: path.join(
              root,
              "scripts/flaky-test-quarantine.json",
            ),
            [QUARANTINE_REPORT_DIR_ENV]: reports,
          }
        : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
    records: (existsSync(reports) ? readdirSync(reports) : []).flatMap((file) =>
      readFileSync(path.join(reports, file), "utf-8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line): QuarantineRecord =>
          v.parse(quarantineRecordSchema, JSON.parse(line)),
        ),
    ),
  };
};

const compareTuple = (
  left: readonly string[],
  right: readonly string[],
): number => compareCodeUnit(left.join("\0"), right.join("\0"));

const FAILING = [
  "outer > inner > throws",
  "outer > conditional one > conditional case",
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
  test("matches tests inside an enabled Postgres-gated suite", () => {
    const name = "Postgres gate > quarantined case";
    const result = run({
      names: [name],
      source: `import { describe, test } from "bun:test";
const runPostgresTests = true;
describe.skipIf(!runPostgresTests)("Postgres gate", () => {
  test("quarantined case", () => {
    throw new TypeError("fixture failure");
  });
});`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.records).toContainEqual(
      expect.objectContaining({ id: `${FIXTURE}::${name}`, type: "failed" }),
    );
  });

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

  test("preserves Bun receiver semantics for native test and describe forms", () => {
    const native = runReceiverFixture({ preload: false });
    const preloaded = runReceiverFixture({ preload: true });

    expect(native.exitCode).toBe(0);
    expect(preloaded.exitCode).toBe(0);
    for (const result of [native, preloaded]) {
      expect(result.output).toMatch(/5 pass/u);
      expect(result.output).toMatch(/3 skip/u);
      expect(result.output).toMatch(/0 fail/u);
      expect(result.output).not.toContain("test.skip ran");
      expect(result.output).not.toContain("test.skip.if ran");
      expect(result.output).not.toContain("test.if(false) ran");
    }
  });

  test.each([
    {
      form: "describe.skip.if",
      source: `describe.skip.if(true)("conditional skipped group", () => {
        test("skipped child", () => { throw new Error("skipped child ran"); });
      });`,
    },
    {
      form: "describe.if.each",
      source: `describe.if(true).each([["native"]])("conditional %s", () => {
        test("conditional child", () => { expect(true).toBe(true); });
      });`,
    },
    {
      form: "describe.concurrent.each",
      source: `describe.concurrent.each([["native"]])("concurrent %s", () => {
        test("concurrent child", () => { expect(true).toBe(true); });
      });`,
    },
    {
      form: "test.concurrent.if",
      source: `test.concurrent.if(true)("conditional concurrent case", () => {
        expect(true).toBe(true);
      });`,
    },
    {
      form: "test.serial.if",
      source: `test.serial.if(true)("conditional serial case", () => {
        expect(true).toBe(true);
      });`,
    },
    {
      form: "test.if.concurrent",
      source: `test.if(true).concurrent("concurrent conditional case", () => {
        expect(true).toBe(true);
      });`,
    },
  ])("preserves native outcomes through $form", ({ source }) => {
    const native = runReceiverFixture({ preload: false, extraSource: source });
    const preloaded = runReceiverFixture({
      preload: true,
      extraSource: source,
    });
    expect(native.exitCode).toBe(0);
    expect(native.output).toMatch(/\b[1-9]\d* pass\b/u);
    expect(preloaded.exitCode).toBe(0);
    expect(preloaded.output.match(/\b\d+ (?:pass|skip|fail)\b/gu)).toEqual(
      native.output.match(/\b\d+ (?:pass|skip|fail)\b/gu),
    );
  });

  test.each([
    "test.if(true)",
    "test.skipIf(false)",
    "test.concurrent.if(true)",
    "test.serial.if(true)",
    "test.if(true).concurrent",
    "test.skipIf(false).serial",
  ])(
    "records matching failures through %s without suppressing other IDs",
    (form) => {
      const extraSource = `${form}("chained failure", () => {
      throw new Error("chained flake");
    });`;
      const id = `${RECEIVER_FIXTURE}::chained failure`;
      const quarantined = runReceiverFixture({
        preload: true,
        extraSource,
        names: ["quarantined pass", "chained failure"],
      });
      expect(quarantined.exitCode, quarantined.output).toBe(0);
      expect(quarantined.records).toContainEqual({ type: "registered", id });
      expect(quarantined.records).toContainEqual(
        expect.objectContaining({
          type: "failed",
          id,
          message: "chained flake",
        }),
      );

      const unquarantined = runReceiverFixture({ preload: true, extraSource });
      expect(unquarantined.exitCode).not.toBe(0);
      expect(unquarantined.output).toContain("chained flake");
      expect(
        unquarantined.records.some(
          (record) => "id" in record && record.id === id,
        ),
      ).toBe(false);
    },
  );

  test("keeps test.each outside quarantine after conditional modifiers", () => {
    const result = runReceiverFixture({
      preload: true,
      extraSource: `test.concurrent.if(true).each([[1]])("table case %i", () => {
        throw new Error("table failure");
      });`,
      names: ["quarantined pass", "table case 1"],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("table failure");
    expect(
      result.records.some(
        (record) =>
          "id" in record && record.id === `${RECEIVER_FIXTURE}::table case 1`,
      ),
    ).toBe(false);
  });

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
    expect(exitCode, output).toBe(0);
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
        [
          `${FIXTURE}::outer > conditional one > conditional case`,
          "conditional group flake",
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
