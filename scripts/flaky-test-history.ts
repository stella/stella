// Flaky-test and check history: evidence, quarantine proposals and summaries.
//
// Evidence comes from artifacts CI already publishes: the result gate's
// failure digest (`ci-failures`, structured test identities per failed
// attempt), the changed-test flake gate's repeat report and the quarantine
// preload's per-job reports.
//
//   bun scripts/flaky-test-history.ts job-summary --reports <dir> [--summary <file>]
//     A CI test job: annotates each quarantined outcome the preload recorded,
//     flags entries that matched no test, and writes each quarantined test's
//     outcome and recent history to the job summary.
//   bun scripts/flaky-test-history.ts scan --out <dir> [--summary <file>]
//       [--pr-body <file>] [--write-registry]
//     The scheduled scan: collects the last seven days of evidence, writes the
//     history artifact and summary, and adds a quarantine entry for each test
//     that failed and then passed on the same commit for enough commits.
//
// Network access goes through scripts/gh-retry.sh with GITHUB_REPOSITORY.

import { panic, Result, TaggedError } from "better-result";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

import { FULL_TEST_JOB_SHARDS } from "./api-test-shard-plan";
import type { FailedTest } from "./ci-failure-digest";
import {
  annotationData,
  annotationProperty,
  DAY_MS,
  isExpired,
  quarantineRecordSchema,
  readRegistry,
  REGISTRY_FILE,
  REPOSITORY_ROOT,
  serializeRegistry,
  splitTestId,
  testId,
  type QuarantineEntry,
  type QuarantineRecord,
  type Registry,
} from "./flaky-test-quarantine";

export const HISTORY_WINDOW_DAYS = 7;
// Distinct commits on which a test failed and then passed before a quarantine
// is proposed: one retry is noise, a pattern across commits is a flake.
export const PROPOSAL_THRESHOLD = 3;
export const PROPOSED_QUARANTINE_DAYS = 14;
export const HISTORY_ARTIFACT = "flaky-test-history";
export const HISTORY_FILE = "flaky-test-history.json";
const FAILURE_DIGEST_ARTIFACT = "ci-failures";
const FLAKE_REPORT_ARTIFACT = "flake-gate-report";
const CI_WORKFLOW = "ci.yml";
const SHOWN_OBSERVATIONS = 10;

// One report artifact per ci-tests matrix job.
export const quarantineArtifactName = (
  shard: (typeof FULL_TEST_JOB_SHARDS)[number],
): string => `flaky-test-quarantine-${shard}`;

const sourceFields = {
  at: v.string(),
  headSha: v.string(),
  url: v.string(),
};

const observationSchema = v.variant("kind", [
  // Failed in a CI attempt; a later attempt on the same commit succeeded.
  v.strictObject({ kind: v.literal("retry-pass"), ...sourceFields }),
  // Failed in some, not all, repeats of the changed-test flake gate.
  v.strictObject({
    kind: v.literal("repeat-flake"),
    ...sourceFields,
    failures: v.number(),
    runs: v.number(),
  }),
  v.strictObject({ kind: v.literal("quarantined-pass"), ...sourceFields }),
  v.strictObject({
    kind: v.literal("quarantined-fail"),
    ...sourceFields,
    message: v.string(),
  }),
]);
export type Observation = v.InferOutput<typeof observationSchema>;

// Which observations are evidence of a same-commit flake.
const OBSERVATION_ROLE = {
  "retry-pass": "flake",
  "repeat-flake": "flake",
  "quarantined-pass": "quarantine",
  "quarantined-fail": "quarantine",
} as const satisfies Record<Observation["kind"], "flake" | "quarantine">;

const historySchema = v.strictObject({
  generatedAt: v.string(),
  tests: v.record(v.string(), v.array(observationSchema)),
  flakyChecks: v.optional(
    v.array(
      v.strictObject({
        job: v.string(),
        step: v.string(),
        flakyFailures: v.number(),
        commits: v.number(),
        lastSeen: v.string(),
      }),
    ),
    [],
  ),
});
export type History = v.InferOutput<typeof historySchema>;

export type CiRun = {
  readonly headSha: string;
  readonly conclusion: string | null;
  // The latest attempt's start: a re-run moves it past the failed attempt.
  readonly startedAt: string;
};

type ArtifactSource = {
  readonly headSha: string;
  readonly createdAt: string;
  readonly url: string;
};

type FlakeResult = {
  readonly file: string;
  readonly runs: number;
  readonly failedTests: Readonly<Record<string, number>>;
};

export type Evidence = {
  readonly runs: readonly CiRun[];
  readonly digests: readonly (ArtifactSource & {
    readonly tests: readonly FailedTest[];
    readonly checks: readonly { readonly job: string; readonly step: string }[];
  })[];
  readonly flakeReports: readonly (ArtifactSource & {
    readonly results: readonly FlakeResult[];
  })[];
  readonly quarantineReports: readonly (ArtifactSource & {
    readonly records: readonly QuarantineRecord[];
  })[];
};

export type FlakyCheck = {
  readonly job: string;
  readonly step: string;
  readonly flakyFailures: number;
  readonly commits: number;
  readonly lastSeen: string;
};

const isCancellationStep = ({ job, step }: { job: string; step: string }) =>
  /cancel(?:led|lation|ing)?/iu.test(job) ||
  /cancel(?:led|lation|ing)?/iu.test(step);

/** Failed check steps whose commit had a later successful workflow run. */
export const findFlakyChecks = (evidence: Evidence): FlakyCheck[] => {
  const checks = new Map<
    string,
    {
      job: string;
      step: string;
      failures: number;
      commits: Set<string>;
      lastSeen: string;
    }
  >();
  for (const digest of evidence.digests) {
    const laterSuccess = evidence.runs.some(
      (run) =>
        run.headSha === digest.headSha &&
        run.conclusion === "success" &&
        Date.parse(run.startedAt) > Date.parse(digest.createdAt),
    );
    if (!laterSuccess) {
      continue;
    }
    for (const check of digest.checks) {
      if (check.job === "ci-result" || isCancellationStep(check)) {
        continue;
      }
      const key = `${check.job}\0${check.step}`;
      const found = checks.get(key);
      if (found === undefined) {
        checks.set(key, {
          ...check,
          failures: 1,
          commits: new Set([digest.headSha]),
          lastSeen: digest.createdAt,
        });
      } else {
        found.failures += 1;
        found.commits.add(digest.headSha);
        if (Date.parse(digest.createdAt) > Date.parse(found.lastSeen)) {
          found.lastSeen = digest.createdAt;
        }
      }
    }
  }
  return [...checks.values()]
    .map(({ failures, commits, ...check }) => ({
      ...check,
      flakyFailures: failures,
      commits: commits.size,
    }))
    .toSorted((left, right) =>
      compareCodeUnit(
        `${left.job}\0${left.step}`,
        `${right.job}\0${right.step}`,
      ),
    );
};

/**
 * A digest names a test by its Turbo scope (`@stll/<directory>`) and the file
 * header Bun printed relative to that package; workspace packages live in
 * apps/ or packages/ under their directory name.
 */
export const resolveTestFile = (
  test: FailedTest,
  exists: (file: string) => boolean,
): string | undefined => {
  const file = path.posix.normalize(test.file);
  if (path.posix.isAbsolute(file) || file.startsWith("../")) {
    return undefined;
  }
  const directory = /^@stll\/([\w.-]+)$/u.exec(test.scope)?.at(1);
  let candidates: string[] = [];
  if (test.scope === "") {
    candidates = [file];
  } else if (directory !== undefined) {
    candidates = [`apps/${directory}/${file}`, `packages/${directory}/${file}`];
  }
  const found = candidates.filter(exists);
  return found.length === 1 ? found.at(0) : undefined;
};

type BuildHistoryOptions = {
  readonly evidence: Evidence;
  readonly exists: (file: string) => boolean;
};

export const buildHistory = ({
  evidence,
  exists,
}: BuildHistoryOptions): Record<string, Observation[]> => {
  const tests = new Map<string, Observation[]>();
  const add = (id: string, observation: Observation): void => {
    const observations = tests.get(id);
    if (observations === undefined) {
      tests.set(id, [observation]);
    } else {
      observations.push(observation);
    }
  };
  for (const digest of evidence.digests) {
    const failedAt = Date.parse(digest.createdAt);
    const retried = evidence.runs.some(
      (run) =>
        run.headSha === digest.headSha &&
        run.conclusion === "success" &&
        Date.parse(run.startedAt) > failedAt,
    );
    if (!retried) {
      continue;
    }
    const ids = new Set(
      digest.tests.flatMap((test) => {
        const file = resolveTestFile(test, exists);
        return file === undefined ? [] : [testId({ file, name: test.name })];
      }),
    );
    for (const id of ids) {
      add(id, {
        kind: "retry-pass",
        at: digest.createdAt,
        headSha: digest.headSha,
        url: digest.url,
      });
    }
  }
  for (const report of evidence.flakeReports) {
    for (const result of report.results) {
      for (const [name, failures] of Object.entries(result.failedTests)) {
        if (failures > 0 && failures < result.runs) {
          add(testId({ file: result.file, name }), {
            kind: "repeat-flake",
            at: report.createdAt,
            headSha: report.headSha,
            url: report.url,
            failures,
            runs: result.runs,
          });
        }
      }
    }
  }
  for (const report of evidence.quarantineReports) {
    for (const record of report.records) {
      const source = {
        at: report.createdAt,
        headSha: report.headSha,
        url: report.url,
      };
      switch (record.type) {
        case "passed":
          add(record.id, { kind: "quarantined-pass", ...source });
          break;
        case "failed":
          add(record.id, {
            kind: "quarantined-fail",
            ...source,
            message: record.message,
          });
          break;
        case "loaded":
        case "registered":
          break;
        default:
          record satisfies never;
          panic("Unhandled quarantine record");
      }
    }
  }
  return Object.fromEntries(
    [...tests].map(([id, observations]) => [
      id,
      observations.toSorted((left, right) =>
        compareCodeUnit(right.at, left.at),
      ),
    ]),
  );
};

export type Candidate = {
  readonly id: string;
  readonly commits: readonly string[];
  readonly observations: readonly Observation[];
};

type CandidateOptions = {
  readonly tests: Readonly<Record<string, readonly Observation[]>>;
  readonly registry: Registry;
  readonly now: Date;
  readonly exists: (file: string) => boolean;
};

export const quarantineCandidates = ({
  tests,
  registry,
  now,
  exists,
}: CandidateOptions): Candidate[] => {
  const quarantined = new Set(registry.entries.map(({ id }) => id));
  const since = now.getTime() - HISTORY_WINDOW_DAYS * DAY_MS;
  return Object.entries(tests)
    .flatMap(([id, observations]): Candidate[] => {
      const identity = splitTestId(id);
      if (
        quarantined.has(id) ||
        identity === undefined ||
        !exists(identity.file)
      ) {
        return [];
      }
      const evidence = observations.filter(
        ({ kind, at }) =>
          OBSERVATION_ROLE[kind] === "flake" && Date.parse(at) >= since,
      );
      const commits = [...new Set(evidence.map(({ headSha }) => headSha))];
      return commits.length >= PROPOSAL_THRESHOLD
        ? [{ id, commits, observations: evidence }]
        : [];
    })
    .toSorted((left, right) => compareCodeUnit(left.id, right.id));
};

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

type ProposeOptions = {
  readonly registry: Registry;
  readonly candidates: readonly Candidate[];
  readonly owners: ReadonlyMap<string, string>;
  readonly now: Date;
};

export type Proposal = {
  readonly registry: Registry;
  readonly added: readonly QuarantineEntry[];
  // Candidates whose test file has no matching CODEOWNERS rule.
  readonly unowned: readonly Candidate[];
};

export const proposeQuarantine = ({
  registry,
  candidates,
  owners,
  now,
}: ProposeOptions): Proposal => {
  const added: QuarantineEntry[] = [];
  const unowned: Candidate[] = [];
  const created = isoDay(now.getTime());
  for (const candidate of candidates) {
    const file = splitTestId(candidate.id)?.file;
    const owner = file === undefined ? undefined : owners.get(file);
    if (owner === undefined) {
      unowned.push(candidate);
      continue;
    }
    added.push({
      id: candidate.id,
      owner,
      reason: `Failed, then passed on the same commit, on ${candidate.commits.length} commits in ${HISTORY_WINDOW_DAYS} days.`,
      created,
      expires: isoDay(now.getTime() + PROPOSED_QUARANTINE_DAYS * DAY_MS),
    });
  }
  return {
    registry: {
      entries: [...registry.entries, ...added].toSorted((left, right) =>
        compareCodeUnit(left.id, right.id),
      ),
    },
    added,
    unowned,
  };
};

// --- Rendering --------------------------------------------------------------

const markdown = (value: string): string =>
  value.replaceAll(/[\\`*_[\]<>|#]/gu, "\\$&").replaceAll(/\r?\n/gu, " ");

const describeObservation = (observation: Observation): string => {
  switch (observation.kind) {
    case "retry-pass":
      return "failed, then passed on retry";
    case "repeat-flake":
      return `failed ${observation.failures} of ${observation.runs} repeats`;
    case "quarantined-pass":
      return "passed (quarantined)";
    case "quarantined-fail":
      return `failed (quarantined): ${markdown(observation.message)}`;
    default:
      observation satisfies never;
      return panic("Unhandled flaky-test observation");
  }
};

export const renderObservations = (
  observations: readonly Observation[],
): string => {
  if (observations.length === 0) {
    return "No recorded history in the last 7 days.";
  }
  const lines = observations
    .slice(0, SHOWN_OBSERVATIONS)
    .map(
      (observation) =>
        `- ${observation.at.slice(0, 16).replace("T", " ")} UTC, [${observation.headSha.slice(0, 7)}](${observation.url}): ${describeObservation(observation)}`,
    );
  const hidden = observations.length - lines.length;
  return [...lines, ...(hidden > 0 ? [`- ${hidden} earlier`] : [])].join("\n");
};

const historyLine = (observations: readonly Observation[]): string => {
  const flakes = new Set(
    observations
      .filter(({ kind }) => OBSERVATION_ROLE[kind] === "flake")
      .map(({ headSha }) => headSha),
  ).size;
  const failures = observations.filter(
    ({ kind }) => kind === "quarantined-fail",
  ).length;
  const passes = observations.filter(
    ({ kind }) => kind === "quarantined-pass",
  ).length;
  return `${flakes} flaky commits; quarantined runs: ${failures} failed, ${passes} passed`;
};

type JobSummaryOptions = {
  readonly registry: Registry;
  readonly records: readonly QuarantineRecord[];
  readonly history: History | undefined;
  readonly now: Date;
};

export type JobSummary = {
  readonly markdown: string;
  readonly annotations: readonly string[];
};

export const jobSummary = ({
  registry,
  records,
  history,
  now,
}: JobSummaryOptions): JobSummary => {
  const entries = new Map(registry.entries.map((entry) => [entry.id, entry]));
  const loaded = new Set<string>();
  const registered = new Set<string>();
  const outcomes = new Map<string, QuarantineRecord[]>();
  for (const record of records) {
    switch (record.type) {
      case "loaded":
        loaded.add(record.file);
        break;
      case "registered":
        registered.add(record.id);
        break;
      case "passed":
      case "failed":
        outcomes.set(record.id, [...(outcomes.get(record.id) ?? []), record]);
        break;
      default:
        record satisfies never;
        panic("Unhandled quarantine record");
    }
  }
  const annotations: string[] = [];
  const rows: string[] = [];
  const details: string[] = [];
  for (const [id, entry] of entries) {
    const identity = splitTestId(id);
    if (identity === undefined) {
      return panic(`Invalid quarantine id survived validation: ${id}`);
    }
    if (!loaded.has(identity.file)) {
      continue;
    }
    const expiry = isExpired(entry, now)
      ? `${entry.expires} (expired)`
      : entry.expires;
    const ran = outcomes.get(id) ?? [];
    if (!registered.has(id)) {
      annotations.push(
        `::warning file=${annotationProperty(identity.file)},title=${annotationProperty("Stale flaky-test quarantine")}::${annotationData(`${id} matched no test in a run of its file; rename the entry or remove it from ${REGISTRY_FILE}.`)}`,
      );
    }
    for (const record of ran) {
      if (record.type === "failed") {
        annotations.push(
          `::warning file=${annotationProperty(identity.file)},title=${annotationProperty("Quarantined test failed")}::${annotationData(`${id}: ${record.message} (owner ${entry.owner}, quarantined until ${expiry}). The failure does not fail this run.`)}`,
        );
      }
    }
    const unrun = registered.has(id) ? "not run" : "matched no test";
    const thisRun =
      ran.length === 0
        ? unrun
        : ran
            .map((record) =>
              record.type === "failed"
                ? `failed: ${markdown(record.message)}`
                : "passed",
            )
            .join("; ");
    const observations = history?.tests[id] ?? [];
    rows.push(
      `| \`${markdown(id)}\` | ${markdown(entry.owner)} | ${expiry} | ${thisRun} | ${history === undefined ? "unavailable" : historyLine(observations)} |`,
    );
    details.push(
      `<details><summary>${markdown(id)}</summary>\n\n${history === undefined ? "History unavailable." : renderObservations(observations)}\n\n</details>`,
    );
  }
  if (rows.length === 0) {
    return { markdown: "", annotations };
  }
  return {
    markdown: [
      "## Quarantined tests",
      "",
      `Failures of these tests are recorded, not fatal. Entries live in \`${REGISTRY_FILE}\`.`,
      "",
      "| Test | Owner | Expires | This run | Last 7 days |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
      "",
      ...details,
      "",
    ].join("\n"),
    annotations,
  };
};

type ScanSummaryOptions = {
  readonly tests: Readonly<Record<string, readonly Observation[]>>;
  readonly registry: Registry;
  readonly proposal: Proposal;
  readonly skipped: number;
  readonly flakyChecks: readonly FlakyCheck[];
};

const flakyChecksTable = (checks: readonly FlakyCheck[]): string[] =>
  checks.length === 0
    ? []
    : [
        "## Flaky checks",
        "",
        "| Job | Step | Flaky failures | Commits | Last seen |",
        "| --- | --- | ---: | ---: | --- |",
        ...checks.map(
          (check) =>
            `| ${markdown(check.job)} | ${markdown(check.step)} | ${check.flakyFailures} | ${check.commits} | ${check.lastSeen.slice(0, 10)} |`,
        ),
        "",
      ];

export const scanSummary = ({
  tests,
  registry,
  proposal,
  skipped,
  flakyChecks,
}: ScanSummaryOptions): string => {
  const section = (id: string): string =>
    `### \`${markdown(id)}\`\n\n${renderObservations(tests[id] ?? [])}\n`;
  const quarantined = registry.entries.map(({ id }) => id);
  return [
    "## Flaky-test history",
    "",
    `Window: ${HISTORY_WINDOW_DAYS} days. A test is proposed for quarantine after failing, then passing on the same commit, on ${PROPOSAL_THRESHOLD} commits.`,
    ...(skipped > 0
      ? ["", `${skipped} artifacts could not be read and were skipped.`]
      : []),
    "",
    `Proposed: ${proposal.added.length}. Without an owner: ${proposal.unowned.length}.`,
    "",
    ...proposal.added.map(({ id }) => section(id)),
    ...proposal.unowned.map(({ id }) => section(id)),
    ...flakyChecksTable(flakyChecks),
    ...(quarantined.length > 0
      ? ["## Quarantined", "", ...quarantined.map(section)]
      : []),
  ].join("\n");
};

type ProposalBodyOptions = {
  readonly proposal: Proposal;
  readonly tests: Readonly<Record<string, readonly Observation[]>>;
  readonly flakyChecks: readonly FlakyCheck[];
};

export const proposalBody = ({
  proposal,
  tests,
  flakyChecks,
}: ProposalBodyOptions): string =>
  [
    `These tests failed and then passed on the same commit on at least ${PROPOSAL_THRESHOLD} commits in the last ${HISTORY_WINDOW_DAYS} days. Quarantined, they keep running and reporting, but their failures no longer fail pull requests or merge groups.`,
    "",
    `Each entry expires after ${PROPOSED_QUARANTINE_DAYS} days. The owner comes from the last matching rule in \`.github/CODEOWNERS\`.`,
    "",
    ...proposal.added.flatMap(({ id, owner }) => [
      `### \`${markdown(id)}\` (owner: ${markdown(owner)})`,
      "",
      renderObservations(
        (tests[id] ?? []).filter(
          ({ kind }) => OBSERVATION_ROLE[kind] === "flake",
        ),
      ),
      "",
    ]),
    ...(proposal.unowned.length === 0
      ? []
      : [
          "## Needs an owner",
          "",
          "These test files have no matching `.github/CODEOWNERS` rule, so no quarantine entry was added.",
          "",
          ...proposal.unowned.map(({ id }) => `- \`${markdown(id)}\``),
          "",
        ]),
    ...flakyChecksTable(flakyChecks),
    "Opened by the scheduled flaky-test quarantine scan.",
    "",
  ].join("\n");

// --- Collection -------------------------------------------------------------

export class GhCommandError extends TaggedError("GhCommandError")<{
  message: string;
}> {}

export type Gh = (
  args: readonly string[],
) => Promise<Result<string, GhCommandError>>;

export const ghRetry: Gh = async (args) => {
  const child = Bun.spawn(
    ["bash", path.join(REPOSITORY_ROOT, "scripts/gh-retry.sh"), ...args],
    { stdout: "pipe", stderr: "inherit" },
  );
  const [stdout, status] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return status === 0
    ? Result.ok(stdout)
    : Result.err(
        new GhCommandError({
          message: `gh ${args.slice(0, 2).join(" ")} exited with ${status}`,
        }),
      );
};

const runPagesSchema = v.array(
  v.object({
    workflow_runs: v.array(
      v.object({
        head_sha: v.string(),
        conclusion: v.nullable(v.string()),
        run_started_at: v.string(),
      }),
    ),
  }),
);

const artifactPagesSchema = v.array(
  v.object({
    artifacts: v.array(
      v.object({
        expired: v.boolean(),
        created_at: v.string(),
        workflow_run: v.nullable(
          v.object({ id: v.number(), head_sha: v.string() }),
        ),
      }),
    ),
  }),
);

// Digests from before structured test identities parse as unreadable.
const digestFileSchema = v.array(
  v.object({
    job: v.string(),
    step: v.string(),
    tests: v.array(
      v.object({ scope: v.string(), file: v.string(), name: v.string() }),
    ),
  }),
);

const flakeReportFileSchema = v.object({
  results: v.array(
    v.object({
      file: v.string(),
      runs: v.number(),
      failedTests: v.record(v.string(), v.number()),
    }),
  ),
});

const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(file, "utf-8"));

export const readQuarantineRecords = (dir: string): QuarantineRecord[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => file.endsWith(".jsonl"))
        .toSorted(compareCodeUnit)
        .flatMap((file) =>
          readFileSync(path.join(dir, file), "utf-8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => v.parse(quarantineRecordSchema, JSON.parse(line))),
        )
    : [];

type CollectOptions = {
  readonly gh: Gh;
  readonly repository: string;
  readonly now: Date;
  readonly workdir: string;
};

export type Collected = {
  readonly evidence: Evidence;
  readonly skipped: number;
};

export const collectEvidence = async ({
  gh,
  repository,
  now,
  workdir,
}: CollectOptions): Promise<Result<Collected, GhCommandError>> => {
  const since = now.getTime() - HISTORY_WINDOW_DAYS * DAY_MS;
  const sinceIso = new Date(since).toISOString();
  const runsJson = await gh([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/actions/workflows/${CI_WORKFLOW}/runs?created=${encodeURIComponent(`>=${sinceIso}`)}&per_page=100`,
  ]);
  if (runsJson.isErr()) {
    return runsJson;
  }
  const runs = v
    .parse(runPagesSchema, JSON.parse(runsJson.value))
    .flatMap((page) => page.workflow_runs)
    .map((run): CiRun => ({
      headSha: run.head_sha,
      conclusion: run.conclusion,
      startedAt: run.run_started_at,
    }));

  type Located = ArtifactSource & { readonly dir: string };
  const download = async (
    name: string,
    keep: (source: ArtifactSource) => boolean,
  ): Promise<Result<Located[], GhCommandError>> => {
    const listed = await gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
    ]);
    if (listed.isErr()) {
      return listed;
    }
    const located: Located[] = [];
    for (const artifact of v
      .parse(artifactPagesSchema, JSON.parse(listed.value))
      .flatMap((page) => page.artifacts)) {
      const run = artifact.workflow_run;
      if (
        artifact.expired ||
        run === null ||
        Date.parse(artifact.created_at) < since
      ) {
        continue;
      }
      const source: ArtifactSource = {
        headSha: run.head_sha,
        createdAt: artifact.created_at,
        url: `https://github.com/${repository}/actions/runs/${run.id}`,
      };
      if (!keep(source)) {
        continue;
      }
      const dir = path.join(workdir, `${run.id}-${name}`);
      const fetched = await gh([
        "run",
        "download",
        String(run.id),
        "--repo",
        repository,
        "--name",
        name,
        "--dir",
        dir,
      ]);
      if (fetched.isErr()) {
        return fetched;
      }
      located.push({ ...source, dir });
    }
    return Result.ok(located);
  };

  let skipped = 0;
  const readOr = <T>(
    schema: v.GenericSchema<unknown, T>,
    file: string,
  ): T | undefined => {
    const parsed = existsSync(file)
      ? v.safeParse(schema, readJson(file))
      : undefined;
    if (parsed?.success !== true) {
      skipped += 1;
      return undefined;
    }
    return parsed.output;
  };

  // Only a failure its commit later passed is flake evidence; skip the rest.
  const digests = await download(FAILURE_DIGEST_ARTIFACT, (source) =>
    runs.some(
      (run) =>
        run.headSha === source.headSha &&
        run.conclusion === "success" &&
        Date.parse(run.startedAt) > Date.parse(source.createdAt),
    ),
  );
  if (digests.isErr()) {
    return digests;
  }
  const flakeReports = await download(FLAKE_REPORT_ARTIFACT, () => true);
  if (flakeReports.isErr()) {
    return flakeReports;
  }
  const quarantineReports: Located[] = [];
  for (const shard of FULL_TEST_JOB_SHARDS) {
    const reports = await download(quarantineArtifactName(shard), () => true);
    if (reports.isErr()) {
      return reports;
    }
    quarantineReports.push(...reports.value);
  }
  return Result.ok({
    evidence: {
      runs,
      digests: digests.value.flatMap(({ dir, ...source }) => {
        const records = readOr(
          digestFileSchema,
          path.join(dir, "ci-failures.json"),
        );
        return records === undefined
          ? []
          : [
              {
                ...source,
                tests: records.flatMap(({ tests }) => tests),
                checks: records.map(({ job, step }) => ({ job, step })),
              },
            ];
      }),
      flakeReports: flakeReports.value.flatMap(({ dir, ...source }) => {
        const report = readOr(
          flakeReportFileSchema,
          path.join(dir, "flake-gate-report.json"),
        );
        return report === undefined
          ? []
          : [{ ...source, results: report.results }];
      }),
      quarantineReports: quarantineReports.map(({ dir, ...source }) => ({
        ...source,
        records: readQuarantineRecords(dir),
      })),
    },
    skipped,
  });
};

/** Resolve files with CODEOWNERS semantics: gitignore-style patterns, last match wins. */
export const resolveOwners = (
  content: string,
  files: readonly string[],
): Map<string, string> => {
  const owners = new Map<string, string>();
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const [rawPattern, rawOwner] = line.split(/\s+/u);
    if (rawPattern === undefined || rawOwner?.startsWith("@") !== true) {
      continue;
    }
    const rooted = rawPattern.startsWith("/");
    let pattern = rawPattern.replace(/^\//u, "");
    if (pattern.endsWith("/")) {
      pattern += "**";
    } else if (!rooted && !pattern.includes("/")) {
      pattern = `**/${pattern}`;
    }
    const glob = new Bun.Glob(pattern);
    for (const file of new Set(files)) {
      if (
        glob.match(file) ||
        (!pattern.includes("/") && glob.match(path.posix.basename(file)))
      ) {
        owners.set(file, rawOwner.slice(1));
      }
    }
  }
  return owners;
};

type LatestHistoryOptions = {
  readonly gh: Gh;
  readonly repository: string;
  readonly workdir: string;
};

const latestArtifactSchema = v.object({
  artifacts: v.array(
    v.object({
      expired: v.boolean(),
      workflow_run: v.nullable(v.object({ id: v.number() })),
    }),
  ),
});

/** The newest history the scheduled scan published, if any is retained. */
export const fetchLatestHistory = async ({
  gh,
  repository,
  workdir,
}: LatestHistoryOptions): Promise<
  Result<History | undefined, GhCommandError>
> => {
  const listed = await gh([
    "api",
    `repos/${repository}/actions/artifacts?name=${HISTORY_ARTIFACT}&per_page=1`,
  ]);
  if (listed.isErr()) {
    return listed;
  }
  const latest = v
    .parse(latestArtifactSchema, JSON.parse(listed.value))
    .artifacts.find(
      ({ expired, workflow_run }) => !expired && workflow_run !== null,
    );
  if (latest?.workflow_run === undefined || latest.workflow_run === null) {
    return Result.ok(undefined);
  }
  const dir = path.join(workdir, HISTORY_ARTIFACT);
  const fetched = await gh([
    "run",
    "download",
    String(latest.workflow_run.id),
    "--repo",
    repository,
    "--name",
    HISTORY_ARTIFACT,
    "--dir",
    dir,
  ]);
  if (fetched.isErr()) {
    return fetched;
  }
  return Result.ok(
    v.parse(historySchema, readJson(path.join(dir, HISTORY_FILE))),
  );
};

// --- CLI --------------------------------------------------------------------

const option = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args.at(index + 1);
};

const requiredRepository = (): string =>
  process.env["GITHUB_REPOSITORY"] ?? panic("GITHUB_REPOSITORY is required");

const exists = (file: string): boolean =>
  existsSync(path.join(REPOSITORY_ROOT, file));

const runJobSummary = async (args: readonly string[]): Promise<void> => {
  const reports =
    option(args, "--reports") ??
    panic(
      "Usage: flaky-test-history.ts job-summary --reports <dir> [--summary <file>]",
    );
  const records = readQuarantineRecords(reports);
  if (records.length === 0) {
    return;
  }
  const workdir = mkdtempSync(path.join(tmpdir(), "flaky-test-history-"));
  const fetched = await fetchLatestHistory({
    gh: ghRetry,
    repository: requiredRepository(),
    workdir,
  });
  if (fetched.isErr()) {
    console.log(
      `::notice title=Flaky-test history unavailable::${annotationData(fetched.error.message)}`,
    );
  }
  const summary = jobSummary({
    registry: readRegistry(),
    records,
    history: fetched.isOk() ? fetched.value : undefined,
    now: new Date(),
  });
  for (const annotation of summary.annotations) {
    console.log(annotation);
  }
  const file = option(args, "--summary");
  if (file !== undefined && summary.markdown !== "") {
    appendFileSync(file, summary.markdown);
  }
};

const runScan = async (args: readonly string[]): Promise<void> => {
  const out =
    option(args, "--out") ??
    panic(
      "Usage: flaky-test-history.ts scan --out <dir> [--summary <file>] [--pr-body <file>] [--write-registry]",
    );
  const repository = requiredRepository();
  const now = new Date();
  mkdirSync(out, { recursive: true });
  const workdir = mkdtempSync(path.join(tmpdir(), "flaky-test-evidence-"));
  const collected = await collectEvidence({
    gh: ghRetry,
    repository,
    now,
    workdir,
  });
  if (collected.isErr()) {
    console.error(collected.error.message);
    process.exitCode = 1;
    return;
  }
  const tests = buildHistory({ evidence: collected.value.evidence, exists });
  const flakyChecks = findFlakyChecks(collected.value.evidence);
  const history: History = {
    generatedAt: now.toISOString(),
    tests,
    flakyChecks,
  };
  writeFileSync(path.join(out, HISTORY_FILE), `${JSON.stringify(history)}\n`);
  const registry = readRegistry();
  const candidates = quarantineCandidates({ tests, registry, now, exists });
  const owners = resolveOwners(
    readFileSync(path.join(REPOSITORY_ROOT, ".github/CODEOWNERS"), "utf-8"),
    candidates.flatMap(({ id }) => splitTestId(id)?.file ?? []),
  );
  const proposal = proposeQuarantine({
    registry,
    candidates,
    owners,
    now,
  });
  const summary = option(args, "--summary");
  if (summary !== undefined) {
    appendFileSync(
      summary,
      scanSummary({
        tests,
        registry,
        proposal,
        skipped: collected.value.skipped,
        flakyChecks,
      }),
    );
  }
  const body = option(args, "--pr-body");
  if (body !== undefined) {
    writeFileSync(body, proposalBody({ proposal, tests, flakyChecks }));
  }
  if (args.includes("--write-registry") && proposal.added.length > 0) {
    writeFileSync(
      path.join(REPOSITORY_ROOT, REGISTRY_FILE),
      serializeRegistry(proposal.registry),
    );
  }
};

if (import.meta.main) {
  const [command = "", ...args] = process.argv.slice(2);
  switch (command) {
    case "job-summary":
      await runJobSummary(args);
      break;
    case "scan":
      await runScan(args);
      break;
    default:
      panic(
        "Usage: bun scripts/flaky-test-history.ts <job-summary | scan> ...",
      );
  }
}
