import { Result } from "better-result";
import { deepEquals } from "bun";
import { appendFileSync } from "node:fs";
import path from "node:path";

import { writeDecision } from "./ci-job-classification/decisions";
import {
  generateClassification,
  readClassificationInputs,
  readClassificationInputsAtRevision,
} from "./ci-job-classification/generate";
import type { DerivedJob } from "./ci-job-classification/generate";
import {
  CLASSIFICATION_DECISIONS_PATH,
  decisionPathForKey,
  isClassificationInput,
} from "./ci-job-classification/inputs";
import { ReviewRequiredError } from "./ci-job-classification/review";
import { AdmissionError } from "./ci-job-classification/yaml";

type ClassificationInputs = ReturnType<typeof readClassificationInputs>;
const generateWithJobs = (inputs: ClassificationInputs) => {
  let jobs: ReadonlyMap<string, DerivedJob> | undefined;
  const result = generateClassification({
    ...inputs,
    observeJobs: (derived) => {
      jobs = derived;
    },
  });
  if (!jobs) {
    if (result.isErr()) {
      throw result.error;
    }
    throw new AdmissionError({ message: "Derived jobs missing" });
  }
  return { jobs, result, workflowCount: inputs.reader.workflows().length };
};

type SensitiveChangesOptions = {
  head: ReturnType<typeof generateWithJobs>;
  headDecisions: ClassificationInputs["decisions"];
  base: ReturnType<typeof generateWithJobs>;
  baseDecisions: ClassificationInputs["decisions"];
};
// A job is unchanged only when it exists in both revisions with the same
// shape and the same whole reviewed decision (kind, qualifier and digest);
// a job removed from the head is a change too.
const sensitiveChanges = ({
  head,
  headDecisions,
  base,
  baseDecisions,
}: SensitiveChangesOptions) =>
  [...new Set([...head.jobs.keys(), ...base.jobs.keys()])].flatMap((key) => {
    const current = head.jobs.get(key);
    const previous = base.jobs.get(key);
    const previousDecision = baseDecisions[key];
    if (
      current !== undefined &&
      previousDecision?.reviewedDigest === current.digest &&
      deepEquals(previousDecision, headDecisions[key])
    ) {
      return [];
    }
    return current?.privileged || previous?.privileged ? [key] : [];
  });

// A stale digest is a mechanical refresh only when nothing a reviewer decides
// moved: the job existed at the base, its kind and qualifier are unchanged,
// and it is not privileged at either revision. New jobs, kind or qualifier
// edits and every privileged job keep failing until a human reviews them.
const mechanicalRefreshes = ({
  head,
  headDecisions,
  base,
  baseDecisions,
}: SensitiveChangesOptions) =>
  [...head.jobs].flatMap(([key, job]) => {
    const decision = headDecisions[key];
    const previousDecision = baseDecisions[key];
    const previous = base.jobs.get(key);
    if (
      decision === undefined ||
      decision.reviewedDigest === job.digest ||
      previousDecision === undefined ||
      previous === undefined ||
      decision.kind !== previousDecision.kind ||
      decision.qualifier !== previousDecision.qualifier ||
      job.privileged ||
      previous.privileged
    ) {
      return [];
    }
    return [{ key, digest: job.digest }];
  });

const generateBase = (root: string, base: string) => {
  const inputs = readClassificationInputsAtRevision(root, base);
  const generation = generateWithJobs(inputs);
  if (
    generation.result.isErr() &&
    !(generation.result.error instanceof ReviewRequiredError)
  ) {
    throw generation.result.error;
  }
  return { inputs, generation };
};

// Rewrites only the digests of mechanical refreshes.
export const refreshJobClassificationDigests = (root: string, base: string) =>
  Result.try({
    try: () => {
      const headInputs = readClassificationInputs(root);
      const head = generateWithJobs(headInputs);
      const baseRevision = generateBase(root, base);
      const refreshes = mechanicalRefreshes({
        head,
        headDecisions: headInputs.decisions,
        base: baseRevision.generation,
        baseDecisions: baseRevision.inputs.decisions,
      });
      if (refreshes.length > 0) {
        for (const { key, digest } of refreshes) {
          const decision = headInputs.decisions[key];
          if (decision === undefined) {
            throw new AdmissionError({
              message: `Decision disappeared while refreshing: ${key}`,
            });
          }
          writeDecision(root, key, { ...decision, reviewedDigest: digest });
        }
      }
      return { refreshed: refreshes.map(({ key }) => key) };
    },
    catch: (cause) =>
      new AdmissionError({
        message:
          cause instanceof Error
            ? cause.message
            : "Classification digest refresh failed",
      }),
  });

// A job that writes the repository publishes; only `priority` says so. Checked
// on the head alone: the base keeps whatever it reviewed before this rule.
const misclassifiedWriters = (
  jobs: ReadonlyMap<string, DerivedJob>,
  decisions: ClassificationInputs["decisions"],
) =>
  [...jobs].flatMap(([key, job]) => {
    const kind = decisions[key]?.kind;
    return job.writesRepository && kind !== undefined && kind !== "priority"
      ? [key]
      : [];
  });

export const checkJobClassification = (root: string, base?: string) =>
  Result.try({
    try: () => {
      const headInputs = readClassificationInputs(root);
      const head = generateWithJobs(headInputs);
      const writers = misclassifiedWriters(head.jobs, headInputs.decisions);
      if (writers.length > 0) {
        throw new AdmissionError({
          message: `Jobs that write the repository (contents write permission, an app token requesting it, or the signed-commit action) publish and must be classified priority. Set kind "priority" and describe what they publish in:\n${writers.map(decisionPathForKey).join("\n")}`,
        });
      }
      const privilegedJobs = base
        ? (() => {
            const baseRevision = generateBase(root, base);
            return sensitiveChanges({
              head,
              headDecisions: headInputs.decisions,
              base: baseRevision.generation,
              baseDecisions: baseRevision.inputs.decisions,
            });
          })()
        : [];
      if (head.result.isErr()) {
        if (head.result.error instanceof ReviewRequiredError) {
          throw new ReviewRequiredError({
            message: head.result.error.message,
            privilegedJobs,
          });
        }
        throw head.result.error;
      }
      return { workflowCount: head.workflowCount, privilegedJobs };
    },
    catch: (cause) =>
      cause instanceof ReviewRequiredError
        ? cause
        : new AdmissionError({
            message:
              cause instanceof Error
                ? cause.message
                : "Classification check failed",
          }),
  });

const gitMergeBase = (root: string) => {
  const result = Bun.spawnSync(
    ["git", "-C", root, "merge-base", "origin/main", "HEAD"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new AdmissionError({
      message:
        new TextDecoder().decode(result.stderr).trim() ||
        "Cannot determine merge-base of origin/main and HEAD",
    });
  }
  return new TextDecoder().decode(result.stdout).trim();
};

const escapeAnnotation = (value: string) =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

// --check (the default) fails closed on every stale or missing review.
// --write refreshes mechanical digests only and succeeds even when review
// remains, so the autofix generator never blocks other fixes; the check
// still fails for whatever it left. --pre-push runs only when the pushed
// commits touch a classification input, refreshes, and fails when it
// changed the decisions file or review remains.
type Mode = "check" | "write" | "pre-push";
type CliOptions = { root: string; base?: string; mode: Mode };
const MODE_FLAGS: Readonly<Record<string, Mode>> = {
  "--check": "check",
  "--write": "write",
  "--pre-push": "pre-push",
};
const usageError = () =>
  new AdmissionError({
    message:
      "usage: bun scripts/check-ci-job-classification.ts [--check|--write|--pre-push] [ROOT] [--base REF]",
  });
const parsePositional = (args: string[]): Omit<CliOptions, "mode"> => {
  const [first, second, third, ...rest] = args;
  if (rest.length > 0) {
    throw usageError();
  }
  if (first === undefined) {
    return { root: "." };
  }
  if (first === "--base" && second !== undefined && third === undefined) {
    return { root: ".", base: second };
  }
  if (first.startsWith("--")) {
    throw usageError();
  }
  if (second === undefined) {
    return { root: first };
  }
  if (second === "--base" && third !== undefined) {
    return { root: first, base: third };
  }
  throw usageError();
};
const parseCli = (args: string[]): CliOptions => {
  const modes = args.flatMap((arg) => {
    const mode = MODE_FLAGS[arg];
    return mode === undefined ? [] : [mode];
  });
  if (modes.length > 1) {
    throw usageError();
  }
  return {
    ...parsePositional(args.filter((arg) => MODE_FLAGS[arg] === undefined)),
    mode: modes[0] ?? "check",
  };
};

// The pushed commits are those since the merge base; CI rechecks the
// workflow revision either way.
const pushTouchesClassification = (root: string, base: string) => {
  const result = Bun.spawnSync(
    ["git", "-C", root, "diff", "--name-only", "--no-renames", base, "HEAD"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new AdmissionError({
      message:
        new TextDecoder().decode(result.stderr).trim() ||
        "Cannot list the pushed paths",
    });
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .some(isClassificationInput);
};

const decisionsFileChanged = (root: string) =>
  Bun.spawnSync(
    [
      "git",
      "-C",
      root,
      "diff",
      "--quiet",
      "HEAD",
      "--",
      CLASSIFICATION_DECISIONS_PATH,
    ],
    { stdout: "ignore", stderr: "ignore" },
  ).exitCode !== 0;

const runCheck = (root: string, base: string) => {
  const result = checkJobClassification(root, base);
  let privilegedJobs: string[] = [];
  if (result.isErr() && result.error instanceof ReviewRequiredError) {
    privilegedJobs = result.error.privilegedJobs;
  } else if (result.isOk()) {
    privilegedJobs = result.value.privilegedJobs;
  }
  // Fail closed: a check that did not finish cannot prove a change ordinary.
  const sensitive = result.isErr() || privilegedJobs.length > 0;
  const githubOutput = process.env["GITHUB_OUTPUT"];
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      `privileged_classification_change=${sensitive}\n`,
    );
  }
  if (privilegedJobs.length) {
    process.stdout.write(
      `::error title=Sensitive classification change::${escapeAnnotation(privilegedJobs.join(", "))}\n`,
    );
  }
  if (result.isErr()) {
    process.stderr.write(`${result.error.message}\n`);
    return 1;
  }
  process.stdout.write(`Classified ${result.value.workflowCount} workflows\n`);
  return 0;
};

const runCli = (options: CliOptions) => {
  const root = path.resolve(options.root);
  const base = options.base ?? gitMergeBase(root);
  if (options.mode === "check") {
    return runCheck(root, base);
  }
  if (options.mode === "pre-push" && !pushTouchesClassification(root, base)) {
    return 0;
  }
  const refreshed = refreshJobClassificationDigests(root, base);
  if (refreshed.isErr()) {
    process.stderr.write(`${refreshed.error.message}\n`);
    return 1;
  }
  const keys = refreshed.value.refreshed;
  if (keys.length > 0) {
    process.stdout.write(
      `Refreshed ${keys.length} mechanical classification digest(s): ${keys.join(", ")}\n`,
    );
  }
  if (options.mode === "write") {
    return 0;
  }
  if (decisionsFileChanged(root)) {
    process.stderr.write(
      `Commit the refreshed decision files (${keys.map(decisionPathForKey).join(", ")}) and push again.\n`,
    );
    return 1;
  }
  return runCheck(root, base);
};

if (import.meta.main) {
  const cli = Result.try({
    try: () => runCli(parseCli(Bun.argv.slice(2))),
    catch: (cause) =>
      new AdmissionError({
        message: cause instanceof Error ? cause.message : "Invalid arguments",
      }),
  });
  if (cli.isErr()) {
    // An unusable invocation never proves a change ordinary.
    const githubOutput = process.env["GITHUB_OUTPUT"];
    if (githubOutput) {
      appendFileSync(githubOutput, "privileged_classification_change=true\n");
    }
    process.stderr.write(`${cli.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = cli.value;
  }
}
