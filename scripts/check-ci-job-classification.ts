import { panic, Result, TaggedError } from "better-result";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

import { writeApproval } from "./ci-job-classification/decisions";
import {
  generateClassification,
  readClassificationInputs,
  readClassificationInputsAtRevision,
} from "./ci-job-classification/generate";
import type { DerivedJob } from "./ci-job-classification/generate";
import {
  approvalPathForKey,
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
      decision.approvedDigests.includes(job.digest) ||
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

const SHA = /^[0-9a-f]{40}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
type MergeGroupRevisions = { base: string; head: string };

const mergeGroupRevisions = (): MergeGroupRevisions | undefined => {
  if (process.env["GITHUB_EVENT_NAME"] !== "merge_group") {
    return undefined;
  }
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  if (!eventPath) {
    throw new AdmissionError({ message: "Merge-group event path is missing" });
  }
  const event: unknown = JSON.parse(readFileSync(eventPath, "utf-8"));
  const group = isRecord(event) ? event["merge_group"] : undefined;
  if (
    !isRecord(group) ||
    typeof group["base_sha"] !== "string" ||
    typeof group["head_sha"] !== "string" ||
    !SHA.test(group["base_sha"]) ||
    !SHA.test(group["head_sha"])
  ) {
    throw new AdmissionError({ message: "Merge-group revisions are invalid" });
  }
  return { base: group["base_sha"], head: group["head_sha"] };
};

const gitHead = (root: string) => {
  const result = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new AdmissionError({ message: "Cannot read the checked-out HEAD" });
  }
  return new TextDecoder().decode(result.stdout).trim();
};

type MergeGroupJobChange =
  | { type: "added"; key: string; job: DerivedJob }
  | { type: "modified"; key: string; job: DerivedJob }
  | { type: "removed"; key: string };

export class MergeGroupApprovalRequiredError extends TaggedError(
  "MergeGroupApprovalRequiredError",
)<{
  message: string;
  job: string;
  digest: string;
  approvalPath: string;
}> {}

// A queued group's base is its parent: main for the first entry, the previous
// group's commit after that, so each group answers for its own entry only.
const checkMergeGroupClassification = (
  root: string,
  { base, head }: MergeGroupRevisions,
) => {
  const checkedOut = gitHead(root);
  if (checkedOut !== head) {
    throw new AdmissionError({
      message: `Merge-group head ${head} is not the checked-out revision ${checkedOut}`,
    });
  }
  const groupInputs = readClassificationInputs(root);
  const group = generateWithJobs(groupInputs);
  const baseRevision = generateBase(root, base);
  const baseGeneration = baseRevision.generation;
  const changes: MergeGroupJobChange[] = [
    ...new Set([...group.jobs.keys(), ...baseGeneration.jobs.keys()]),
  ].flatMap((key): MergeGroupJobChange[] => {
    const current = group.jobs.get(key);
    const previous = baseGeneration.jobs.get(key);
    if (current === undefined) {
      return [{ type: "removed", key }];
    }
    if (previous === undefined) {
      return [{ type: "added", key, job: current }];
    }
    return current.digest === previous.digest
      ? []
      : [{ type: "modified", key, job: current }];
  });
  for (const change of changes) {
    switch (change.type) {
      case "removed":
        break;
      case "added":
      case "modified": {
        const decision = groupInputs.decisions[change.key];
        if (!decision?.approvedDigests.includes(change.job.digest)) {
          const approvalPath = approvalPathForKey(
            change.key,
            change.job.digest,
          );
          throw new MergeGroupApprovalRequiredError({
            message: `Merge-group approval is missing or mismatched for ${change.key} at digest ${change.job.digest}; expected ${approvalPath}`,
            job: change.key,
            digest: change.job.digest,
            approvalPath,
          });
        }
        break;
      }
      default: {
        change satisfies never;
        panic("Unhandled merge-group job change");
      }
    }
  }
  // Approvals cover review; the group tree must still pass every other
  // generation rule (action pinning, complete classification, no cycles, no
  // stale decisions).
  if (
    group.result.isErr() &&
    !(group.result.error instanceof ReviewRequiredError)
  ) {
    throw group.result.error;
  }
  return {
    workflowCount: group.workflowCount,
    privilegedJobs: sensitiveChanges({
      head: group,
      headDecisions: groupInputs.decisions,
      base: baseGeneration,
      baseDecisions: baseRevision.inputs.decisions,
    }),
  };
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
          writeApproval(root, key, digest, decision);
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
      // Pull requests and merge groups both refuse a writer approved under
      // any kind but priority, before any approval is accepted.
      const headInputs = readClassificationInputs(root);
      const head = generateWithJobs(headInputs);
      const writers = misclassifiedWriters(head.jobs, headInputs.decisions);
      if (writers.length > 0) {
        throw new AdmissionError({
          message: `Jobs that write the repository (contents write permission, an app token requesting it, or the signed-commit action) publish and must be classified priority. Set kind "priority" and describe what they publish in:\n${writers.map(decisionPathForKey).join("\n")}`,
        });
      }
      const mergeGroup = mergeGroupRevisions();
      if (mergeGroup) {
        return checkMergeGroupClassification(root, mergeGroup);
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
    {
      stdout: "pipe",
      stderr: "pipe",
    },
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
      "status",
      "--porcelain",
      "--",
      CLASSIFICATION_DECISIONS_PATH,
    ],
    {
      stdout: "pipe",
      stderr: "ignore",
    },
  ).stdout.length > 0;

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
