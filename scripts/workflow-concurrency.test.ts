import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// A superseded pull request run keeps its runners busy until it finishes.
// GitHub has no shared `concurrency` across workflows, so every workflow a
// pull request triggers declares its own, and this is the one rule they share:
// a top-level group keyed per pull request (or ref), cancelling in progress.
// Events that must always finish get a group of their own inside that
// expression rather than an exemption here.

const WORKFLOWS_URL = new URL("../.github/workflows/", import.meta.url);
const PULL_REQUEST_EVENTS = new Set(["pull_request", "pull_request_target"]);
/**
 * Keys that tell one pull request's runs from another's. `github.ref` is
 * `refs/pull/<n>/merge` under pull_request but the base branch under
 * pull_request_target, so that trigger needs the number itself. `head_ref`
 * never counts: two forks can push branches of the same name.
 */
const PULL_REQUEST_NUMBER = [
  /\bgithub\.event\.pull_request\.number\b/u,
  /\bgithub\.event\.number\b/u,
];
/** On an issue_comment trigger, the pull request is the commented issue. */
const COMMENTED_ISSUE_NUMBER = /\bgithub\.event\.issue\.number\b/u;
/** Not `github.ref_name`, which is only the branch name on a push. */
const PULL_REQUEST_MERGE_REF = /\bgithub\.ref\b(?!_)/u;
/** The pull request workflows today. Fewer means the scan broke. */
const MINIMUM_PULL_REQUEST_WORKFLOWS = 10;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const triggers = (on: unknown): string[] => {
  if (typeof on === "string") {
    return [on];
  }
  if (Array.isArray(on)) {
    return on.filter((event): event is string => typeof event === "string");
  }
  return isRecord(on) ? Object.keys(on) : [];
};

const runsOnPullRequests = (workflow: unknown) =>
  isRecord(workflow) &&
  triggers(workflow["on"]).some((event) => PULL_REQUEST_EVENTS.has(event));

/** Why a pull request workflow's runs would not supersede each other. */
const concurrencyProblems = (workflow: unknown): string[] => {
  if (!isRecord(workflow) || !runsOnPullRequests(workflow)) {
    return [];
  }
  const concurrency = workflow["concurrency"];
  if (!isRecord(concurrency)) {
    return [
      "declares no top-level `concurrency` with `group` and `cancel-in-progress`",
    ];
  }
  const events = triggers(workflow["on"]);
  const keys = events.includes("pull_request_target")
    ? [
        ...PULL_REQUEST_NUMBER,
        ...(events.includes("issue_comment") ? [COMMENTED_ISSUE_NUMBER] : []),
      ]
    : [...PULL_REQUEST_NUMBER, PULL_REQUEST_MERGE_REF];
  const group = concurrency["group"];
  return [
    ...(typeof group === "string" && keys.some((key) => key.test(group))
      ? []
      : [
          `concurrency group is not keyed per pull request (${keys.map(({ source }) => source).join(", ")})`,
        ]),
    ...(concurrency["cancel-in-progress"] === true
      ? []
      : ["concurrency does not set `cancel-in-progress: true`"]),
  ];
};

const repositoryWorkflows = async () => {
  const root = fileURLToPath(WORKFLOWS_URL);
  const files = [...new Bun.Glob("*.{yml,yaml}").scanSync({ cwd: root })];
  return Promise.all(
    files.toSorted().map(async (file) => ({
      file,
      workflow: Bun.YAML.parse(
        await Bun.file(new URL(file, WORKFLOWS_URL)).text(),
      ),
    })),
  );
};

describe("pull request workflow concurrency", () => {
  test("every pull request workflow cancels its superseded runs", async () => {
    const workflows = await repositoryWorkflows();
    const pullRequestWorkflows = workflows.filter(({ workflow }) =>
      runsOnPullRequests(workflow),
    );

    expect(pullRequestWorkflows.length).toBeGreaterThanOrEqual(
      MINIMUM_PULL_REQUEST_WORKFLOWS,
    );
    expect(
      pullRequestWorkflows.flatMap(({ file, workflow }) =>
        concurrencyProblems(workflow).map((problem) => `${file}: ${problem}`),
      ),
    ).toEqual([]);
  });

  test("reads every trigger spelling", () => {
    expect(runsOnPullRequests({ on: "pull_request" })).toBe(true);
    expect(runsOnPullRequests({ on: ["push", "pull_request_target"] })).toBe(
      true,
    );
    expect(runsOnPullRequests({ on: { pull_request: null } })).toBe(true);
    expect(runsOnPullRequests({ on: { push: null, schedule: [] } })).toBe(
      false,
    );
  });

  test("rejects a workflow whose runs would not supersede each other", () => {
    const on = { pull_request: null };
    expect(concurrencyProblems({ on })).toHaveLength(1);
    // The string form never cancels a run in progress.
    expect(
      concurrencyProblems({ on, concurrency: `ci-\${{ github.ref }}` }),
    ).toHaveLength(1);
    // One group for every pull request: each run cancels another's.
    expect(
      concurrencyProblems({
        on,
        concurrency: { group: "guard", "cancel-in-progress": true },
      }),
    ).toEqual([expect.stringContaining("not keyed per pull request")]);
    expect(
      concurrencyProblems({
        on,
        concurrency: {
          group: `\${{ github.workflow }}-\${{ github.ref }}`,
          "cancel-in-progress": false,
        },
      }),
    ).toEqual([expect.stringContaining("cancel-in-progress")]);
  });

  test.each([
    // Two forks can push branches of the same name.
    ["pull_request", `\${{ github.workflow }}-\${{ github.head_ref }}`],
    ["pull_request_target", `\${{ github.workflow }}-\${{ github.head_ref }}`],
    // Only the branch name, shared by every pull request from it.
    ["pull_request", `\${{ github.workflow }}-\${{ github.ref_name }}`],
    // Under pull_request_target the ref is the base branch.
    ["pull_request_target", `\${{ github.workflow }}-\${{ github.ref }}`],
    // The issue number identifies a pull request only on a comment trigger.
    [
      "pull_request_target",
      `\${{ github.workflow }}-\${{ github.event.issue.number }}`,
    ],
  ])("rejects a %s group keyed as %s", (event, group) => {
    expect(
      concurrencyProblems({
        on: { [event]: null },
        concurrency: { group, "cancel-in-progress": true },
      }),
    ).toEqual([expect.stringContaining("not keyed per pull request")]);
  });

  test.each([
    [["pull_request"], `\${{ github.workflow }}-\${{ github.ref }}`],
    [
      ["pull_request"],
      `\${{ github.workflow }}-\${{ github.event.pull_request.number }}`,
    ],
    [
      ["pull_request_target"],
      `\${{ github.workflow }}-\${{ github.event.number }}`,
    ],
    [
      ["pull_request_target", "issue_comment"],
      `\${{ github.workflow }}-\${{ github.event.issue.number }}`,
    ],
  ])("accepts %p grouped as %s", (events, group) => {
    expect(
      concurrencyProblems({
        on: events,
        concurrency: { group, "cancel-in-progress": true },
      }),
    ).toEqual([]);
  });

  test("accepts a per pull request group that cancels in progress", () => {
    expect(
      concurrencyProblems({
        on: { pull_request_target: { types: ["labeled"] } },
        concurrency: {
          group: `\${{ github.workflow }}-\${{ github.event.pull_request.number }}`,
          "cancel-in-progress": true,
        },
      }),
    ).toEqual([]);
  });
});
