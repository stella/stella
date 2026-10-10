import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";

import type { githubRequest } from "./dated-waiver-publish";
import type { DatedWaiver } from "./dated-waivers";

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
  run: string;
};

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
  const resolveFixTask = async (entry: DatedWaiver): Promise<void> => {
    const task = await findTask(entry);
    if (task?.state !== "open") {
      return;
    }
    await request(
      [`${api}/issues/${task.number}`, "--method", "PATCH", "--input", "-"],
      { state: "closed", state_reason: "completed" },
    );
  };
  return { openFixTask, findTask, alertExpiry, resolveFixTask };
};
