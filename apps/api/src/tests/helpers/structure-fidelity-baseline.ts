import { panic } from "better-result";
import * as v from "valibot";

import { STRUCTURE_FIDELITY_RULES } from "@/api/lib/legal-search/parsers/structure-fidelity";

const STRUCTURE_FIDELITY_FINDING_KINDS = [
  ...Object.values(STRUCTURE_FIDELITY_RULES),
  "ast-missing",
] as const;

const findingSchema = v.object({
  rule: v.picklist(STRUCTURE_FIDELITY_FINDING_KINDS),
  anchorId: v.string(),
  excerpt: v.string(),
});

export const structureFidelityBaselineSchema = v.object({
  comment: v.string(),
  findings: v.record(v.string(), v.record(v.string(), v.array(findingSchema))),
});

export type StructureFidelityCensus = v.InferOutput<
  typeof structureFidelityBaselineSchema
>["findings"];

export const STRUCTURE_FIDELITY_BASELINE_PATH =
  "apps/api/src/handlers/case-law/ingestion/parsers/structure-fidelity-baseline.json";

const countsOf = (census: StructureFidelityCensus) => {
  const counts = new Map<string, number>();
  for (const [adapter, fixtures] of Object.entries(census)) {
    for (const [fixture, findings] of Object.entries(fixtures)) {
      for (const { rule, anchorId, excerpt } of findings) {
        const identity = JSON.stringify([
          adapter,
          fixture,
          rule,
          anchorId,
          excerpt,
        ]);
        counts.set(identity, (counts.get(identity) ?? 0) + 1);
      }
    }
  }
  return counts;
};

type StructureFidelityDriftOptions = {
  actual: StructureFidelityCensus;
  expected: StructureFidelityCensus;
};

export const structureFidelityDrift = ({
  actual,
  expected,
}: StructureFidelityDriftOptions) => {
  const now = countsOf(actual);
  const before = countsOf(expected);
  const added: string[] = [];
  const stale: string[] = [];
  for (const key of new Set([...now.keys(), ...before.keys()])) {
    const current = now.get(key) ?? 0;
    const previous = before.get(key) ?? 0;
    if (current > previous) {
      added.push(`${key}: ${previous} -> ${current}`);
    } else if (current < previous) {
      stale.push(`${key}: ${previous} -> ${current}`);
    }
  }
  return { added, stale };
};

const git = (repositoryRoot: string, args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: repositoryRoot });
  if (result.exitCode !== 0) {
    return panic(
      `Cannot read structure-fidelity history: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
};

type ReadCommittedBaselineOptions = {
  repositoryRoot: string;
  revision: string;
};

const readCommittedStructureFidelityBaseline = ({
  repositoryRoot,
  revision,
}: ReadCommittedBaselineOptions) => {
  const path = STRUCTURE_FIDELITY_BASELINE_PATH;
  if (
    git(repositoryRoot, ["ls-tree", "--name-only", revision, "--", path]) === ""
  ) {
    return null;
  }
  return v.parse(
    structureFidelityBaselineSchema,
    JSON.parse(git(repositoryRoot, ["show", `${revision}:${path}`])),
  );
};

type CheckBaselineGrowthOptions = {
  repositoryRoot: string;
  revision: string;
  findings: StructureFidelityCensus;
};

const assertStructureFidelityBaselineShrinks = ({
  repositoryRoot,
  revision,
  findings,
}: CheckBaselineGrowthOptions) => {
  const committed = readCommittedStructureFidelityBaseline({
    repositoryRoot,
    revision,
  });
  if (committed === null) {
    return;
  }
  const { added } = structureFidelityDrift({
    actual: findings,
    expected: committed.findings,
  });
  if (added.length > 0) {
    panic(
      `Structure-fidelity baseline cannot grow against ${revision}:\n${added.join("\n")}`,
    );
  }
};

type CheckBaselineHistoryOptions = {
  repositoryRoot: string;
  baseRevision?: string;
  findings: StructureFidelityCensus;
};

/** HEAD protects edits before commit; the merge base protects committed rewrites. */
export const assertStructureFidelityBaselineHistory = ({
  repositoryRoot,
  baseRevision = process.env["BASE_SHA"],
  findings,
}: CheckBaselineHistoryOptions) => {
  assertStructureFidelityBaselineShrinks({
    repositoryRoot,
    findings,
    revision: "HEAD",
  });
  const revision = git(
    repositoryRoot,
    baseRevision
      ? ["rev-parse", "--verify", `${baseRevision}^{commit}`]
      : ["merge-base", "HEAD", "origin/main"],
  );
  assertStructureFidelityBaselineShrinks({
    repositoryRoot,
    findings,
    revision,
  });
};
