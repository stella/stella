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
/** Expressions that tell one pull request's runs from another's. */
const PER_PULL_REQUEST_KEYS = [
  "github.ref",
  "github.head_ref",
  "github.event.pull_request.number",
  "github.event.number",
];
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
  const group = concurrency["group"];
  return [
    ...(typeof group === "string" &&
    PER_PULL_REQUEST_KEYS.some((key) => group.includes(key))
      ? []
      : [
          `concurrency group is not keyed per pull request (${PER_PULL_REQUEST_KEYS.join(", ")})`,
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
