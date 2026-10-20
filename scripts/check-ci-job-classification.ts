import { Result } from "better-result";
import { deepEquals } from "bun";
import { appendFileSync } from "node:fs";
import path from "node:path";

import {
  generateClassification,
  readClassificationInputs,
  readClassificationInputsAtRevision,
} from "./ci-job-classification/generate";
import type { DerivedJob } from "./ci-job-classification/generate";
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
// A job is unchanged only when its shape and its whole reviewed decision
// (kind, qualifier and digest) match the base; anything else is a change.
const sensitiveChanges = ({
  head,
  headDecisions,
  base,
  baseDecisions,
}: SensitiveChangesOptions) =>
  [...head.jobs.entries()].flatMap(([key, current]) => {
    const previousDecision = baseDecisions[key];
    if (
      previousDecision?.reviewedDigest === current.digest &&
      deepEquals(previousDecision, headDecisions[key])
    ) {
      return [];
    }
    return current.privileged || base.jobs.get(key)?.privileged ? [key] : [];
  });

export const checkJobClassification = (root: string, base?: string) =>
  Result.try({
    try: () => {
      const headInputs = readClassificationInputs(root);
      const head = generateWithJobs(headInputs);
      const privilegedJobs = base
        ? (() => {
            const baseInputs = readClassificationInputsAtRevision(root, base);
            const baseGeneration = generateWithJobs(baseInputs);
            if (
              baseGeneration.result.isErr() &&
              !(baseGeneration.result.error instanceof ReviewRequiredError)
            ) {
              throw baseGeneration.result.error;
            }
            return sensitiveChanges({
              head,
              headDecisions: headInputs.decisions,
              base: baseGeneration,
              baseDecisions: baseInputs.decisions,
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

type CliOptions = { root: string; base?: string };
const usageError = () =>
  new AdmissionError({
    message:
      "usage: bun scripts/check-ci-job-classification.ts [ROOT] [--base REF]",
  });
const parseCli = (args: string[]): CliOptions => {
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

if (import.meta.main) {
  const cli = Result.try({
    try: () => {
      const options = parseCli(Bun.argv.slice(2));
      const root = path.resolve(options.root);
      return checkJobClassification(root, options.base ?? gitMergeBase(root));
    },
    catch: (cause) =>
      new AdmissionError({
        message: cause instanceof Error ? cause.message : "Invalid arguments",
      }),
  });
  const result = cli.isOk() ? cli.value : cli;
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
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Classified ${result.value.workflowCount} workflows\n`,
    );
  }
}
