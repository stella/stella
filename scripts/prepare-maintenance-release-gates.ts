// The release gates a maintenance cut checks before it writes anything.
//
// release-tag.yml ends with one verdict over its gates. A gate that can only
// fail there leaves a version commit nobody can tag, so every gate on that
// verdict line is classified here: `pre-cut` gates run on the base tree, with
// the same guard the tag runs, before the cut writes a file; `post-cut`
// gates name why only the version commit can decide them. The cut adds its
// own pre-cut gates (source `cut`), which the verdict line does not have.
// prepare-maintenance-release-gates.test.ts holds this table equal to the
// verdict line, so a new tag gate cannot ship unclassified.

/** How the cut decides a pre-cut gate. */
export type CutGateCheck =
  | {
      /** Runs on the base tree; any exit status but 0 fails the gate. */
      readonly kind: "command";
      readonly command: readonly string[];
    }
  | {
      /** The resolved newest final release must already be published on npm. */
      readonly kind: "npm-publish-lag";
    }
  | {
      /** main/heavy and main/pr-depth green on the base commit. */
      readonly kind: "main-statuses";
    };

export type PreCutGate = {
  readonly name: string;
  /** `release-tag` gates appear on release-tag.yml's verdict line. */
  readonly source: "release-tag" | "cut";
  readonly stage: "pre-cut";
  readonly check: CutGateCheck;
  /** Whether `--allow-unproven-main` lets the cut go on despite a failure. */
  readonly overriddenByAllowUnprovenMain: boolean;
};

export type PostCutGate = {
  readonly name: string;
  readonly source: "release-tag";
  readonly stage: "post-cut";
  /** Why the gate cannot be decided before the version commit exists. */
  readonly reason: string;
};

export type CutGate = PreCutGate | PostCutGate;

export const MAINTENANCE_CUT_GATES: readonly CutGate[] = [
  {
    name: "deploy-env-contract",
    source: "cut",
    stage: "pre-cut",
    check: {
      kind: "command",
      command: ["bun", "scripts/check-deploy-env-contract.ts"],
    },
    overriddenByAllowUnprovenMain: false,
  },
  {
    name: "main-health",
    source: "cut",
    stage: "pre-cut",
    check: { kind: "main-statuses" },
    overriddenByAllowUnprovenMain: true,
  },
  {
    name: "release-evidence",
    source: "release-tag",
    stage: "post-cut",
    reason:
      "the cut creates the release PR head whose identity and source tree the RC tag verifies",
  },
  {
    name: "dependency-audit",
    source: "release-tag",
    stage: "pre-cut",
    check: {
      kind: "command",
      command: ["bash", "scripts/check-release-dependency-audit.sh"],
    },
    overriddenByAllowUnprovenMain: false,
  },
  {
    name: "changelog",
    source: "release-tag",
    stage: "post-cut",
    reason:
      "the cut writes the changelog, then runs the same check on it before it finishes",
  },
  {
    name: "npm-publish-lag",
    source: "release-tag",
    stage: "pre-cut",
    check: { kind: "npm-publish-lag" },
    overriddenByAllowUnprovenMain: false,
  },
  {
    name: "npm-publish-readiness",
    source: "release-tag",
    stage: "pre-cut",
    check: {
      kind: "command",
      command: ["bun", "scripts/check-npm-publish-readiness.ts"],
    },
    overriddenByAllowUnprovenMain: false,
  },
  {
    name: "cli-coupling",
    source: "release-tag",
    stage: "post-cut",
    reason:
      "on the base tree a pending changeset naming @stll/cli refuses it by construction; the cut consumes those changesets, and the release pull request checks the version commit",
  },
];

export const preCutGates = (
  gates: readonly CutGate[] = MAINTENANCE_CUT_GATES,
): readonly PreCutGate[] =>
  gates.filter((gate): gate is PreCutGate => gate.stage === "pre-cut");

export const postCutGates = (
  gates: readonly CutGate[] = MAINTENANCE_CUT_GATES,
): readonly PostCutGate[] =>
  gates.filter((gate): gate is PostCutGate => gate.stage === "post-cut");

/**
 * Every way the table and the tag's verdict line disagree: a verdict gate the
 * cut does not classify, a `release-tag` entry the verdict does not have, a
 * cut-only entry that shadows a verdict gate, or a name used twice.
 */
export const cutGateClassificationProblems = (
  verdictGates: readonly string[],
  gates: readonly CutGate[] = MAINTENANCE_CUT_GATES,
): readonly string[] => {
  const verdict = new Set(verdictGates);
  const tagEntries = new Set(
    gates
      .filter(({ source }) => source === "release-tag")
      .map(({ name }) => name),
  );
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const { name, source } of gates) {
    if (seen.has(name)) {
      problems.push(`${name}: classified more than once`);
    }
    seen.add(name);
    if (source === "release-tag" && !verdict.has(name)) {
      problems.push(`${name}: not a gate on the release-tag.yml verdict line`);
    }
    if (source === "cut" && verdict.has(name)) {
      problems.push(`${name}: a release-tag.yml gate classified as cut-only`);
    }
  }
  for (const name of verdictGates) {
    if (!tagEntries.has(name)) {
      problems.push(
        `${name}: a release-tag.yml gate the maintenance cut does not classify`,
      );
    }
  }
  return problems;
};

const ERROR_ANNOTATION = /^::error[^:]*::(.*)$/u;

/**
 * Why a command gate failed, as release-gate.sh reports it: the command's own
 * error annotations, else its last stderr line, else its exit status.
 */
export const commandGateFailureReason = ({
  exitCode,
  stderr,
  stdout,
}: {
  exitCode: number;
  stderr: string;
  stdout: string;
}): string => {
  const annotations = `${stdout}\n${stderr}`.split(/\r?\n/u).flatMap((line) => {
    const match = ERROR_ANNOTATION.exec(line);
    const message = match?.at(1);
    return message === undefined ? [] : [message];
  });
  if (annotations.length > 0) {
    return annotations.join("; ");
  }
  const lastLine = stderr
    .split(/\r?\n/u)
    .findLast((line) => line.trim() !== "");
  return lastLine ?? `exit ${String(exitCode)}`;
};
