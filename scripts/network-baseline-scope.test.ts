import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  scopeBaseline,
  summarizeBudgetChanges,
  validateBaselineFile,
} from "./network-baseline-scope";

const entry = (depth: number) => ({ depth, requests: [`GET /${depth}`] });

const routeTree = `
import { Route as rootRouteImport } from './routes/__root'
import { Route as IndexRouteImport } from './routes/index'
import { Route as ProtectedRouteImport } from './routes/_protected'
import { Route as ChatRouteRouteImport } from './routes/_protected.chat/route'
import { Route as ChatRouteImport } from './routes/_protected.chat/index'
import { Route as SettingsRouteImport } from './routes/_protected.settings/index'
declare module '@tanstack/react-router' {
  interface FileRoutesByPath {
    '/': {
      id: '/'
      path: '/'
      fullPath: '/'
      preLoaderRoute: typeof IndexRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/_protected': {
      id: '/_protected'
      path: ''
      fullPath: '/'
      preLoaderRoute: typeof ProtectedRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/_protected/chat': {
      id: '/_protected/chat'
      path: '/chat'
      fullPath: '/chat'
      preLoaderRoute: typeof ChatRouteRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/chat/': {
      id: '/_protected/chat/'
      path: '/'
      fullPath: '/chat/'
      preLoaderRoute: typeof ChatRouteImport
      parentRoute: typeof ChatRouteRoute
    }
    '/settings': {
      id: '/settings'
      path: '/settings'
      fullPath: '/settings'
      preLoaderRoute: typeof SettingsRouteImport
      parentRoute: typeof ProtectedRoute
    }
  }
}`;

describe("network baseline scope", () => {
  test("keeps new and touched routes, restores all other base entries", () => {
    const base = { "/": entry(1), "/chat": entry(2), "/settings": entry(3) };
    const recorded = {
      "/": entry(11),
      "/chat": entry(22),
      "/new-route": entry(44),
    };

    expect(
      scopeBaseline({
        base,
        recorded,
        changedPaths: ["apps/web/src/routes/_protected.chat/index.tsx"],
        routeTree,
        baseRouteTree: routeTree,
      }),
    ).toEqual({
      "/": entry(1),
      "/chat": entry(22),
      "/settings": entry(3),
    });
  });

  test("accepts index and redirect target keys with a trailing slash in the tree", () => {
    const base = { "/chat": entry(1), "/chat target": entry(2) };
    const recorded = { "/chat": entry(11), "/chat target": entry(22) };
    expect(
      scopeBaseline({
        base,
        recorded,
        changedPaths: ["apps/web/src/routes/_protected.chat/index.tsx"],
        baseRouteTree: routeTree,
        routeTree,
      }),
    ).toEqual(recorded);
  });

  test("a changed pathless layout marks descendants", () => {
    const base = { "/chat": entry(1), "/settings": entry(2) };
    const recorded = { "/chat": entry(11), "/settings": entry(22) };
    expect(
      scopeBaseline({
        base,
        recorded,
        changedPaths: ["apps/web/src/routes/_protected.tsx"],
        baseRouteTree: routeTree,
        routeTree,
      }),
    ).toEqual(recorded);
  });

  test("omits a deleted route present only in the base tree", () => {
    const headRouteTree = routeTree.replace(
      / {4}'\/_protected\/chat\/': \{[\s\S]*?^ {4}\}\n/gmu,
      "",
    );
    expect(
      scopeBaseline({
        base: { "/chat": entry(1), "/settings": entry(2) },
        recorded: { "/settings": entry(22) },
        changedPaths: ["apps/web/src/routes/_protected.chat/index.tsx"],
        baseRouteTree: routeTree,
        routeTree: headRouteTree,
      }),
    ).toEqual({ "/settings": entry(2) });
  });

  test("--all permits every recorded entry while retaining recorded omissions", () => {
    const base = { "/": entry(1), "/settings": entry(3) };
    const recorded = { "/": entry(11) };
    expect(
      scopeBaseline({
        base,
        recorded,
        changedPaths: [],
        baseRouteTree: routeTree,
        routeTree,
        all: true,
      }),
    ).toEqual(recorded);
  });

  test("rejects a budget for a request the route does not record", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "network-baseline-"));
    try {
      for (const field of ["requestCounts", "dbQueries", "responseSizes"]) {
        const file = path.join(directory, `${field}.json`);
        writeFileSync(
          file,
          JSON.stringify({ "/": { ...entry(1), [field]: { "GET /gone": 1 } } }),
        );
        const result = Bun.spawnSync([
          "bun",
          "scripts/network-baseline-scope.ts",
          "validate",
          file,
        ]);
        expect(result.exitCode, field).toBe(1);
        writeFileSync(
          file,
          JSON.stringify({ "/": { ...entry(1), [field]: { "GET /1": 1 } } }),
        );
        expect(validateBaselineFile(file)["/"]?.requests).toEqual(["GET /1"]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("validates schema and rejects oversized files and symlinks", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "network-baseline-"));
    const validPath = path.join(directory, "baseline.json");
    const oversizedPath = path.join(directory, "oversized.json");
    const symlinkPath = path.join(directory, "linked.json");
    try {
      writeFileSync(validPath, JSON.stringify({ "/": entry(1) }));
      expect(validateBaselineFile(validPath)).toEqual({ "/": entry(1) });
      writeFileSync(oversizedPath, " ".repeat(5 * 1024 * 1024 + 1));
      symlinkSync(validPath, symlinkPath);
      for (const { file, message } of [
        { file: oversizedPath, message: "exceeds" },
        { file: symlinkPath, message: "must not be a symlink" },
      ]) {
        const result = Bun.spawnSync([
          "bun",
          "scripts/network-baseline-scope.ts",
          "validate",
          file,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain(message);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("network baseline budget summary", () => {
  test("lists added, removed and changed budgets per route", () => {
    const summary = summarizeBudgetChanges({
      base: {
        "/chat": {
          depth: 2,
          requests: ["GET /a", "GET /old"],
          requestCounts: { "GET /a": 1 },
          dbQueries: { "GET /a": 4 },
        },
        "/gone": entry(1),
        "/same": entry(3),
      },
      recorded: {
        "/chat": {
          depth: 3,
          requests: ["GET /a", "GET /b"],
          requestCounts: { "GET /a": 2 },
          dbQueries: { "GET /a": 4, "GET /b": 1 },
          responseSizes: { "GET /b": 900 },
        },
        "/new": entry(5),
        "/same": entry(3),
      },
    });
    expect(summary).toBe(
      [
        "This network baseline was recorded by this pull request's own code.",
        "",
        "Budget changes against the base branch:",
        "",
        "- `/chat`: depth 2 → 3; requestCounts `GET /a` 1 → 2; dbQueries `GET /b` none → 1; responseSizes `GET /b` none → 900; request `GET /b` added; request `GET /old` removed",
        "- `/gone`: removed",
        "- `/new`: added, depth 5, allowed requests 1",
        "",
        "Review these as budget changes and resolve this thread to accept them.",
      ].join("\n"),
    );
  });

  test("says so when nothing changed against the base branch", () => {
    const baseline = { "/": entry(1) };
    expect(
      summarizeBudgetChanges({ base: baseline, recorded: baseline }),
    ).toContain("No budget changes against the base branch.");
  });

  test("renders recorded keys as inert code spans", () => {
    const summary = summarizeBudgetChanges({
      base: {},
      recorded: { "/x`\n@team **bold**": entry(1) },
    });
    expect(summary).toContain("- `/x  @team **bold**`: added");
    expect(summary.split("\n")).toHaveLength(7);
  });

  test("stays under the comment size limit", () => {
    const recorded = Object.fromEntries(
      Array.from({ length: 5000 }, (_, index) => [
        `/route-${index}-${"x".repeat(40)}`,
        entry(1),
      ]),
    );
    const summary = summarizeBudgetChanges({ base: {}, recorded });
    expect(summary.length).toBeLessThan(65_536);
    expect(summary).toMatch(/- \d+ more routes changed; see the file diff\./u);
    expect(summary).toEndWith("resolve this thread to accept them.");
  });

  test("prints the summary from the command line", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "network-baseline-"));
    const basePath = path.join(directory, "base.json");
    const recordedPath = path.join(directory, "recorded.json");
    try {
      writeFileSync(basePath, JSON.stringify({ "/": entry(1) }));
      writeFileSync(recordedPath, JSON.stringify({ "/": entry(2) }));
      const result = Bun.spawnSync([
        "bun",
        "scripts/network-baseline-scope.ts",
        "summary",
        "--base",
        basePath,
        "--recorded",
        recordedPath,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("- `/`: depth 1 → 2");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// The recorder runs pull request code and the deliver workflow holds write
// tokens; these assertions fail the edit that would move either boundary.
type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  permissions?: unknown;
  outputs?: Record<string, string>;
  steps: readonly {
    id?: string;
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
  }[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isWorkflowJobs = (value: unknown): value is Record<string, WorkflowJob> =>
  isRecord(value) &&
  Object.values(value).every(
    (job) => isRecord(job) && Array.isArray(job["steps"]),
  );

const workflowSource = (file: string): string =>
  readFileSync(
    path.join(import.meta.dirname, "..", ".github", "workflows", file),
    "utf-8",
  );

const readWorkflowJobs = (file: string): Record<string, WorkflowJob> => {
  const parsed: unknown = Bun.YAML.parse(workflowSource(file));
  const jobs = isRecord(parsed) ? parsed["jobs"] : undefined;
  return isWorkflowJobs(jobs)
    ? jobs
    : expect.unreachable(`${file} has no jobs`);
};

describe("network baseline workflows", () => {
  test("the recorder passes no secrets and keeps read-only credentials", () => {
    const source = workflowSource("network-baseline-record.yml");
    expect(source).not.toMatch(/\bsecrets\.\w/u);
    expect(source).not.toMatch(/\bsecrets:\s*inherit\b/u);
    for (const [name, job] of Object.entries(
      readWorkflowJobs("network-baseline-record.yml"),
    )) {
      const levels = isRecord(job.permissions)
        ? Object.values(job.permissions)
        : [];
      expect(levels.length, name).toBeGreaterThan(0);
      expect(
        levels.every((level) => level === "read"),
        name,
      ).toBe(true);
      for (const step of job.steps) {
        if (step.uses?.startsWith("actions/checkout@")) {
          expect(step.with?.["persist-credentials"], name).toBe(false);
        }
      }
    }
  });

  test("a delivered commit opens a budget review thread", () => {
    const jobs = readWorkflowJobs("network-baseline-deliver.yml");
    const deliver = jobs["deliver"] ?? expect.unreachable("deliver job");
    const stepIds = deliver.steps.map((step) => step.id);
    const summaryIndex = stepIds.indexOf("summary");
    const tokenIndex = stepIds.indexOf("app-token");
    const commitIndex = stepIds.indexOf("commit");
    expect(summaryIndex).toBeGreaterThan(-1);
    expect(tokenIndex).toBeGreaterThan(summaryIndex);
    expect(commitIndex).toBeGreaterThan(tokenIndex);
    expect(deliver.outputs?.["committed"]).toContain(
      "steps.commit.outputs.operation == 'committed'",
    );
    expect(deliver.outputs?.["commit-sha"]).toContain(
      "steps.commit.outputs.commit-sha",
    );

    const review =
      jobs["request-budget-review"] ?? expect.unreachable("review job");
    expect(review.needs).toBe("deliver");
    expect(review.if).toContain("needs.deliver.outputs.committed == 'true'");
    expect(review.permissions).toEqual({ "pull-requests": "write" });
    const post = review.steps.find((step) =>
      step.run?.includes('"repos/$REPOSITORY/pulls/$PR_NUMBER/comments"'),
    );
    expect(post?.run).toContain('commit_id="$COMMIT_SHA"');
    expect(post?.run).toContain("path=apps/web/e2e/network-baseline.json");
    expect(post?.run).toContain("subject_type=file");
    expect(post?.run).not.toContain("${{");
  });

  test("a recording that never reaches the branch fails on the pull request", () => {
    const jobs = readWorkflowJobs("network-baseline-deliver.yml");
    const deliver = jobs["deliver"] ?? expect.unreachable("deliver job");
    expect(deliver.outputs?.["pr"]).toContain("steps.pr.outputs.pr");
    expect(deliver.outputs?.["head"]).toContain("steps.artifact.outputs.head");
    expect(deliver.outputs?.["push-allowed"]).toContain(
      "steps.pr.outputs.push-allowed",
    );
    const deliverLevels = isRecord(deliver.permissions)
      ? Object.values(deliver.permissions)
      : [];
    expect(deliverLevels.length).toBeGreaterThan(0);
    expect(deliverLevels.every((level) => level === "read")).toBe(true);

    const report = jobs["report-delivery"] ?? expect.unreachable("report job");
    expect(report.needs).toBe("deliver");
    // always(): the report exists for the case where deliver failed.
    expect(report.if).toContain("always()");
    expect(report.if).toContain("needs.deliver.outputs.pr != ''");
    expect(report.permissions).toEqual({
      issues: "write",
      "pull-requests": "write",
      statuses: "write",
    });

    const step = report.steps.find((candidate) =>
      candidate.run?.includes('"repos/$REPOSITORY/statuses/$HEAD_SHA"'),
    );
    // always(): a failed label removal must not hide the report.
    expect(step?.if).toBe(
      "always() && needs.deliver.outputs.push-allowed == 'true'",
    );
    expect(step?.env?.["HEAD_SHA"]).toContain("needs.deliver.outputs.head");
    expect(step?.env?.["DELIVERED"]).toContain(
      "needs.deliver.outputs.committed == 'true'",
    );
    expect(step?.run).toContain("state=failure");
    // The merge-queue remedy is offered only when the commit step failed
    // and the pull request is still queued, never for other failures.
    expect(deliver.outputs?.["commit-outcome"]).toContain(
      "steps.commit.outcome",
    );
    expect(step?.env?.["COMMIT_FAILED"]).toContain(
      "needs.deliver.outputs.commit-outcome == 'failure'",
    );
    const queueHint = step?.run?.indexOf("merge queue, and a queued branch");
    const queueGate = step?.run?.indexOf('if [[ "$queued" == true ]]; then');
    expect(step?.run).toContain('if [[ "$COMMIT_FAILED" == true ]]; then');
    expect(step?.run).toContain("isInMergeQueue");
    expect(queueGate).toBeGreaterThan(-1);
    expect(queueHint).toBeGreaterThan(queueGate ?? Infinity);
    expect(step?.run).toContain(
      '"repos/$REPOSITORY/issues/$PR_NUMBER/comments"',
    );
    expect(step?.run).not.toContain("${{");
  });

  test("every job that removes the recording label may write to pull requests", () => {
    const jobs = readWorkflowJobs("network-baseline-deliver.yml");
    const labelJobs = Object.entries(jobs).filter(([, job]) =>
      job.steps.some((step) => step.run?.includes("labels/baseline%3Arecord")),
    );
    expect(labelJobs.map(([name]) => name).toSorted()).toEqual([
      "remove-label-after-failure",
      "report-delivery",
    ]);
    for (const [name, job] of labelJobs) {
      expect(job.permissions, name).toMatchObject({
        issues: "write",
        "pull-requests": "write",
      });
    }
  });
});
