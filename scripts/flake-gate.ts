import { panic, Result, TaggedError } from "better-result";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";

import apiManifest from "../apps/api/package.json" with { type: "json" };
import { isDbTest } from "../apps/api/scripts/test-batch-plan";
import { selectTestPaths } from "../apps/api/scripts/test-path-filters";
import { analyzeModule, selectApiTestImpact } from "./api-test-impact";
import { selectRustTargets } from "./flake-gate-rust";

export const REPEATS = 20;
export const BUDGET_MS = 60 * 60 * 1000;
const root = path.resolve(import.meta.dir, "..");
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const manifestSchema = v.object({
  scripts: v.optional(v.record(v.string(), v.string()), {}),
});

class FlakeGateError extends TaggedError("FlakeGateError")<{
  message: string;
}> {}

export type Target = {
  file: string;
  cwd: string;
  command: string[];
  env: Record<string, string>;
  runner: "bun" | "rust";
};
export type Skipped = { file: string; reason: string };
type SelectOptions = {
  root: string;
  changed: readonly string[];
  hasDb: boolean;
  apiImpact?: typeof selectApiTestImpact;
};

export const selectTargets = ({
  root: repo,
  changed,
  hasDb,
  apiImpact = selectApiTestImpact,
}: SelectOptions) => {
  const skipped: Skipped[] = [];
  const targets: Target[] = [];
  let candidates = changed.filter((file) => TEST_FILE.test(file));
  // The gate repeats changed tests only; API impact must never widen it to unchanged suites.
  if (candidates.some((file) => file.startsWith("apps/api/"))) {
    const impact = apiImpact({ root: repo, changed });
    const selected =
      impact.mode === "selected"
        ? selectTestPaths(
            impact.files,
            candidates
              .filter((file) => file.startsWith("apps/api/"))
              .map((file) => file.slice("apps/api/".length)),
          )
        : null;
    candidates = candidates.filter(
      (file) =>
        !file.startsWith("apps/api/") ||
        impact.mode !== "selected" ||
        selected?.has(file.slice("apps/api/".length)),
    );
  }
  for (const file of [...new Set(candidates)].toSorted()) {
    const absolute = path.join(repo, file);
    if (!existsSync(absolute)) {
      skipped.push({ file, reason: "deleted" });
      continue;
    }
    const source = readFileSync(absolute, "utf-8");
    if (
      analyzeModule(file, source).imports.some(({ path: specifier }) =>
        ["@playwright/test", "playwright/test"].includes(specifier),
      ) ||
      (/(?:^|\/)e2e\//u.test(file) && file.includes(".spec."))
    ) {
      skipped.push({ file, reason: "Playwright: not gated in v1" });
      continue;
    }
    if (!hasDb && /\.(?:db|postgres)\.(?:test|spec)\./u.test(file)) {
      skipped.push({ file, reason: "not gated (needs DB)" });
      continue;
    }
    let cwd = path.dirname(absolute);
    while (cwd !== repo && !existsSync(path.join(cwd, "package.json"))) {
      cwd = path.dirname(cwd);
    }
    const manifest = v.parse(
      manifestSchema,
      JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf-8")),
    );
    let script = "test";
    let env: Record<string, string> = {};
    if (file.startsWith("apps/api/")) {
      const relative = file.slice("apps/api/".length);
      const gated = Object.entries(apiManifest.ciGateTestRunners).filter(
        ([, config]) => source.includes(config.gate),
      );
      const gate = gated.at(0);
      if (gated.length > 1 || (gate && gate[0] !== "test:postgres")) {
        skipped.push({ file, reason: "needs a dedicated service runner" });
        continue;
      }
      if (!hasDb && (gate || isDbTest(relative, source))) {
        skipped.push({ file, reason: "not gated (needs DB)" });
        continue;
      }
      if (gate) {
        script = gate[0];
        env = Object.fromEntries([[gate[1].gate, gate[1].gateValue]]);
      }
    }
    const testScript = manifest.scripts[script];
    if (cwd !== repo && (!testScript || !/\bbun\b/u.test(testScript))) {
      skipped.push({ file, reason: "owning package has no Bun test command" });
      continue;
    }
    targets.push({
      file,
      cwd,
      command:
        cwd === repo
          ? [process.execPath, "test", `./${file}`]
          : [
              process.execPath,
              "run",
              script,
              "--",
              `./${repoRelativePath(cwd, absolute)}`,
            ],
      env,
      runner: "bun",
    });
  }
  const rust = selectRustTargets(repo, changed);
  for (const target of rust.targets) {
    targets.push({
      file: target.file,
      cwd: target.cwd,
      command: [
        "cargo",
        "test",
        "-p",
        target.crate,
        target.module,
        "--",
        "--test-threads=1",
      ],
      env: {},
      runner: "rust",
    });
  }
  skipped.push(...rust.unsupported);
  return { targets, skipped };
};

type Measured = { file: string; durationMs: number };
/** Probe cost is already spent. Allocate remaining work fastest first; slow files lose repeats first. */
export const planRepeats = (
  measured: readonly Measured[],
  remainingMs: number,
) => {
  const repeats = new Map(measured.map(({ file }) => [file, 1]));
  let remaining = Math.max(0, remainingMs);
  for (const { file, durationMs } of measured.toSorted(
    (a, b) => a.durationMs - b.durationMs,
  )) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      panic("Expected positive finite duration");
    }
    const extra = Math.min(REPEATS - 1, Math.floor(remaining / durationMs));
    repeats.set(file, 1 + extra);
    remaining -= extra * durationMs;
  }
  return repeats;
};

export type Measurement = {
  file: string;
  runs: number;
  failures: number;
  durationMs: number;
  planned: number;
};
export type Report = {
  results: Measurement[];
  skipped: Skipped[];
  errors: string[];
  elapsedMs: number;
};
const markdown = (value: string) =>
  value
    .replaceAll("|", "\\|")
    .replaceAll(/\r?\n/gu, " ")
    .replaceAll("`", "\\`");
export const renderReport = (report: Report) =>
  [
    "## Changed-test flake gate (report only by default)",
    "",
    `Target: ${REPEATS} runs (Bun: seeded shuffle; Rust: serial order). Budget: 60 test-minutes, including probes. Used: ${(report.elapsedMs / 60_000).toFixed(2)} minutes.`,
    "Failures include persistent failures and runner errors; they require investigation before being called flakes.",
    "",
    "| Test | Runs | Failures | Coverage |",
    "| --- | ---: | ---: | --- |",
    ...report.results.map(
      ({ file, runs, failures }) =>
        `| ${markdown(file)} | ${runs} | ${failures} | ${runs < REPEATS ? "reduced repeats (cost cap)" : "full"} |`,
    ),
    ...report.skipped.map(
      ({ file, reason }) =>
        `| ${markdown(file)} | 0 | 0 | ${markdown(reason)} |`,
    ),
    ...report.errors.map((error) => `\nRunner error: ${markdown(error)}`),
    "",
  ].join("\n");
export const reportExitCode = (report: Report, blocking: boolean) =>
  blocking &&
  (report.errors.length > 0 ||
    report.results.some(({ failures }) => failures > 0))
    ? 1
    : 0;
const annotation = (value: string) =>
  value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(",", "%2C")
    .replaceAll(":", "%3A");

type RunOptions = { target: Target; seed: number; timeoutMs: number };
const outputTail = async (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  let tail = "";
  for await (const chunk of stream) {
    tail = (tail + decoder.decode(chunk, { stream: true })).slice(-65_536);
  }
  return tail + decoder.decode();
};
export const runOnce = async ({ target, seed, timeoutMs }: RunOptions) => {
  // Native --rerun-each repeats cases in place. Fresh invocations reset shared setup
  // and shuffle the whole file for each trial; fixed seeds reproduce each order.
  const args =
    target.runner === "bun"
      ? ["--rerun-each=1", "--randomize", `--seed=${seed}`]
      : [];
  const child = Bun.spawn([...target.command, ...args], {
    cwd: target.cwd,
    env: { ...process.env, ...target.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  const timer = setTimeout(
    () => {
      if (process.platform === "win32") {
        child.kill("SIGKILL");
      } else {
        const killed = Result.try(() => process.kill(-child.pid, "SIGKILL"));
        if (killed.isErr()) {
          console.warn(
            `::warning::Failed to terminate timed-out process group ${child.pid}`,
          );
        }
      }
    },
    Math.max(1, Math.floor(timeoutMs)),
  );
  const captured = await Result.tryPromise(async () =>
    Promise.all([
      child.exited,
      outputTail(child.stdout),
      outputTail(child.stderr),
    ]),
  );
  clearTimeout(timer);
  if (captured.isErr()) {
    throw captured.error;
  }
  const [status, stdout, stderr] = captured.value;
  const output = `${stdout}\n${stderr}`;
  const ranTests =
    target.runner === "bun"
      ? /\b[1-9]\d* (?:pass|fail)\b/u.test(output)
      : /test result:.*\b[1-9]\d* (?:passed|failed)/u.test(output);
  return { passed: status === 0 && ranTests, status, ranTests };
};

type ExecuteOptions = {
  targets: readonly Target[];
  skipped: Skipped[];
  run?: typeof runOnce;
  now?: () => number;
  budgetMs?: number;
};
export const executeGate = async ({
  targets,
  skipped,
  run = runOnce,
  now = () => performance.now(),
  budgetMs = BUDGET_MS,
}: ExecuteOptions): Promise<Report> => {
  const start = now();
  const report: Report = {
    results: [],
    skipped: [...skipped],
    errors: [],
    elapsedMs: 0,
  };
  const measured: Measured[] = [];
  const remaining = () => Math.max(0, budgetMs - (now() - start));
  const attempt = async (options: RunOptions) => {
    const outcome = await Result.tryPromise(async () => run(options));
    if (outcome.isOk()) {
      return outcome.value;
    }
    report.errors.push(`${options.target.file}: ${outcome.error.message}`);
    return { passed: false, status: 1, ranTests: false };
  };
  for (const target of targets) {
    if (remaining() <= 0) {
      report.skipped.push({
        file: target.file,
        reason: "not gated (cost cap)",
      });
      continue;
    }
    const before = now();
    const outcome = await attempt({ target, seed: 1, timeoutMs: remaining() });
    const durationMs = Math.max(1, now() - before);
    measured.push({ file: target.file, durationMs });
    report.results.push({
      file: target.file,
      runs: 1,
      failures: Number(!outcome.passed),
      durationMs,
      planned: 1,
    });
  }
  const plan = planRepeats(measured, remaining());
  for (const result of report.results.toSorted(
    (a, b) => a.durationMs - b.durationMs,
  )) {
    const target = targets.find(({ file }) => file === result.file);
    if (!target) {
      panic(`Missing target: ${result.file}`);
    }
    const planned = plan.get(result.file);
    if (planned === undefined) {
      panic(`Missing repeat plan: ${result.file}`);
    }
    result.planned = planned;
    for (
      let index = 1;
      index < result.planned && remaining() >= result.durationMs;
      index += 1
    ) {
      const outcome = await attempt({
        target,
        seed: index + 1,
        timeoutMs: remaining(),
      });
      result.runs += 1;
      result.failures += Number(!outcome.passed);
    }
  }
  report.elapsedMs = now() - start;
  return report;
};

if (import.meta.main) {
  const report: Report = { results: [], skipped: [], errors: [], elapsedMs: 0 };
  const outcome = await Result.tryPromise(async () => {
    const base = process.env["BASE_SHA"] || "origin/main";
    // Match ci-plan: NUL-delimited paths, no rename inference, merge-base diff.
    const diff = Bun.spawn(
      ["git", "diff", "--name-only", "-z", "--no-renames", `${base}...HEAD`],
      { cwd: root, stdout: "pipe", stderr: "inherit" },
    );
    const changed = (await new Response(diff.stdout).text())
      .split("\0")
      .filter(Boolean);
    if ((await diff.exited) !== 0) {
      throw new FlakeGateError({ message: "Cannot read PR diff" });
    }
    return executeGate(
      selectTargets({
        root,
        changed,
        hasDb: Boolean(process.env["DATABASE_URL"]),
      }),
    );
  });
  if (outcome.isErr()) {
    report.errors.push(outcome.error.message);
  }
  const finalReport = outcome.isOk() ? outcome.value : report;
  writeFileSync("flake-gate-report.json", JSON.stringify(finalReport, null, 2));
  const summary = renderReport(finalReport);
  console.log(summary);
  if (process.env["GITHUB_STEP_SUMMARY"]) {
    appendFileSync(process.env["GITHUB_STEP_SUMMARY"], summary);
  }
  for (const result of finalReport.results.filter(
    ({ failures }) => failures > 0,
  )) {
    console.log(
      `::warning file=${annotation(result.file)}::${result.failures}/${result.runs} runs failed`,
    );
  }
  for (const error of finalReport.errors) {
    console.log(`::warning::${annotation(error)}`);
  }
  process.exitCode = reportExitCode(
    finalReport,
    process.argv.includes("--blocking"),
  );
}
