import { panic, Result } from "better-result";
import { appendFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "../packages/collation/src/collation";
import { removeDecision } from "./ci-job-classification/decisions";
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
    const headDecision = headDecisions[key];
    const previousDecision = baseDecisions[key];
    if (
      current !== undefined &&
      previous !== undefined &&
      current.digest === previous.digest &&
      headDecision?.approvedDigests.includes(current.digest) &&
      previousDecision !== undefined &&
      previousDecision.approvedDigests.includes(previous.digest) &&
      previousDecision.kind === headDecision.kind &&
      previousDecision.qualifier === headDecision.qualifier
    ) {
      return [];
    }
    return current?.privileged || previous?.privileged ? [key] : [];
  });

const generateBase = (root: string, base: string) => {
  const inputs = readClassificationInputsAtRevision(root, base);
  const generation = generateWithJobs(inputs);
  // The base is read for comparison only. Its own review state, including
  // decisions it recorded for jobs that were not privileged, is not judged.
  if (
    generation.result.isErr() &&
    !(generation.result.error instanceof ReviewRequiredError)
  ) {
    throw generation.result.error;
  }
  return { inputs, generation };
};

// Removes the decisions the check rejects as stale. No reviewer is needed:
// a job that is not privileged owes no review, and removing a record can
// never approve anything.
export const pruneStaleJobClassificationDecisions = (root: string) =>
  Result.try({
    try: () => {
      const { result } = generateWithJobs(readClassificationInputs(root));
      const removed =
        result.isErr() && result.error instanceof ReviewRequiredError
          ? result.error.staleDecisions
          : [];
      for (const key of removed) {
        removeDecision(root, key);
      }
      return { removed };
    },
    catch: (cause) =>
      new AdmissionError({
        message:
          cause instanceof Error
            ? cause.message
            : "Classification decision pruning failed",
      }),
  });

// A job that writes the repository publishes; only `priority` says so. Checked
// on the head alone: the base keeps whatever it reviewed before this rule. A
// decision whose digest is stale goes through review first, which shows the
// sensitive change; the kind is judged once the reviewed digest is current.
const misclassifiedWriters = (
  jobs: ReadonlyMap<string, DerivedJob>,
  decisions: ClassificationInputs["decisions"],
) =>
  [...jobs].flatMap(([key, job]) => {
    const decision = decisions[key];
    return job.writesRepository &&
      decision !== undefined &&
      decision.approvedDigests.includes(job.digest) &&
      decision.kind !== "priority"
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
            staleJobs: head.result.error.staleJobs,
            staleDecisions: head.result.error.staleDecisions,
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

// --check (the default) fails closed on every stale or missing review and on
// every stale decision. --write removes stale decisions only and succeeds
// even when review remains, so the generator never blocks other fixes; the
// check still fails for whatever it left. --pre-push runs only when the
// pushed commits touch a classification input, removes stale decisions, and
// fails when the decisions have uncommitted changes or review remains.
type Mode = "check" | "write" | "pre-push";
type CliOptions = {
  root: string;
  base?: string;
  mode: Mode;
  /** Print one machine-readable report instead of annotations. */
  json: boolean;
};
const MODE_FLAGS: Readonly<Record<string, Mode>> = {
  "--check": "check",
  "--write": "write",
  "--pre-push": "pre-push",
};
const usageError = () =>
  new AdmissionError({
    message:
      "usage: bun scripts/check-ci-job-classification.ts [--check|--write|--pre-push] [ROOT] [--base REF] [--json]",
  });
const parsePositional = (args: string[]): Omit<CliOptions, "mode" | "json"> => {
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
export const parseCli = (args: string[]): CliOptions => {
  const modes = args.flatMap((arg) => {
    const mode = MODE_FLAGS[arg];
    return mode === undefined ? [] : [mode];
  });
  if (modes.length > 1) {
    throw usageError();
  }
  const json = args.includes("--json");
  const mode = modes[0] ?? "check";
  if (json && mode !== "check") {
    throw new AdmissionError({ message: "--json applies to --check only" });
  }
  return {
    ...parsePositional(
      args.filter((arg) => MODE_FLAGS[arg] === undefined && arg !== "--json"),
    ),
    mode,
    json,
  };
};

// The pushed commits are those since the merge base; CI rechecks the
// workflow revision either way.
const pushTouchesClassification = (root: string, base: string) => {
  const result = Bun.spawnSync(
    [
      "git",
      "-C",
      root,
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      base,
      "HEAD",
    ],
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
    .split("\0")
    .some(isClassificationInput);
};

const decisionsChanged = (root: string) =>
  Bun.spawnSync(
    [
      "git",
      "-C",
      root,
      "status",
      "--porcelain",
      "--",
      CLASSIFICATION_DECISIONS_PATH,
    ],
    { stdout: "pipe", stderr: "ignore" },
  ).stdout.length > 0;

const isMergeGroupEvent = () =>
  process.env["GITHUB_EVENT_NAME"] === "merge_group";

// GitHub names a merge group's ref after the pull request at its head.
const mergeGroupPullRequest = () => {
  const match = /\/pr-([0-9]+)-[a-f0-9]{40}$/u.exec(
    process.env["GITHUB_REF"] ?? "",
  );
  if (!match) {
    throw new AdmissionError({ message: "Missing merge-group queue context" });
  }
  return Number(match[1]);
};

// A merge group combines pull requests that were reviewed apart, and an
// approval covers one exact digest, so a group whose combined tree needs
// review names the pull request at its head for re-approval. The ref is
// read only after the check fails, so a group that passes never depends
// on it.
const classify = (root: string, base: string) => {
  const result = checkJobClassification(root, base);
  if (
    !isMergeGroupEvent() ||
    result.isOk() ||
    !(result.error instanceof ReviewRequiredError)
  ) {
    return result;
  }
  const pullRequest = mergeGroupPullRequest();
  const refusal = `classification needs re-approval after #${pullRequest}`;
  return Result.err(
    new ReviewRequiredError({
      message: `${refusal}\n${result.error.message}`,
      privilegedJobs: result.error.privilegedJobs,
      staleJobs: result.error.staleJobs,
      staleDecisions: result.error.staleDecisions,
      refusal,
    }),
  );
};

type CheckReport =
  | { status: "ok"; privileged: string[] }
  | {
      status: "stale";
      /** Every key the check rejects. */
      stale: string[];
      /** The stale decisions among them, which `--write` removes. */
      mechanical: string[];
      privileged: string[];
      refusal?: string;
    }
  | { status: "error"; message: string };

// Exit 0 = admissible, 1 = a review or a decision removal is needed, 2 = the
// check could not run (bad input, unreadable tree).
const runJsonCheck = (root: string, base: string) => {
  const result = Result.try({
    try: () => classify(root, base),
    catch: (cause) =>
      new AdmissionError({
        message: cause instanceof Error ? cause.message : "Check failed",
      }),
  }).andThen((inner) => inner);
  const report = ((): CheckReport => {
    if (result.isOk()) {
      return { status: "ok", privileged: result.value.privilegedJobs };
    }
    if (result.error instanceof ReviewRequiredError) {
      const { staleJobs, staleDecisions, privilegedJobs, refusal } =
        result.error;
      return {
        status: "stale",
        stale: [...staleJobs, ...staleDecisions].toSorted(compareCodeUnit),
        mechanical: staleDecisions,
        privileged: privilegedJobs,
        ...(refusal === undefined ? {} : { refusal }),
      };
    }
    return { status: "error", message: result.error.message };
  })();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  switch (report.status) {
    case "ok":
      return 0;
    case "stale":
      return 1;
    case "error":
      return 2;
    default:
      report satisfies never;
      return panic("Unhandled classification report");
  }
};

type RunCheckOptions = { json: boolean };

const runCheck = (root: string, base: string, { json }: RunCheckOptions) => {
  if (json) {
    return runJsonCheck(root, base);
  }
  const result = classify(root, base);
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
    if (
      result.isErr() &&
      result.error instanceof ReviewRequiredError &&
      result.error.refusal
    ) {
      appendFileSync(
        githubOutput,
        `classification_refusal=${result.error.refusal}\n`,
      );
    }
  }
  if (privilegedJobs.length) {
    process.stdout.write(
      `::error title=Sensitive classification change::${escapeAnnotation(privilegedJobs.join(", "))}\n`,
    );
  }
  if (
    result.isErr() &&
    result.error instanceof ReviewRequiredError &&
    result.error.refusal
  ) {
    process.stdout.write(
      `::error title=Classification refusal::${escapeAnnotation(result.error.refusal)}\n`,
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
    return runCheck(root, base, { json: options.json });
  }
  if (options.mode === "pre-push" && !pushTouchesClassification(root, base)) {
    return 0;
  }
  const pruned = pruneStaleJobClassificationDecisions(root);
  if (pruned.isErr()) {
    process.stderr.write(`${pruned.error.message}\n`);
    return 1;
  }
  const keys = pruned.value.removed;
  if (keys.length > 0) {
    process.stdout.write(
      `Removed ${keys.length} stale classification decision(s): ${keys.join(", ")}\n`,
    );
  }
  if (options.mode === "write") {
    return 0;
  }
  if (decisionsChanged(root)) {
    process.stderr.write(
      `Commit the changes under ${CLASSIFICATION_DECISIONS_PATH} and push again.\n`,
    );
    return 1;
  }
  return runCheck(root, base, { json: false });
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
    // A JSON caller reads "could not run" from the report and exit 2.
    if (Bun.argv.includes("--json")) {
      process.stdout.write(
        `${JSON.stringify({ status: "error", message: cli.error.message })}\n`,
      );
      process.exitCode = 2;
    } else {
      process.exitCode = 1;
    }
  } else {
    process.exitCode = cli.value;
  }
}
