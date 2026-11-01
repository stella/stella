import { panic, Result } from "better-result";
import { appendFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "../packages/collation/src/collation";
import { writeApproval } from "./ci-job-classification/decisions";
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
type MergeGroupMember = { number: number; head: string };
type MergeGroup = { members: MergeGroupMember[] };
const MERGE_QUEUE_RESPONSE = v.object({
  data: v.object({
    repository: v.object({
      mergeQueue: v.object({
        entries: v.object({
          nodes: v.array(
            v.object({
              pullRequest: v.object({
                number: v.number(),
                headRefOid: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/u)),
              }),
            }),
          ),
        }),
      }),
    }),
  }),
});
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

const gitOutput = (root: string, args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new AdmissionError({
      message:
        new TextDecoder().decode(result.stderr).trim() ||
        `git ${args.join(" ")} failed`,
    });
  }
  return new TextDecoder().decode(result.stdout);
};

const contentAt = (root: string, revision: string, file: string) => {
  const result = Bun.spawnSync(
    ["git", "-C", root, "show", `${revision}:${file}`],
    {
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  return result.exitCode === 0
    ? new TextDecoder().decode(result.stdout)
    : undefined;
};

type MergeGroupCheckOptions = {
  root: string;
  base: string;
  // Read only after the exact check fails, so a queue read failure cannot
  // fail a group that passes on its own digests.
  readMergeGroup: () => MergeGroup;
};

// A queued tree may combine independently reviewed inputs. Each byte of every
// changed classification input must have appeared on an approving PR head;
// this deliberately does not infer provenance from patches or commit authors.
export const checkMergeGroupJobClassification = ({
  root,
  base,
  readMergeGroup,
}: MergeGroupCheckOptions) => {
  const exact = checkJobClassification(root, base);
  if (exact.isOk() || !(exact.error instanceof ReviewRequiredError)) {
    return exact;
  }
  const mergeGroup = readMergeGroup();
  const headInputs = readClassificationInputs(root);
  const head = generateWithJobs(headInputs);
  // NUL-separated: Git quotes non-ASCII, tab and newline names in line output,
  // and a quoted name would never match a classification input.
  const changedFiles = gitOutput(root, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    base,
    "HEAD",
  ])
    .split("\0")
    .filter(
      (file) =>
        file.length > 0 &&
        isClassificationInput(file) &&
        !file.startsWith(`${CLASSIFICATION_DECISIONS_PATH}/`),
    );
  const members = mergeGroup.members.map((member) => {
    const inputs = readClassificationInputsAtRevision(root, member.head);
    return { ...member, inputs, generated: generateWithJobs(inputs) };
  });
  const stale = [...head.jobs].filter(([key, job]) => {
    const decision = headInputs.decisions[key];
    return !decision?.approvedDigests.includes(job.digest);
  });
  const ordinaryComposable = stale.every(([key, job]) => {
    const decision = headInputs.decisions[key];
    if (
      decision === undefined ||
      job.privileged ||
      decision.kind === "priority"
    ) {
      return false;
    }
    const approvers = members.filter((member) => {
      const memberDecision = member.inputs.decisions[key];
      const memberJob = member.generated.jobs.get(key);
      return (
        memberDecision !== undefined &&
        memberJob !== undefined &&
        memberDecision.kind === decision.kind &&
        memberDecision.qualifier === decision.qualifier &&
        memberDecision.approvedDigests.includes(memberJob.digest)
      );
    });
    return (
      approvers.length > 0 &&
      changedFiles.every((file) => {
        const combined = contentAt(root, "HEAD", file);
        return approvers.some(
          (member) => contentAt(root, member.head, file) === combined,
        );
      })
    );
  });
  if (ordinaryComposable) {
    // Composition waives the review of ordinary jobs only; privileged changes
    // elsewhere in the group stay reported as sensitive.
    return Result.ok({
      workflowCount: head.workflowCount,
      privilegedJobs: exact.error.privilegedJobs,
    });
  }
  const later = mergeGroup.members.at(-1);
  const refusal = later
    ? `classification needs re-approval after #${later.number}`
    : undefined;
  return Result.err(
    new ReviewRequiredError({
      message: refusal
        ? `${refusal}\n${exact.error.message}`
        : exact.error.message,
      privilegedJobs: exact.error.privilegedJobs,
      staleJobs: exact.error.staleJobs,
      ...(refusal ? { refusal } : {}),
    }),
  );
};

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
type CliOptions = {
  root: string;
  base?: string;
  mode: Mode;
  /** Explicit merge-group members (entries ahead, then the PR), in order. */
  group?: MergeGroupMember[];
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
      "usage: bun scripts/check-ci-job-classification.ts [--check|--write|--pre-push] [ROOT] [--base REF] [--group N:SHA,...] [--json]",
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
const GROUP_MEMBER = /^([1-9][0-9]*):([0-9a-f]{40})$/u;

// `--group 7601:<sha>,7694:<sha>` names the merge-group members in queue order
// so a caller can check a composed tree before the PR is queued.
const parseGroup = (value: string): MergeGroupMember[] =>
  value.split(",").map((entry) => {
    const match = GROUP_MEMBER.exec(entry);
    const [, number, head] = match ?? [];
    if (number === undefined || head === undefined) {
      throw new AdmissionError({
        message: `Invalid --group member "${entry}"; use PR_NUMBER:FULL_SHA`,
      });
    }
    return { number: Number(number), head };
  });

export const parseCli = (args: string[]): CliOptions => {
  const modes = args.flatMap((arg) => {
    const mode = MODE_FLAGS[arg];
    return mode === undefined ? [] : [mode];
  });
  if (modes.length > 1) {
    throw usageError();
  }
  const rest: string[] = [];
  let group: MergeGroupMember[] | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (MODE_FLAGS[arg] !== undefined) {
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--group") {
      const value = args[index + 1];
      if (value === undefined || group !== undefined) {
        throw usageError();
      }
      group = parseGroup(value);
      index += 1;
      continue;
    }
    rest.push(arg);
  }
  const mode = modes[0] ?? "check";
  if ((group !== undefined || json) && mode !== "check") {
    throw new AdmissionError({
      message: "--group and --json apply to --check only",
    });
  }
  return {
    ...parsePositional(rest),
    mode,
    json,
    ...(group === undefined ? {} : { group }),
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
    { stdout: "pipe", stderr: "ignore" },
  ).stdout.length > 0;

const isMergeGroupEvent = () =>
  process.env["GITHUB_EVENT_NAME"] === "merge_group";

const currentMergeGroup = (): MergeGroup => {
  const ref = process.env["GITHUB_REF"] ?? "";
  const match = /\/pr-([0-9]+)-[a-f0-9]{40}$/u.exec(ref);
  const repository = process.env["GITHUB_REPOSITORY"];
  const retry = process.env["GH_RETRY_SCRIPT"];
  if (!match || !repository || !retry) {
    throw new AdmissionError({ message: "Missing merge-group queue context" });
  }
  const [owner, name] = repository.split("/");
  if (!owner || !name) {
    throw new AdmissionError({ message: "Invalid GITHUB_REPOSITORY" });
  }
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){mergeQueue{entries(first:100){nodes{pullRequest{number headRefOid}}}}}}`;
  const response = Bun.spawnSync(
    [
      "bash",
      retry,
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (response.exitCode !== 0) {
    throw new AdmissionError({
      message:
        new TextDecoder().decode(response.stderr).trim() ||
        "Cannot read the merge queue",
    });
  }
  const entries = v.parse(
    MERGE_QUEUE_RESPONSE,
    JSON.parse(new TextDecoder().decode(response.stdout)),
  ).data.repository.mergeQueue.entries.nodes;
  const leadingNumber = Number(match[1]);
  const members: MergeGroupMember[] = [];
  for (const entry of entries) {
    members.push({
      number: entry.pullRequest.number,
      head: entry.pullRequest.headRefOid,
    });
    if (entry.pullRequest.number === leadingNumber) {
      return { members };
    }
  }
  throw new AdmissionError({ message: "Merge group is absent from the queue" });
};

// Every named member head must be present: composition reads each one, and a
// missing head must stop the check rather than read as "not approved".
const presentGroup = (root: string, group: MergeGroupMember[]): MergeGroup => {
  const missing = group.filter(
    ({ head }) =>
      Bun.spawnSync(["git", "-C", root, "cat-file", "-e", `${head}^{commit}`], {
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode !== 0,
  );
  if (missing.length > 0) {
    throw new AdmissionError({
      message: `Fetch these merge-group heads first: ${missing.map(({ number, head }) => `#${String(number)} ${head}`).join(", ")}`,
    });
  }
  return { members: group };
};

/** Stale candidates a `--write` refresh records without a reviewer. */
export const mechanicalRefreshKeys = (root: string, base: string): string[] => {
  const headInputs = readClassificationInputs(root);
  const baseRevision = generateBase(root, base);
  return mechanicalRefreshes({
    head: generateWithJobs(headInputs),
    headDecisions: headInputs.decisions,
    base: baseRevision.generation,
    baseDecisions: baseRevision.inputs.decisions,
  })
    .map(({ key }) => key)
    .toSorted(compareCodeUnit);
};

type CheckReport =
  | { status: "ok"; privileged: string[] }
  | {
      status: "stale";
      stale: string[];
      mechanical: string[];
      privileged: string[];
      refusal?: string;
    }
  | { status: "error"; message: string };

type RunCheckOptions = { group?: MergeGroupMember[]; json: boolean };

const classify = (root: string, base: string, group?: MergeGroupMember[]) => {
  if (group !== undefined) {
    return checkMergeGroupJobClassification({
      root,
      base,
      readMergeGroup: () => presentGroup(root, group),
    });
  }
  return isMergeGroupEvent()
    ? checkMergeGroupJobClassification({
        root,
        base,
        readMergeGroup: currentMergeGroup,
      })
    : checkJobClassification(root, base);
};

// Exit 0 = admissible, 1 = review or re-approval needed, 2 = the check could
// not run (bad input, missing heads, unreadable tree).
const runJsonCheck = (
  root: string,
  base: string,
  group?: MergeGroupMember[],
) => {
  const result = Result.try({
    try: () => classify(root, base, group),
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
      const stale = result.error.staleJobs;
      const mechanical = mechanicalRefreshKeys(root, base).filter((key) =>
        stale.includes(key),
      );
      return {
        status: "stale",
        stale,
        mechanical,
        privileged: result.error.privilegedJobs,
        ...(result.error.refusal === undefined
          ? {}
          : { refusal: result.error.refusal }),
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

const runCheck = (root: string, base: string, options: RunCheckOptions) => {
  if (options.json) {
    return runJsonCheck(root, base, options.group);
  }
  const result = classify(root, base, options.group);
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
    return runCheck(root, base, {
      json: options.json,
      ...(options.group === undefined ? {} : { group: options.group }),
    });
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
