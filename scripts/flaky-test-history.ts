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
//     history artifact and summary, and proposes quarantines from retry,
//     cross-branch, and full-depth main evidence.
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
import { DIGEST_VERSION, type FailedTest } from "./ci-failure-digest";
import {
  annotationData,
  annotationProperty,
  DAY_MS,
  isExpired,
  type QuarantineEntry,
  type QuarantineRecord,
  quarantineRecordSchema,
  readRegistry,
  type Registry,
  REGISTRY_FILE,
  REPOSITORY_ROOT,
  serializeRegistry,
  splitTestId,
  testId,
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
const FULL_DEPTH_WORKFLOWS = ["main-heavy.yml", "main-pr-depth.yml"] as const;
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
  v.strictObject({
    kind: v.literal("cross-branch-fail"),
    ...sourceFields,
    headBranch: v.string(),
  }),
  v.strictObject({ kind: v.literal("main-flip"), ...sourceFields }),
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
  "cross-branch-fail": "flake",
  "main-flip": "flake",
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
  readonly id?: number;
  readonly headSha: string;
  readonly headBranch?: string | null;
  readonly fullDepth?: boolean;
  readonly conclusion: string | null;
  readonly url?: string;
  // The latest attempt's start: a re-run moves it past the failed attempt.
  readonly startedAt: string;
  readonly successfulChecks?: readonly {
    readonly job: string;
    readonly step: string;
  }[];
};

type ArtifactSource = {
  readonly runId?: number;
  readonly headSha: string;
  readonly headBranch?: string | null;
  readonly fullDepth?: boolean;
  readonly createdAt: string;
  readonly url: string;
};

export const jobFamily = (job: string): string =>
  job.replace(/^suites \/ /u, "").replace(/ \([^()]+\)$/u, "");

type FlakeResult = {
  readonly file: string;
  readonly runs: number;
  readonly failedTests: Readonly<Record<string, number>>;
};

export type Evidence = {
  readonly runs: readonly CiRun[];
  readonly digests: readonly (ArtifactSource & {
    readonly tests: readonly (FailedTest & {
      readonly job: string;
      readonly step: string;
    })[];
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
    const laterSuccesses = evidence.runs.filter(
      (run) =>
        run.headSha === digest.headSha &&
        run.conclusion === "success" &&
        Date.parse(run.startedAt) > Date.parse(digest.createdAt),
    );
    if (laterSuccesses.length === 0) {
      continue;
    }
    for (const check of digest.checks) {
      if (check.job === "ci-result" || isCancellationStep(check)) {
        continue;
      }
      const job = check.job.replace(/ \([^()]+\)$/u, "");
      const received = laterSuccesses.some((run) =>
        run.successfulChecks?.some(
          (receipt) =>
            receipt.job.replace(/ \([^()]+\)$/u, "") === job &&
            receipt.step === check.step,
        ),
      );
      if (!received) {
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

type AddObservation = (id: string, observation: Observation) => void;

const addFailurePatternEvidence = ({
  evidence,
  exists,
  add,
}: BuildHistoryOptions & { readonly add: AddObservation }): void => {
  const failuresByTest = new Map<
    string,
    {
      source: ArtifactSource;
      job: string;
      step: string;
    }[]
  >();
  for (const digest of evidence.digests) {
    for (const failed of digest.tests) {
      const file = resolveTestFile(failed, exists);
      if (file === undefined) {
        continue;
      }
      const id = testId({ file, name: failed.name });
      const failures = failuresByTest.get(id) ?? [];
      failures.push({
        source: digest,
        job: jobFamily(failed.job),
        step: failed.step,
      });
      failuresByTest.set(id, failures);
    }
  }
  for (const [id, failures] of failuresByTest) {
    const ordered = failures.toSorted((left, right) =>
      compareCodeUnit(left.source.createdAt, right.source.createdAt),
    );
    const groups = Map.groupBy(ordered, ({ job, step }) => `${job}\0${step}`);
    for (const familyFailures of groups.values()) {
      const heads = new Set(familyFailures.map(({ source }) => source.headSha));
      const branches = new Set(
        familyFailures.flatMap(({ source }) =>
          source.headBranch === undefined || source.headBranch === null
            ? []
            : [source.headBranch],
        ),
      );
      const first = familyFailures.at(0);
      const last = familyFailures.at(-1);
      if (
        first === undefined ||
        last === undefined ||
        heads.size < PROPOSAL_THRESHOLD ||
        branches.size < 2 ||
        !evidence.runs.some(
          (run) =>
            run.fullDepth === true &&
            run.headBranch === "main" &&
            Date.parse(run.startedAt) >= Date.parse(first.source.createdAt) &&
            Date.parse(run.startedAt) <= Date.parse(last.source.createdAt) &&
            run.successfulChecks?.some(
              (check) =>
                jobFamily(check.job) === first.job && check.step === first.step,
            ) === true,
        )
      ) {
        continue;
      }
      for (const { source } of familyFailures) {
        add(id, {
          kind: "cross-branch-fail",
          at: source.createdAt,
          headSha: source.headSha,
          headBranch: source.headBranch ?? "",
          url: source.url,
        });
      }
    }

    for (const familyFailures of groups.values()) {
      const mainFailures = familyFailures.filter(
        ({ source }) =>
          source.fullDepth === true && source.headBranch === "main",
      );
      for (let index = 0; index < mainFailures.length - 1; index += 1) {
        const before = mainFailures[index];
        const after = mainFailures[index + 1];
        if (before === undefined || after === undefined) {
          continue;
        }
        const passedBetween = evidence.runs.some(
          (run) =>
            run.fullDepth === true &&
            run.headBranch === "main" &&
            Date.parse(run.startedAt) > Date.parse(before.source.createdAt) &&
            Date.parse(run.startedAt) < Date.parse(after.source.createdAt) &&
            run.successfulChecks?.some(
              (check) =>
                jobFamily(check.job) === after.job && check.step === after.step,
            ) === true,
        );
        if (passedBetween) {
          add(id, {
            kind: "main-flip",
            at: after.source.createdAt,
            headSha: after.source.headSha,
            url: after.source.url,
          });
          break;
        }
      }
    }
  }
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
    const retries = evidence.runs.filter(
      (run) =>
        run.headSha === digest.headSha &&
        run.conclusion === "success" &&
        Date.parse(run.startedAt) > failedAt,
    );
    const ids = new Set<string>();
    for (const failed of digest.tests) {
      const file = resolveTestFile(failed, exists);
      if (file === undefined) {
        continue;
      }
      const id = testId({ file, name: failed.name });
      const job = jobFamily(failed.job);
      const passed = retries.some((run) => {
        const received = run.successfulChecks?.some(
          (receipt) =>
            jobFamily(receipt.job) === job && receipt.step === failed.step,
        );
        if (received !== true) {
          return false;
        }
        const outcomes = evidence.quarantineReports
          .filter((report) => report.url === run.url)
          .flatMap(({ records }) => records)
          .filter(
            (record) =>
              (record.type === "passed" || record.type === "failed") &&
              record.id === id,
          );
        return (
          outcomes.length === 0 ||
          outcomes.some(({ type }) => type === "passed")
        );
      });
      if (passed) {
        ids.add(id);
      }
    }
    for (const id of ids) {
      add(id, {
        kind: "retry-pass",
        at: digest.createdAt,
        headSha: digest.headSha,
        url: digest.url,
      });
    }
  }
  addFailurePatternEvidence({ evidence, exists, add });
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
  readonly evidenceKind: "same-commit" | "cross-branch-fail" | "main-flip";
  readonly branches: number;
  readonly observations: readonly Observation[];
};

type CandidateOptions = {
  readonly tests: Readonly<Record<string, readonly Observation[]>>;
  readonly registry: Registry;
  readonly now: Date;
  readonly exists: (file: string) => boolean;
};

type SelectedEvidence = {
  readonly kind: Candidate["evidenceKind"];
  readonly observations: readonly Observation[];
};

const selectCandidateEvidence = (
  evidence: readonly Observation[],
): SelectedEvidence => {
  const mainFlip = evidence.filter(({ kind }) => kind === "main-flip");
  if (mainFlip.length > 0) {
    return { kind: "main-flip", observations: mainFlip };
  }
  const crossBranch = evidence.filter(
    ({ kind }) => kind === "cross-branch-fail",
  );
  if (crossBranch.length > 0) {
    return { kind: "cross-branch-fail", observations: crossBranch };
  }
  return {
    kind: "same-commit",
    observations: evidence.filter(
      ({ kind }) => kind === "retry-pass" || kind === "repeat-flake",
    ),
  };
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
      const selected = selectCandidateEvidence(evidence);
      const commits = [
        ...new Set(selected.observations.map(({ headSha }) => headSha)),
      ];
      if (
        selected.kind === "same-commit" &&
        commits.length < PROPOSAL_THRESHOLD
      ) {
        return [];
      }
      if (selected.observations.length === 0) {
        return [];
      }
      const branches = new Set(
        selected.observations.flatMap((observation) =>
          observation.kind === "cross-branch-fail"
            ? [observation.headBranch]
            : [],
        ),
      ).size;
      return [
        {
          id,
          commits,
          evidenceKind: selected.kind,
          branches,
          observations: selected.observations,
        },
      ];
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

const candidateReason = (candidate: Candidate): string => {
  switch (candidate.evidenceKind) {
    case "cross-branch-fail":
      return `Cross-branch failure: failed on ${candidate.commits.length} commits across ${candidate.branches} branches while main passed it.`;
    case "main-flip":
      return "Main flip: failed, passed, then failed again on main.";
    case "same-commit":
      return `Same-commit flake: failed, then passed on the same commit, on ${candidate.commits.length} commits in ${HISTORY_WINDOW_DAYS} days.`;
    default:
      candidate.evidenceKind satisfies never;
      return panic("Unhandled candidate evidence kind");
  }
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
      reason: candidateReason(candidate),
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
    case "cross-branch-fail":
      return `failed on branch ${markdown(observation.headBranch)} while main passed the job family and step`;
    case "main-flip":
      return "failed after an intervening full-depth main pass";
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
    `Window: ${HISTORY_WINDOW_DAYS} days. A test is proposed from a main fail/pass/fail flip, cross-branch failures with an intervening full-depth main pass, or same-commit flake evidence on ${PROPOSAL_THRESHOLD} commits.`,
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
    `These tests showed a main fail/pass/fail flip, cross-branch failures with an intervening full-depth main pass, or same-commit flake evidence on at least ${PROPOSAL_THRESHOLD} commits in the last ${HISTORY_WINDOW_DAYS} days. Quarantined, they keep running and reporting, but their failures no longer fail pull requests or merge groups.`,
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
    total_count: v.number(),
    workflow_runs: v.array(
      v.object({
        id: v.number(),
        head_sha: v.string(),
        head_branch: v.nullable(v.string()),
        conclusion: v.nullable(v.string()),
        run_started_at: v.string(),
      }),
    ),
  }),
);

type ListedRun = v.InferOutput<
  typeof runPagesSchema
>[number]["workflow_runs"][number];

type WorkflowRun = ListedRun & {
  readonly fullDepth: boolean;
};

const jobPagesSchema = v.array(
  v.object({
    jobs: v.array(
      v.object({
        name: v.string(),
        steps: v.array(
          v.object({ name: v.string(), conclusion: v.nullable(v.string()) }),
        ),
      }),
    ),
  }),
);

const artifactPagesSchema = v.array(
  v.object({
    total_count: v.number(),
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

// The `DigestFile` envelope `ci-failure-digest.ts` writes. Digests from
// before structured test identities parse as unreadable.
const digestFileSchema = v.object({
  version: v.literal(DIGEST_VERSION),
  failures: v.array(
    v.object({
      job: v.string(),
      step: v.string(),
      tests: v.array(
        v.object({ scope: v.string(), file: v.string(), name: v.string() }),
      ),
    }),
  ),
});

const flakeReportFileSchema = v.object({
  results: v.array(
    v.object({
      file: v.string(),
      runs: v.number(),
      failedTests: v.record(v.string(), v.number()),
    }),
  ),
});

const successfulJobFamilySteps = (
  raw: string,
): { readonly job: string; readonly step: string }[] => {
  const jobs = v
    .parse(jobPagesSchema, JSON.parse(raw))
    .flatMap((page) => page.jobs);
  const steps = jobs.flatMap((job) =>
    job.steps.map((step) => ({
      job: job.name,
      family: jobFamily(job.name),
      step: step.name,
      conclusion: step.conclusion,
    })),
  );
  return [...Map.groupBy(steps, ({ family, step }) => `${family}\0${step}`)]
    .filter(([, familySteps]) =>
      familySteps.every(({ conclusion }) => conclusion === "success"),
    )
    .map(([, familySteps]) => {
      const first = familySteps.at(0) ?? panic("Empty job-step family");
      return { job: first.job, step: first.step };
    });
};

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

type ListWorkflowRunsOptions = Pick<
  CollectOptions,
  "gh" | "repository" | "now"
> & { readonly since: number };

// GitHub stops returning runs after this many results for a filtered listing.
const RUN_LISTING_CAP = 1000;
const SECOND_MS = 1000;

const isoSecond = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 19)}Z`;

type ListCreatedRunsOptions = Pick<CollectOptions, "gh" | "repository"> & {
  readonly workflow: string;
  readonly date: string;
  readonly from: number;
  readonly to: number;
};

const listCreatedRuns = async ({
  gh,
  repository,
  workflow,
  date,
  from,
  to,
}: ListCreatedRunsOptions): Promise<Result<ListedRun[], GhCommandError>> => {
  const branch = workflow === CI_WORKFLOW ? "" : "&branch=main";
  const response = await gh([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/actions/workflows/${workflow}/runs?created=${isoSecond(from)}..${isoSecond(to)}${branch}&per_page=100`,
  ]);
  if (response.isErr()) {
    return response;
  }
  const pages = v.parse(runPagesSchema, JSON.parse(response.value));
  let runs = pages.flatMap((page) => page.workflow_runs);
  const total = pages.at(0)?.total_count ?? 0;
  if (total > RUN_LISTING_CAP && to - from >= SECOND_MS) {
    const mid = from + Math.floor((to - from) / (2 * SECOND_MS)) * SECOND_MS;
    runs = [];
    for (const [start, end] of [
      [from, mid],
      [mid + SECOND_MS, to],
    ] as const) {
      const half = await listCreatedRuns({
        gh,
        repository,
        workflow,
        date,
        from: start,
        to: end,
      });
      if (half.isErr()) {
        return half;
      }
      runs.push(...half.value);
    }
  }
  if (runs.length !== total) {
    return Result.err(
      new GhCommandError({
        message: `Incomplete workflow run listing for ${workflow} on ${date}: GitHub reported ${total}, but returned ${runs.length}.`,
      }),
    );
  }
  return Result.ok(runs);
};

const listWorkflowRuns = async ({
  gh,
  repository,
  now,
  since,
}: ListWorkflowRunsOptions): Promise<Result<WorkflowRun[], GhCommandError>> => {
  const workflowRuns: WorkflowRun[] = [];
  const start = new Date(since);
  const firstDay = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  );
  const lastDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  for (const workflow of [CI_WORKFLOW, ...FULL_DEPTH_WORKFLOWS]) {
    for (let day = firstDay; day <= lastDay; day += DAY_MS) {
      const runs = await listCreatedRuns({
        gh,
        repository,
        workflow,
        date: isoDay(day),
        from: day,
        to: day + DAY_MS - SECOND_MS,
      });
      if (runs.isErr()) {
        return runs;
      }
      workflowRuns.push(
        ...runs.value.map((run) => ({
          ...run,
          fullDepth: workflow !== CI_WORKFLOW,
        })),
      );
    }
  }
  return Result.ok(workflowRuns);
};

export const collectEvidence = async ({
  gh,
  repository,
  now,
  workdir,
}: CollectOptions): Promise<Result<Collected, GhCommandError>> => {
  const since = now.getTime() - HISTORY_WINDOW_DAYS * DAY_MS;
  const listedRuns = await listWorkflowRuns({ gh, repository, now, since });
  if (listedRuns.isErr()) {
    return listedRuns;
  }
  const workflowRuns = listedRuns.value;
  const runsById = new Map(workflowRuns.map((run) => [run.id, run]));

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
    const pages = v.parse(artifactPagesSchema, JSON.parse(listed.value));
    const artifacts = pages.flatMap((page) => page.artifacts);
    const total = pages.at(0)?.total_count ?? 0;
    if (artifacts.length !== total) {
      return Result.err(
        new GhCommandError({
          message: `Incomplete artifact listing for ${name}: GitHub reported ${total}, but returned ${artifacts.length}.`,
        }),
      );
    }
    for (const artifact of artifacts) {
      const run = artifact.workflow_run;
      const workflowRun = run === null ? undefined : runsById.get(run.id);
      if (
        artifact.expired ||
        run === null ||
        workflowRun === undefined ||
        Date.parse(artifact.created_at) < since
      ) {
        continue;
      }
      const source: ArtifactSource = {
        runId: run.id,
        headSha: run.head_sha,
        headBranch: workflowRun.head_branch,
        fullDepth: workflowRun.fullDepth,
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

  const digests = await download(FAILURE_DIGEST_ARTIFACT, () => true);
  if (digests.isErr()) {
    return digests;
  }
  const parsedDigests = digests.value.flatMap(({ dir, ...source }) => {
    const records = readOr(
      digestFileSchema,
      path.join(dir, "ci-failures.json"),
    )?.failures;
    return records === undefined
      ? []
      : [
          {
            ...source,
            tests: records.flatMap(({ tests, job, step }) =>
              tests.map((test) => ({ ...test, job, step })),
            ),
            checks: records.map(({ job, step }) => ({ job, step })),
          },
        ];
  });
  const receipts = new Map<
    number,
    { readonly job: string; readonly step: string }[]
  >();
  for (const run of workflowRuns) {
    const needsReceipt =
      run.conclusion === "success" &&
      (run.fullDepth ||
        parsedDigests.some(
          (digest) =>
            digest.headSha === run.head_sha &&
            Date.parse(run.run_started_at) > Date.parse(digest.createdAt),
        ));
    if (!needsReceipt) {
      continue;
    }
    const jobsJson = await gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
    ]);
    if (jobsJson.isErr()) {
      return jobsJson;
    }
    receipts.set(run.id, successfulJobFamilySteps(jobsJson.value));
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
      runs: workflowRuns.map((run) => ({
        id: run.id,
        headSha: run.head_sha,
        headBranch: run.head_branch,
        fullDepth: run.fullDepth,
        conclusion: run.conclusion,
        url: `https://github.com/${repository}/actions/runs/${run.id}`,
        startedAt: run.run_started_at,
        successfulChecks: receipts.get(run.id) ?? [],
      })),
      digests: parsedDigests,
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

// CODEOWNERS paths are gitignore-style: a leading or inner slash anchors the
// pattern to the repository root, otherwise it matches at any depth, and a
// pattern also covers everything inside a directory of that name.
const codeownersGlobs = (rawPattern: string): Bun.Glob[] => {
  const trimmed = rawPattern.replace(/^\/|\/$/gu, "");
  const anchored = rawPattern.startsWith("/") || trimmed.includes("/");
  const base = anchored ? trimmed : `**/${trimmed}`;
  const inside = new Bun.Glob(`${base}/**`);
  return rawPattern.endsWith("/") ? [inside] : [new Bun.Glob(base), inside];
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
    const globs = codeownersGlobs(rawPattern);
    for (const file of new Set(files)) {
      if (globs.some((glob) => glob.match(file))) {
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
      // Reporting only: a truncated record or an unreadable history becomes a
      // warning, never a failure of the job that ran the tests.
      await runJobSummary(args).catch((error: unknown) => {
        console.log(
          `::warning title=Quarantine report unavailable::${annotationData(error instanceof Error ? error.message : String(error))}`,
        );
      });
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
