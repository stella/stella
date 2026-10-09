import { Result, panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import type { GatedTestSelection } from "../apps/api/scripts/gated-test-selection";
import { planPostgresTests } from "./ci-postgres-test-plan";
import { parseJunit } from "./fix-tests-on-base";

const normalizeFailedFile = (file: string | undefined): string => {
  if (file === undefined || file === "") {
    return panic("Postgres JUnit failure is missing a testcase file attribute");
  }
  const slashed = file.replaceAll("\\", "/");
  if (path.posix.isAbsolute(slashed) || path.win32.isAbsolute(slashed)) {
    return panic(
      `Postgres JUnit failure has an absolute testcase file: ${file}`,
    );
  }
  let normalized = slashed;
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  if (normalized.startsWith("apps/api/")) {
    normalized = normalized.slice("apps/api/".length);
  }
  if (
    normalized.split("/").includes("..") ||
    !/\.test\.tsx?$/u.test(normalized)
  ) {
    return panic(
      `Postgres JUnit failure has an invalid testcase file: ${file}`,
    );
  }
  return normalized;
};

export const readPostgresFailures = (xml: string): string[] => {
  const failures = new Set<string>();
  const report = parseJunit(xml, (file) => {
    failures.add(normalizeFailedFile(file));
  });
  if (report.cases.length === 0) {
    return panic("Postgres JUnit report contains zero testcases");
  }
  if (!/<\/testsuites>\s*$/u.test(xml)) {
    return panic("Postgres JUnit report is incomplete");
  }
  return [...failures].toSorted();
};

type PostgresSelectorMissesOptions = {
  selection: GatedTestSelection;
  failingFiles: readonly string[];
};

export const postgresSelectorMisses = ({
  selection,
  failingFiles,
}: PostgresSelectorMissesOptions): string[] => {
  switch (selection.mode) {
    case "all":
      return [];
    case "none":
      return [...new Set(failingFiles)];
    case "selected": {
      const selected = new Set(selection.files);
      return [...new Set(failingFiles)].filter((file) => !selected.has(file));
    }
    default:
      selection satisfies never;
      return panic("Unhandled gated-test selection mode");
  }
};

export const formatPostgresSelectorMisses = (
  files: readonly string[],
): string[] => files.map((file) => `SELECTOR MISS: ${file}`);

const runCommand = (command: string[]) => {
  const result = Bun.spawnSync(command, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  if (result.exitCode !== 0) {
    panic(
      `Selector miss evidence command failed: ${command.at(0) ?? "unknown"}: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
};

const fullRunSchema = v.object({
  id: v.number(),
  display_title: v.string(),
  head_branch: v.string(),
  path: v.string(),
  event: v.string(),
  status: v.string(),
  conclusion: v.nullable(v.string()),
});

export const fullPostgresRunSha = (displayTitle: string) => {
  const sha = /^Main heavy suites ([a-f0-9]{40})$/u.exec(displayTitle)?.at(1);
  return (
    sha ??
    panic("Full Postgres run has no certified target SHA in its run name")
  );
};

if (import.meta.main) {
  const checked = await Result.tryPromise(async () => {
    const repository = process.env["REPOSITORY"] ?? panic("Missing REPOSITORY");
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) {
      panic("Invalid REPOSITORY");
    }
    const currentRun = Number(process.env["GITHUB_RUN_ID"]);
    if (!Number.isSafeInteger(currentRun) || currentRun < 1) {
      panic("Invalid GITHUB_RUN_ID");
    }
    const failures = readPostgresFailures(
      readFileSync(
        process.env["POSTGRES_JUNIT_FILE"] ??
          panic("Missing POSTGRES_JUNIT_FILE"),
        "utf-8",
      ),
    );
    if (failures.length === 0) {
      console.warn(
        "Postgres runner failed without a reported testcase failure; no file-level miss verdict is available.",
      );
      return [];
    }
    const runs = v.parse(
      v.object({ workflow_runs: v.array(fullRunSchema) }),
      JSON.parse(
        runCommand([
          "bash",
          path.join(import.meta.dir, "gh-retry.sh"),
          "api",
          `repos/${repository}/actions/workflows/main-heavy.yml/runs?status=completed&branch=main&per_page=100`,
        ]),
      ),
    );
    const candidates = runs.workflow_runs
      .filter(
        (run) =>
          run.id < currentRun &&
          run.status === "completed" &&
          ["success", "failure"].includes(run.conclusion ?? "") &&
          run.head_branch === "main" &&
          run.path === ".github/workflows/main-heavy.yml" &&
          ["push", "schedule", "workflow_dispatch"].includes(run.event),
      )
      .toSorted((a, b) => b.id - a.id);
    for (const candidate of candidates) {
      // Dispatch workflow HEAD can differ from the SHA actually tested.
      const baselineSha = fullPostgresRunSha(candidate.display_title);
      const ancestor = Bun.spawnSync(
        ["git", "merge-base", "--is-ancestor", baselineSha, "HEAD"],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (ancestor.exitCode === 1) {
        continue;
      }
      if (ancestor.exitCode !== 0) {
        panic("Cannot validate full-run baseline ancestry");
      }
      // Historical evidence retrieval is sequential and stays below one call/s.
      await Bun.sleep(1100);
      const jobs = v.parse(
        v.object({
          total_count: v.number(),
          jobs: v.array(
            v.object({
              name: v.string(),
              conclusion: v.nullable(v.string()),
              steps: v.array(
                v.object({
                  name: v.string(),
                  conclusion: v.nullable(v.string()),
                }),
              ),
            }),
          ),
        }),
        JSON.parse(
          runCommand([
            "bash",
            path.join(import.meta.dir, "gh-retry.sh"),
            "api",
            `repos/${repository}/actions/runs/${candidate.id}/jobs?per_page=100`,
          ]),
        ),
      );
      if (jobs.total_count !== jobs.jobs.length) {
        panic("Incomplete full-run job evidence");
      }
      const certified = jobs.jobs.some(
        (job) =>
          (job.name === "service-suites" ||
            job.name.endsWith(" / service-suites")) &&
          job.steps.some(
            (step) =>
              step.name === "Run Postgres-gated API suites" &&
              step.conclusion === "success",
          ),
      );
      if (!certified) {
        continue;
      }
      const changed = runCommand([
        "git",
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        baselineSha,
        "HEAD",
      ])
        .split("\0")
        .filter(Boolean);
      const selection = await planPostgresTests({
        event: "merge_group",
        scopeUnknown: false,
        changed,
      });
      console.log(
        `Postgres selector replay since full run ${candidate.id}: ${JSON.stringify(selection)}`,
      );
      return postgresSelectorMisses({ selection, failingFiles: failures });
    }
    return panic(
      "No successful ancestor full Postgres run found in bounded history",
    );
  });
  if (checked.isErr()) {
    const message = checked.error.message
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    console.log(
      `::error::Postgres selector miss check unavailable: ${message}`,
    );
    process.exitCode = 1;
  } else {
    for (const message of formatPostgresSelectorMisses(checked.value)) {
      console.log(
        `::error::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
      );
    }
    if (checked.value.length > 0) {
      process.exitCode = 1;
    }
  }
}
