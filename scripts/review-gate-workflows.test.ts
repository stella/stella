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
  jobs: Record<
    string,
    {
      if?: string;
      permissions?: unknown;
      steps: readonly {
        uses?: string;
        run?: string;
        with?: Record<string, unknown>;
      }[];
    }
  >;
};

const readWorkflow = (file: string): Workflow => {
  const parsed: unknown = Bun.YAML.parse(
    readFileSync(path.join(WORKFLOWS, file), "utf-8"),
  );
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError(`${file} is not a mapping`);
  }
  return parsed as Workflow;
};

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
  test("runs only on triggers that execute the default branch's definition", () => {
    for (const trigger of Object.keys(publisher.on)) {
      expect(DEFAULT_BRANCH_TRIGGERS).toContain(trigger);
    }
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
    expect(source).not.toMatch(/pull_request\.head\.(sha|ref)|head_ref/u);
  });

  // The token matches the configured mode, both ways: enforce mode's dequeue
  // (a merge-queue write, like enqueuing) needs contents and pull-requests
  // write, and shadow mode, which never dequeues, holds neither.
  test("holds exactly the permissions its configured mode needs", () => {
    const { mode } = parseReviewGateConfig(
      Bun.YAML.parse(
        readFileSync(
          path.join(import.meta.dirname, "..", ".github", "review-gate.yml"),
          "utf-8",
        ),
      ),
    );
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
      expect(Object.values(job.permissions as Record<string, string>)).toEqual(
        expect.arrayContaining(["read"]),
      );
      expect(
        Object.values(job.permissions as Record<string, string>),
      ).not.toContain("write");
    }
  });
});
