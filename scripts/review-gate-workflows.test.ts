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

describe("the publisher", () => {
  // Both directions: an added trigger could run a pull request's own
  // definition, and a dropped one silently stops pushes, the relay, or the
  // sweep that applies timeouts and catches resolved threads.
  test("runs on exactly the triggers that execute the default branch's definition", () => {
    expect(Object.keys(publisher.on).toSorted()).toEqual(
      DEFAULT_BRANCH_TRIGGERS.toSorted(),
    );
  });

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
  const [job, ...others] = Object.values(publisher.jobs);
  const concurrency = isRecord(job?.concurrency) ? job.concurrency : {};
  const group = concurrency["group"];
  // In order: the first alternative that holds wins, and `&&` binds tighter
  // than `||`, so each alternative is one condition and its key.
  const alternatives =
    typeof group === "string"
      ? group
          .replaceAll(/\s+/gu, " ")
          .split("||")
          .map((part) => part.trim())
      : [];
  const OWN_GROUP = "format('run-{0}', github.run_id)";

  test("is set on the one job, never on the workflow", () => {
    expect(others).toEqual([]);
    expect(publisher.concurrency).toBeUndefined();
    expect(typeof group).toBe("string");
  });

  // Its pull_request_target run is listed among the pull request's checks,
  // so another event for the same head cancelling it reads as failed CI.
  test("never lets another run cancel a pull request event's run", () => {
    expect(alternatives[0]).toEndWith(
      `github.event_name == 'pull_request_target' && ${OWN_GROUP}`,
    );
  });

  // GitHub replaces even a pending run when another joins its group, whatever
  // cancel-in-progress says, so only a group of its own keeps it.
  test("never lets another run replace or cancel a merge group's evaluation", () => {
    expect(alternatives[1]).toBe(
      `github.event.workflow_run.event == 'merge_group' && ${OWN_GROUP}`,
    );
  });

  // Every app's statuses and check runs reach the job, and only the script
  // can tell a reviewer's from the rest, so none of them may share a group:
  // a no-op from any app would otherwise replace a pending evaluation.
  test("never lets a status or check run replace or cancel another run", () => {
    expect(alternatives[2]).toBe(
      `contains(fromJSON('["status","check_run"]'), github.event_name) && ${OWN_GROUP}`,
    );
    // Ahead of every key such an event could share with another run.
    expect(alternatives[3]).toBe("github.event.workflow_run.head_sha");
    expect(group).not.toContain("github.event.sha");
    expect(group).not.toContain("github.event.check_run.head_sha");
  });

  test("never cancels the sweep, the fallback for every group", () => {
    expect(alternatives.at(-1)).toBe("'sweep' }}");
    expect(concurrency["cancel-in-progress"]).toMatch(
      /^\$\{\{ github\.event_name != 'schedule' \}\}$/u,
    );
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
