// The review gate's trust boundary lives in its workflow files, not its
// script: which events may publish, what they check out, and which token
// they hold. These assertions fail the edit that would move that boundary.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseReviewGateConfig } from "./review-gate";

const WORKFLOWS = path.join(import.meta.dirname, "..", ".github", "workflows");

type Workflow = {
  name: string;
  on: Record<string, unknown>;
  permissions: unknown;
  concurrency?: unknown;
  jobs: Record<
    string,
    {
      if?: string;
      permissions?: unknown;
      concurrency?: unknown;
      steps: readonly {
        uses?: string;
        run?: string;
        with?: Record<string, unknown>;
      }[];
    }
  >;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isWorkflow = (value: unknown): value is Workflow =>
  isRecord(value) &&
  typeof value["name"] === "string" &&
  isRecord(value["on"]) &&
  isRecord(value["jobs"]) &&
  Object.values(value["jobs"]).every(
    (job) => isRecord(job) && Array.isArray(job["steps"]),
  );

const readWorkflow = (file: string): Workflow => {
  const parsed: unknown = Bun.YAML.parse(
    readFileSync(path.join(WORKFLOWS, file), "utf-8"),
  );
  return isWorkflow(parsed)
    ? parsed
    : expect.unreachable(`${file} is not a workflow`);
};

const permissionLevels = (permissions: unknown): readonly unknown[] =>
  isRecord(permissions) ? Object.values(permissions) : [];

const config = parseReviewGateConfig(
  Bun.YAML.parse(
    readFileSync(
      path.join(import.meta.dirname, "..", ".github", "review-gate.yml"),
      "utf-8",
    ),
  ),
);

const publisher = readWorkflow("review-gate.yml");
const relay = readWorkflow("review-gate-signal.yml");
const monitor = readWorkflow("review-gate-monitor.yml");

// Triggers whose runs execute the DEFAULT branch's workflow definition.
const DEFAULT_BRANCH_TRIGGERS = [
  "pull_request_target",
  "issue_comment",
  "status",
  "check_run",
  "workflow_run",
  "schedule",
  "workflow_dispatch",
];

// The triggers that carry a reviewer's own report, each needed exactly when
// some configured reviewer reports that way: without one, that reviewer is
// heard only by the sweep; with one no reviewer needs, every run is a no-op
// that still waits for a runner.
const SIGNAL_TRIGGERS: Record<string, boolean> = {
  status: config.reviewers.some(({ done }) => done.commitStatus !== null),
  check_run: config.reviewers.some(({ done }) => done.checkRun !== null),
};

describe("the publisher", () => {
  // Both directions: an added trigger could run a pull request's own
  // definition, and a dropped one silently stops pushes, the relay, or the
  // sweep that applies timeouts and catches resolved threads.
  test("runs on exactly the triggers that execute the default branch's definition", () => {
    expect(Object.keys(publisher.on).toSorted()).toEqual(
      DEFAULT_BRANCH_TRIGGERS.filter(
        (trigger) => SIGNAL_TRIGGERS[trigger] !== false,
      ).toSorted(),
    );
  });

  test.each(Object.entries(SIGNAL_TRIGGERS))(
    "has the %s trigger exactly when a configured reviewer reports that way",
    (trigger, needed) => {
      expect(Object.hasOwn(publisher.on, trigger)).toBe(needed);
    },
  );

  // The dispatch step's `case` arms, label list to command. A trigger is only
  // heard if its own arm reads its payload, so arms and triggers are held
  // together here rather than trusted to be edited in step.
  const dispatchArms = new Map(
    Object.values(publisher.jobs)
      .flatMap((job) => job.steps)
      .flatMap((step) =>
        step.run?.includes('case "$EVENT_NAME"') === true ? [step.run] : [],
      )
      .flatMap((script) =>
        [...script.matchAll(/^\s*([a-z_|*]+)\) (.+?) ;;$/gmu)].map(
          (match): [string, string] => [match[1] ?? "", match[2] ?? ""],
        ),
      ),
  );
  const armFor = (event: string): string | undefined =>
    [...dispatchArms].find(([labels]) =>
      labels.split("|").includes(event),
    )?.[1];

  test("dispatches every trigger by name and fails any other event", () => {
    expect(
      [...dispatchArms.keys()]
        .filter((labels) => labels !== "*")
        .flatMap((labels) => labels.split("|"))
        .toSorted(),
    ).toEqual(Object.keys(publisher.on).toSorted());
    expect(armFor("*")).toContain("exit 1");
  });

  test.each(Object.entries(SIGNAL_TRIGGERS).filter(([, needed]) => needed))(
    "reads each %s event as a reviewer signal on its commit",
    (trigger) => {
      expect(armFor(trigger)).toMatch(
        /^bun scripts\/review-gate-github\.ts sha "\$\w+" --signal "\$\w+"$/u,
      );
    },
  );

  test("publishes only from the default branch ref", () => {
    for (const job of Object.values(publisher.jobs)) {
      expect(job.if).toContain(
        "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
      );
    }
  });

  test("checks out the commit its own definition came from, never pull request code (forks included)", () => {
    const checkouts = Object.values(publisher.jobs).flatMap((job) =>
      job.steps.filter((step) => step.uses?.startsWith("actions/checkout@")),
    );
    expect(checkouts).toHaveLength(1);
    for (const step of checkouts) {
      expect(step.with?.["ref"]).toMatch(/^\$\{\{ github\.sha \}\}$/u);
      expect(step.with?.["persist-credentials"]).toBe(false);
    }
    const source = readFileSync(
      path.join(WORKFLOWS, "review-gate.yml"),
      "utf-8",
    );
    // The head commit may say where to publish, never what to run: no branch
    // name, no second fetch or checkout.
    expect(source).not.toMatch(
      /pull_request\.head\.ref|head_ref|git (?:fetch|checkout)|gh pr checkout/u,
    );
  });

  // The token matches the configured mode, both ways: enforce mode's dequeue
  // (a merge-queue write, like enqueuing) needs contents and pull-requests
  // write, and shadow mode, which never dequeues, holds neither.
  test("holds exactly the permissions its configured mode needs", () => {
    const { mode } = config;
    const access = mode === "enforce" ? "write" : "read";
    expect(publisher.permissions).toEqual({});
    for (const job of Object.values(publisher.jobs)) {
      expect(job.permissions).toEqual({
        checks: "write",
        contents: access,
        "pull-requests": access,
      });
    }
  });

  test("hears the relay by its exact name", () => {
    expect(publisher.on["workflow_run"]).toEqual({
      workflows: [relay.name],
      types: ["requested"],
    });
  });
});

// Concurrency and the event filter decide which evaluations can drop one
// another. A run whose job is skipped must never enter a group, and a merge
// group's evaluation must never be replaced by anything: until the next
// sweep, nothing else evaluates that commit.
describe("the publisher's concurrency", () => {
  const [job] = Object.values(publisher.jobs);
  // Workflow-level, as every pull request workflow's is
  // (scripts/workflow-concurrency.test.ts): a run joins it before the job's
  // `if:` is read, so each alternative must hold for every event, including
  // the ones the job then skips.
  const concurrency = isRecord(publisher.concurrency)
    ? publisher.concurrency
    : {};
  const group = concurrency["group"];
  // In order: the first alternative that holds wins, and `&&` binds tighter
  // than `||`, so each alternative is one condition and its key.
  const alternatives =
    typeof group === "string"
      ? group
          .replaceAll(/\s+/gu, " ")
          .replace(/^review-gate-\$\{\{ /u, "")
          .replace(/ \}\}$/u, "")
          .split("||")
          .map((part) => part.trim())
      : [];
  const OWN_GROUP = "format('run-{0}', github.run_id)";

  test("is set on the workflow, never on the job", () => {
    expect(typeof group).toBe("string");
    expect(concurrency["cancel-in-progress"]).toBe(true);
    expect(job?.concurrency).toBeUndefined();
  });

  // GitHub replaces even a pending run when another joins its group, whatever
  // cancel-in-progress says, so only a group of its own keeps a run. The own
  // groups come first, ahead of every key another event could share.
  test("gives every run that must finish a group of its own", () => {
    expect(alternatives.slice(0, 4)).toEqual([
      // Listed among the pull request's checks, where cancelled reads as failed.
      `github.event_name == 'pull_request_target' && ${OWN_GROUP}`,
      // The group commit's only evaluation until the next sweep.
      `github.event.workflow_run.event == 'merge_group' && ${OWN_GROUP}`,
      // Every app's statuses arrive, and only the script can tell a
      // reviewer's from the rest: a no-op must never replace a run.
      `github.event_name == 'status' && ${OWN_GROUP}`,
      // The sweep, the fallback for every group, never cut short mid-pass.
      `github.event_name == 'schedule' && ${OWN_GROUP}`,
    ]);
  });

  test("shares a group only between runs that re-read what they replace", () => {
    expect(alternatives.slice(4)).toEqual([
      "github.event.workflow_run.head_sha",
      "github.event.issue.number",
      "inputs.pr",
      OWN_GROUP,
    ]);
  });

  // Reviewer names live only in .github/review-gate.yml: the workflow must
  // not keep a copy that could drift from it.
  test("names no reviewer, leaving the choice to the script and its config", () => {
    const workflow = JSON.stringify(job ?? {});
    for (const reviewer of config.reviewers) {
      const { commitStatus, checkRun } = reviewer.done;
      if (commitStatus !== null) {
        expect(workflow).not.toContain(commitStatus.context);
      }
      if (checkRun !== null) {
        expect(workflow).not.toContain(checkRun.name);
      }
    }
  });
});

describe("the relay", () => {
  test("carries the events that run a pull request's own workflow version", () => {
    expect(Object.keys(relay.on).toSorted()).toEqual([
      "merge_group",
      "pull_request_review",
      "pull_request_review_comment",
    ]);
  });

  test("has no permissions, checks nothing out and uses no action or secret", () => {
    expect(relay.permissions).toEqual({});
    for (const job of Object.values(relay.jobs)) {
      expect(job.permissions).toBeUndefined();
      for (const step of job.steps) {
        expect(step.uses).toBeUndefined();
      }
    }
    const source = readFileSync(
      path.join(WORKFLOWS, "review-gate-signal.yml"),
      "utf-8",
    );
    expect(source).not.toContain("secrets.");
    expect(source).not.toContain("github.token");
  });
});

describe("the monitor", () => {
  test("shares no code with the evaluator and cannot write", () => {
    const source = readFileSync(
      path.join(WORKFLOWS, "review-gate-monitor.yml"),
      "utf-8",
    );
    expect(source).not.toContain("scripts/review-gate");
    for (const job of Object.values(monitor.jobs)) {
      expect(permissionLevels(job.permissions)).toEqual(
        expect.arrayContaining(["read"]),
      );
      expect(permissionLevels(job.permissions)).not.toContain("write");
    }
  });
});

// The hand-run eviction holds the same write access enforce mode needs, so
// it is started only by a maintainer and does nothing but the dequeue.
describe("the dequeue workflow", () => {
  const dequeue = readWorkflow("review-gate-dequeue.yml");

  test("runs only by hand, with just the merge-queue write", () => {
    expect(Object.keys(dequeue.on)).toEqual(["workflow_dispatch"]);
    expect(dequeue.permissions).toEqual({});
    for (const job of Object.values(dequeue.jobs)) {
      expect(job.permissions).toEqual({
        contents: "write",
        "pull-requests": "write",
      });
      expect(job.steps.at(-1)?.run).toBe(
        'bun scripts/review-gate-github.ts dequeue "$PR_NUMBER"',
      );
    }
  });
});
