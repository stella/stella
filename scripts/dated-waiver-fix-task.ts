import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { sha256Hex } from "@stll/sha256/bun";

import type { githubRequest } from "./dated-waiver-publish";
import type { DatedWaiver, ProbeKind } from "./dated-waivers";

export const DATED_WAIVER_AUTOFIX_LABEL = "dated-waiver-failure";
export const EXPIRY_ALERT_LABEL = "dated-waiver-expiry-alert";
export const FIX_TASK_IDENTITY_LABEL = "dated-waiver:task";

export const waiverKey = (entry: DatedWaiver): string =>
  sha256Hex(JSON.stringify([entry.kind, entry.source, entry.id])).slice(0, 24);

export type FixEvidence = {
  attempts: number;
  passed: number;
  command: readonly string[];
  output: string;
  runner: string;
  sha: string;
  sourceFingerprint: string;
  observedAt: string;
  run: string;
};

export const probeSourceFingerprint = (
  files: Readonly<Record<string, string>>,
): string =>
  sha256Hex(
    JSON.stringify(
      Object.entries(files).toSorted(([left], [right]) =>
        compareCodeUnit(left, right),
      ),
    ),
  );

// Registry age and advisory/URL state can change without a repository edit.
export const RESOLUTION_POLICY = {
  "no-llms-txt": "external",
  "release-age-exclusion": "external",
  "release-age-exception": "external",
  "dependency-audit": "external",
  "suppression-waiver": "repository",
  "quarantined-test": "repository",
} as const satisfies Record<ProbeKind, "external" | "repository">;

const failureSourceSchema = v.object({
  sha: v.string(),
  sourceFingerprint: v.string(),
  observedAt: v.pipe(v.string(), v.isoTimestamp()),
});
export type RemovalAssessment =
  | { status: "eligible" }
  | { status: "blocked"; task: Pick<FixTask, "number" | "state"> };

const issueSchema = v.object({
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  body: v.nullish(v.string(), ""),
  state: v.picklist(["open", "closed"]),
  labels: v.array(v.object({ name: v.string() })),
});
type FixTask = v.InferOutput<typeof issueSchema>;
class FixLabelError extends TaggedError("FixLabelError")<{ message: string }> {}

const ensurePrivateTaskLabel = async (
  repo: string,
  label: string,
): Promise<void> => {
  const result = await Result.tryPromise(async () => {
    const proc = Bun.spawn(
      [
        "gh",
        "label",
        "create",
        label,
        "--repo",
        repo,
        "--color",
        "ededed",
        "--force",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
        killSignal: "SIGKILL",
      },
    );
    // Drain both streams without accumulating or exposing private CLI output.
    const completed = await Promise.all([
      proc.stdout.pipeTo(new WritableStream()),
      proc.stderr.pipeTo(new WritableStream()),
      proc.exited,
    ]);
    return completed.at(2);
  });
  if (Result.isError(result) || result.value !== 0) {
    throw new FixLabelError({
      message: "Private fix-task label provisioning failed; output withheld.",
    });
  }
};

type PrivateTaskOptions = {
  repo: string;
  request: typeof githubRequest;
  ensureLabel?: typeof ensurePrivateTaskLabel;
};

const readFailureSource = (task: FixTask) => {
  const header = task.body.split("\n").at(1);
  const encoded = /^<!-- failure-source:([A-Za-z0-9+/=]+) -->$/u
    .exec(header ?? "")
    ?.at(1);
  if (!encoded) {
    return undefined;
  }
  const parsed = Result.try(() =>
    JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")),
  );
  if (Result.isError(parsed)) {
    return undefined;
  }
  const source = v.safeParse(failureSourceSchema, parsed.value);
  return source.success ? source.output : undefined;
};
type MergedResolutionOptions = {
  task: FixTask;
  evidence: FixEvidence;
  failureSha: string;
  api: string;
  request: typeof githubRequest;
};
const hasMergedResolution = async ({
  task,
  evidence,
  failureSha,
  api,
  request,
}: MergedResolutionOptions): Promise<boolean> => {
  if (task.state !== "closed" || evidence.sha === failureSha) {
    return false;
  }
  // Resolution links are read from GitHub timeline events, not issue prose.
  for (let page = 1; page <= 20; page++) {
    const events = v.parse(
      v.array(v.unknown()),
      await request([
        `${api}/issues/${task.number}/timeline`,
        "--method",
        "GET",
        "-f",
        "per_page=100",
        "-f",
        `page=${page}`,
      ]),
    );
    for (const event of events) {
      const reference = v.safeParse(
        v.object({
          event: v.literal("cross-referenced"),
          source: v.object({
            issue: v.object({
              number: v.pipe(v.number(), v.integer(), v.minValue(1)),
              repository_url: v.literal(
                "https://api.github.com/repos/stella/stella",
              ),
              pull_request: v.object({ url: v.string() }),
            }),
          }),
        }),
        event,
      );
      if (!reference.success) {
        continue;
      }
      const number = reference.output.source.issue.number;
      const pull = v.parse(
        v.object({
          merged_at: v.nullable(v.string()),
          merge_commit_sha: v.nullable(v.string()),
        }),
        await request([`repos/stella/stella/pulls/${number}`]),
      );
      if (
        !pull.merged_at ||
        !pull.merge_commit_sha ||
        pull.merge_commit_sha === failureSha
      ) {
        continue;
      }
      const before = v.parse(
        v.object({ status: v.string() }),
        await request([
          `repos/stella/stella/compare/${failureSha}...${pull.merge_commit_sha}`,
        ]),
      );
      if (before.status !== "ahead") {
        continue;
      }
      const included = v.parse(
        v.object({ status: v.string() }),
        await request([
          `repos/stella/stella/compare/${pull.merge_commit_sha}...${evidence.sha}`,
        ]),
      );
      if (included.status === "ahead" || included.status === "identical") {
        return true;
      }
    }
    if (events.length < 100) {
      return false;
    }
  }
  panic("Fix-task resolution history exceeds pagination budget");
};

// Private visibility is established before sending any failing evidence.
export const createPrivateTaskSink = async ({
  repo,
  request,
  ensureLabel = ensurePrivateTaskLabel,
}: PrivateTaskOptions) => {
  if (!/^stella\/[A-Za-z0-9_.-]+$/u.test(repo) || repo === "stella/stella") {
    panic("Fix tasks require a separate private companion repository");
  }
  const visibility = v.parse(
    v.object({ private: v.boolean() }),
    await request([`repos/${repo}`]),
  );
  if (!visibility.private) {
    panic("Fix tasks require a private repository");
  }
  const api = `repos/${repo}`;
  // GitHub silently ignores issue labels that do not exist. Establish the
  // selectors before publishing tasks so the consumer and watcher see them.
  for (const name of [
    DATED_WAIVER_AUTOFIX_LABEL,
    EXPIRY_ALERT_LABEL,
    FIX_TASK_IDENTITY_LABEL,
  ]) {
    await ensureLabel(repo, name);
  }
  const findTask = async (entry: DatedWaiver): Promise<FixTask | undefined> => {
    const marker = `<!-- dated-waiver:${waiverKey(entry)} -->`;
    const matches: FixTask[] = [];
    // Label-scoped pagination includes closed tasks so a red recurrence reopens
    // the same root-cause task instead of duplicating it.
    for (let page = 1; page <= 100; page++) {
      const issues = v.parse(
        v.array(issueSchema),
        await request([
          `${api}/issues`,
          "--method",
          "GET",
          "-f",
          "state=all",
          "-f",
          `labels=${FIX_TASK_IDENTITY_LABEL}`,
          "-f",
          "per_page=100",
          "-f",
          `page=${page}`,
        ]),
      );
      // Captured output is untrusted text; only the publisher-owned first line
      // establishes identity, even if diagnostics contain another task marker.
      matches.push(
        ...issues.filter((issue) => issue.body.startsWith(`${marker}\n`)),
      );
      if (issues.length < 100) {
        if (matches.length > 1) {
          panic("Duplicate dated waiver fix tasks");
        }
        return matches.at(0);
      }
    }
    panic("Fix-task inventory exceeds pagination budget");
  };
  const openFixTask = async (
    entry: DatedWaiver,
    evidence: FixEvidence,
  ): Promise<FixTask> => {
    const existing = await findTask(entry);
    const body = [
      `<!-- dated-waiver:${waiverKey(entry)} -->`,
      `<!-- failure-source:${Buffer.from(JSON.stringify({ sha: evidence.sha, sourceFingerprint: evidence.sourceFingerprint, observedAt: evidence.observedAt })).toString("base64")} -->`,
      "Fix the root cause. Do not retry the failing job, extend the deadline, or weaken the check.",
      "",
      JSON.stringify(
        {
          source: entry.source,
          id: entry.id,
          expiresAt: entry.expiresAt,
          ...evidence,
        },
        null,
        2,
      ),
    ].join("\n");
    const labels = [
      ...new Set([
        ...(existing?.labels.map(({ name }) => name) ?? []),
        FIX_TASK_IDENTITY_LABEL,
        DATED_WAIVER_AUTOFIX_LABEL,
      ]),
    ];
    return v.parse(
      issueSchema,
      await request(
        [
          existing ? `${api}/issues/${existing.number}` : `${api}/issues`,
          "--method",
          existing ? "PATCH" : "POST",
          "--input",
          "-",
        ],
        {
          title: "Resolve dated maintenance check",
          body,
          state: "open",
          labels,
        },
      ),
    );
  };
  const alertExpiry = async (
    task: Pick<FixTask, "number" | "state">,
  ): Promise<void> => {
    const current = v.parse(
      issueSchema,
      await request([`${api}/issues/${task.number}`]),
    );
    if (
      current.state !== "open" ||
      current.labels.some(({ name }) => name === EXPIRY_ALERT_LABEL)
    ) {
      return;
    }
    await request(
      [
        `${api}/issues/${task.number}/labels`,
        "--method",
        "POST",
        "--input",
        "-",
      ],
      { labels: [EXPIRY_ALERT_LABEL] },
    );
  };
  const assessTask = async (
    task: FixTask,
    entry: DatedWaiver,
    evidence: FixEvidence,
  ): Promise<RemovalAssessment> => {
    const failure = readFailureSource(task);
    if (
      !failure ||
      evidence.attempts !== entry.probe.attempts ||
      evidence.passed !== entry.probe.attempts
    ) {
      return { status: "blocked", task };
    }
    if (RESOLUTION_POLICY[entry.kind] === "external") {
      return Number.isFinite(Date.parse(evidence.observedAt)) &&
        Date.parse(evidence.observedAt) > Date.parse(failure.observedAt)
        ? { status: "eligible" }
        : { status: "blocked", task };
    }
    if (
      evidence.sha !== failure.sha &&
      evidence.sourceFingerprint !== failure.sourceFingerprint
    ) {
      return { status: "eligible" };
    }
    if (
      await hasMergedResolution({
        task,
        evidence,
        failureSha: failure.sha,
        api,
        request,
      })
    ) {
      return { status: "eligible" };
    }
    return { status: "blocked", task };
  };
  const assessRemoval = async (
    entry: DatedWaiver,
    evidence: FixEvidence,
  ): Promise<RemovalAssessment> => {
    const task = await findTask(entry);
    return task ? assessTask(task, entry, evidence) : { status: "eligible" };
  };
  const resolveFixTask = async (
    entry: DatedWaiver,
    evidence: FixEvidence,
  ): Promise<void> => {
    const task = await findTask(entry);
    if (task?.state !== "open") {
      return;
    }
    if ((await assessTask(task, entry, evidence)).status === "blocked") {
      panic("Fix task requires resolution evidence");
    }
    await request(
      [`${api}/issues/${task.number}`, "--method", "PATCH", "--input", "-"],
      { state: "closed", state_reason: "completed" },
    );
  };
  return { openFixTask, findTask, alertExpiry, resolveFixTask, assessRemoval };
};
