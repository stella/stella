// Chat mutation matrix runner.
//
// scripts/chat-mutation-matrix.json lists behaviours of the chat pipeline, each
// as a one-behaviour mutation of the current tree, the scenario test that
// exercises it and the oracle that must fail without it. For every active
// entry the runner checks that the scenario passes unmutated, applies the
// mutation, and requires the scenario to fail AT that oracle: the failure
// output must name the oracle id. A failure that names no oracle (a compile
// error, a setup failure, a timeout) is not a kill. The file is restored after
// every run, whatever happens.
//
// An entry whose mutation no longer applies (its search text is gone or not
// unique) fails until it is replaced, or retired with a reason. `pending`
// entries describe a behaviour the tree does not have yet.
//
// Modes:
//   bun apps/api/scripts/chat-mutation-matrix.ts            run every active entry
//   bun apps/api/scripts/chat-mutation-matrix.ts --only ID  run one entry
//   bun apps/api/scripts/chat-mutation-matrix.ts --check    validate the data only
//
// On demand and nightly (`.github/workflows/nightly-property-test.yml`), never
// per PR: each entry runs its scenario twice.

import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
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
  const timer = setTimeout(() => {
    child.kill();
  }, SCENARIO_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
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
  const original = readFileSync(target, "utf-8");
  const restore = () => {
    writeFileSync(target, original);
  };
  process.once("SIGINT", restore);
  try {
    writeFileSync(
      target,
      original.replace(entry.search, () => entry.replace),
    );
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
  } finally {
    restore();
    process.off("SIGINT", restore);
  }
};

const main = async (): Promise<number> => {
  const args = process.argv.slice(2);
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
