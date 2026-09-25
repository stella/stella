// Chat mutation matrix runner.
//
// scripts/chat-mutation-matrix.json lists behaviours of the chat pipeline, each
// as a one-behaviour mutation of the current tree, the scenario test that
// exercises it and the oracle that must fail without it. For every active
// entry the runner checks that the scenario passes unmutated, applies the
// mutation, and requires the scenario to fail AT that oracle: the failure
// output must name the oracle id. A failure that names no oracle (a compile
// error, a setup failure, a timeout) is not a kill. The file is restored after
// every run, and on SIGINT, SIGTERM, SIGHUP or an uncaught error the runner
// restores it, stops the scenario and exits without starting the next entry.
//
// An entry whose mutation no longer applies (its search text is gone or not
// unique) fails until it is replaced, or retired with a reason. `pending`
// entries describe a behaviour the tree does not have yet.
//
// Modes:
//   bun apps/api/scripts/chat-mutation-matrix.ts            run every active entry
//   bun apps/api/scripts/chat-mutation-matrix.ts --only ID  run one entry
//   bun apps/api/scripts/chat-mutation-matrix.ts --check    validate the data only
//   bun apps/api/scripts/chat-mutation-matrix.ts --self-test check the restore
//
// On demand and nightly (`.github/workflows/nightly-property-test.yml`), never
// per PR: each entry runs its scenario twice.

import { panic } from "better-result";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CHAT_ORACLE } from "../src/tests/helpers/chat-oracles";

const API_ROOT = path.resolve(import.meta.dir, "..");
const MATRIX_PATH = path.join(import.meta.dir, "chat-mutation-matrix.json");
const SCENARIO_TIMEOUT_MS = 10 * 60_000;
const ORACLE_IDS = new Set<string>(Object.values(CHAT_ORACLE));

type Entry = {
  behaviour: string;
  file: string;
  fix: string;
  id: string;
  oracle: string;
  reason?: string;
  replace: string;
  scenario: { file: string; test: string };
  search: string;
  status: "active" | "pending" | "retired";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEntry = (value: unknown): value is Entry => {
  if (!isRecord(value)) {
    return false;
  }
  const scenario = value["scenario"];
  return (
    ["behaviour", "file", "fix", "id", "oracle", "replace", "search"].every(
      (key) => typeof value[key] === "string",
    ) &&
    (value["status"] === "active" ||
      value["status"] === "pending" ||
      value["status"] === "retired") &&
    isRecord(scenario) &&
    typeof scenario["file"] === "string" &&
    typeof scenario["test"] === "string"
  );
};

const readMatrix = (): Entry[] => {
  const parsed: unknown = JSON.parse(readFileSync(MATRIX_PATH, "utf-8"));
  const entries =
    typeof parsed === "object" && parsed !== null && "entries" in parsed
      ? parsed.entries
      : undefined;
  if (!Array.isArray(entries) || !entries.every(isEntry)) {
    return panic(`${MATRIX_PATH} does not match the entry shape`);
  }
  return entries;
};

/** Problems with the data itself, before anything runs. */
const validate = (entries: readonly Entry[]): string[] => {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      problems.push(`${entry.id}: duplicate id`);
    }
    ids.add(entry.id);
    if (!ORACLE_IDS.has(entry.oracle)) {
      problems.push(`${entry.id}: unknown oracle ${entry.oracle}`);
    }
    if (entry.status !== "active" && (entry.reason ?? "").trim() === "") {
      problems.push(`${entry.id}: a ${entry.status} entry needs a reason`);
    }
    if (entry.status === "active") {
      const source = readFileSync(path.join(API_ROOT, entry.file), "utf-8");
      const occurrences = source.split(entry.search).length - 1;
      if (entry.search === "" || occurrences !== 1) {
        problems.push(
          `${entry.id}: the mutation no longer applies (${String(occurrences)} matches in ${entry.file}); replace it or retire it with a reason`,
        );
      }
    }
  }
  return problems;
};

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, (character) => `\\${character}`);

type ScenarioRun = { output: string; passed: boolean; timedOut: boolean };

/** The scenario process running now, stopped if the runner is. */
let activeScenario: Bun.Subprocess | undefined;

type TerminationSignal = Extract<
  NodeJS.Signals,
  "SIGHUP" | "SIGINT" | "SIGTERM"
>;

/** The signals that stop the runner, with the exit code each one ends in. */
const TERMINATION_SIGNALS = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
} as const satisfies Record<TerminationSignal, number>;

/**
 * Runs `body` with `target` holding `mutated`, then puts the original back.
 * A termination signal or an uncaught error restores it too, stops the
 * scenario and exits, so no mutation outlives the runner and no later entry
 * starts.
 */
const withMutatedFile = async <T>(
  target: string,
  mutated: string,
  body: () => Promise<T>,
): Promise<T> => {
  const original = readFileSync(target, "utf-8");
  const restore = () => {
    writeFileSync(target, original);
  };
  const abandon = (exitCode: number) => {
    restore();
    activeScenario?.kill();
    process.exit(exitCode);
  };
  const onSignal = (signal: TerminationSignal) => {
    abandon(TERMINATION_SIGNALS[signal]);
  };
  const onUncaught = (error: unknown) => {
    console.error(error);
    abandon(1);
  };
  const signals = Object.keys(TERMINATION_SIGNALS).filter(
    (name): name is TerminationSignal => name in TERMINATION_SIGNALS,
  );
  for (const signal of signals) {
    process.once(signal, onSignal);
  }
  process.once("uncaughtException", onUncaught);
  process.once("unhandledRejection", onUncaught);
  try {
    writeFileSync(target, mutated);
    return await body();
  } finally {
    restore();
    for (const signal of signals) {
      process.off(signal, onSignal);
    }
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
  }
};

const runScenario = async (
  scenario: Entry["scenario"],
): Promise<ScenarioRun> => {
  const child = Bun.spawn(
    [
      "bun",
      "run",
      "test",
      scenario.file,
      "-t",
      `^.* ${escapeRegExp(scenario.test)}$`,
    ],
    { cwd: API_ROOT, stderr: "pipe", stdout: "pipe" },
  );
  activeScenario = child;
  const timer = setTimeout(() => {
    child.kill();
  }, SCENARIO_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  activeScenario = undefined;
  const output = `${stdout}\n${stderr}`;
  return {
    output,
    passed: exitCode === 0 && /\b[1-9]\d* pass\b/u.test(output),
    timedOut: child.signalCode !== null,
  };
};

const namesOracle = (output: string, oracle: string): boolean =>
  output.includes(`"oracle":"${oracle}"`) ||
  output.includes(`"oracle": "${oracle}"`);

type Verdict = { detail: string; entry: Entry; killed: boolean };

const runEntry = async (
  entry: Entry,
  baselines: Map<string, ScenarioRun>,
): Promise<Verdict> => {
  const key = `${entry.scenario.file}::${entry.scenario.test}`;
  const baseline = baselines.get(key) ?? (await runScenario(entry.scenario));
  baselines.set(key, baseline);
  if (!baseline.passed) {
    return { detail: "the unmutated scenario fails", entry, killed: false };
  }
  const target = path.join(API_ROOT, entry.file);
  const mutatedSource = readFileSync(target, "utf-8").replace(
    entry.search,
    () => entry.replace,
  );
  return await withMutatedFile(target, mutatedSource, async () => {
    const mutated = await runScenario(entry.scenario);
    if (mutated.timedOut) {
      return { detail: "timed out (not a kill)", entry, killed: false };
    }
    if (mutated.passed) {
      return {
        detail: "survived: the scenario still passes",
        entry,
        killed: false,
      };
    }
    return namesOracle(mutated.output, entry.oracle)
      ? { detail: `failed at ${entry.oracle}`, entry, killed: true }
      : {
          detail: `failed without naming ${entry.oracle} (not a kill)`,
          entry,
          killed: false,
        };
  });
};

/**
 * `--hold`: mutates `file` and waits, or throws once it is mutated with
 * `--throw`; the self-test ends it from outside.
 */
const hold = async (file: string, throws: boolean): Promise<never> =>
  await withMutatedFile(file, "mutated\n", async () => {
    console.log("mutated");
    if (throws) {
      setTimeout(() => {
        panic("an uncaught error while mutated");
      }, 0);
    }
    return await new Promise<never>(() => {
      // Keeps the process alive until the self-test ends it.
      setInterval(() => undefined, 60_000);
    });
  });

/** Every way the runner can be ended leaves the file as it was. */
const selfTest = async (): Promise<number> => {
  const directory = mkdtempSync(path.join(tmpdir(), "chat-mutation-matrix-"));
  const failures: string[] = [];
  try {
    const endings = [
      ...(["SIGHUP", "SIGINT", "SIGTERM"] as const).map(
        (signal: TerminationSignal) => ({
          code: TERMINATION_SIGNALS[signal],
          label: signal,
          signal,
          throws: false,
        }),
      ),
      { code: 1, label: "uncaught error", signal: undefined, throws: true },
    ];
    for (const ending of endings) {
      const file = path.join(directory, `${ending.label}.ts`);
      writeFileSync(file, "original\n");
      const child = Bun.spawn(
        [
          "bun",
          import.meta.path,
          "--hold",
          file,
          ...(ending.throws ? ["--throw"] : []),
        ],
        { stderr: "ignore", stdout: "pipe" },
      );
      const reader = child.stdout.getReader();
      const first = await reader.read();
      const mutated = readFileSync(file, "utf-8") === "mutated\n";
      if (ending.signal !== undefined) {
        child.kill(ending.signal);
      }
      const exitCode = await child.exited;
      const restored = readFileSync(file, "utf-8") === "original\n";
      if (first.done || !mutated) {
        failures.push(`${ending.label}: the file was never mutated`);
      }
      if (!restored) {
        failures.push(`${ending.label}: the file was not restored`);
      }
      if (exitCode !== ending.code) {
        failures.push(
          `${ending.label}: exited ${String(exitCode)}, expected ${String(ending.code)}`,
        );
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  if (failures.length === 0) {
    console.log("chat mutation matrix self-test: ok.");
  }
  return failures.length === 0 ? 0 : 1;
};

const main = async (): Promise<number> => {
  const args = process.argv.slice(2);
  const holdIndex = args.indexOf("--hold");
  if (holdIndex !== -1) {
    return await hold(
      args[holdIndex + 1] ?? panic("--hold needs a file"),
      args.includes("--throw"),
    );
  }
  if (args.includes("--self-test")) {
    return await selfTest();
  }
  const entries = readMatrix();
  const problems = validate(entries);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    return 1;
  }
  if (args.includes("--check")) {
    console.log(
      `chat mutation matrix: ${String(entries.length)} entries valid.`,
    );
    return 0;
  }
  const onlyIndex = args.indexOf("--only");
  const only = onlyIndex === -1 ? undefined : args[onlyIndex + 1];
  const baselines = new Map<string, ScenarioRun>();
  const rows: string[] = ["| fix | entry | result |", "| --- | --- | --- |"];
  let failed = 0;
  for (const entry of entries) {
    if (only !== undefined && entry.id !== only) {
      continue;
    }
    if (entry.status !== "active") {
      rows.push(
        `| ${entry.fix} | ${entry.id} | ${entry.status}: ${entry.reason ?? ""} |`,
      );
      continue;
    }
    const verdict = await runEntry(entry, baselines);
    if (!verdict.killed) {
      failed += 1;
    }
    rows.push(
      `| ${entry.fix} | ${entry.id} | ${verdict.killed ? "killed" : "NOT KILLED"}: ${verdict.detail} |`,
    );
    console.log(rows.at(-1));
  }
  console.log(`\n${rows.join("\n")}`);
  return failed === 0 ? 0 : 1;
};

if (import.meta.main) {
  process.exit(await main());
}
