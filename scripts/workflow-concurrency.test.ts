import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// A superseded pull request run keeps its runners busy until it finishes.
// GitHub has no shared `concurrency` across workflows, so every workflow a
// pull request triggers declares its own, and this is the one rule they share:
// a top-level group keyed per pull request, cancelling in progress.
// Other events use a unique group and never cancel a run in progress.

const WORKFLOWS_URL = new URL("../.github/workflows/", import.meta.url);
const PULL_REQUEST_EVENTS = new Set([
  "pull_request",
  "pull_request_target",
  "pull_request_review",
  "pull_request_review_comment",
]);
/**
 * PR numbers survive both regular and target events. `head_ref` never
 * counts: two forks can push branches of the same name.
 */
const PULL_REQUEST_NUMBER = [
  /\bgithub\.event\.pull_request\.number\b/u,
  /\bgithub\.event\.number\b/u,
];
/** On an issue_comment trigger, the pull request is the commented issue. */
const COMMENTED_ISSUE_NUMBER = /\bgithub\.event\.issue\.number\b/u;
/** The pull request workflows today. Fewer means the scan broke. */
const MINIMUM_PULL_REQUEST_WORKFLOWS = 9;

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
  const keys = [
    ...PULL_REQUEST_NUMBER,
    ...(events.includes("issue_comment") ? [COMMENTED_ISSUE_NUMBER] : []),
  ];
  const mixed = events.some((event) => !PULL_REQUEST_EVENTS.has(event));
  const group = concurrency["group"];
  const cancel = concurrency["cancel-in-progress"];
  const protectedEvents = [
    "push",
    "merge_group",
    "release",
    "schedule",
    "workflow_dispatch",
  ];
  const conditionalCancellation =
    typeof cancel === "string" &&
    protectedEvents.every(
      (event) => !cancel.includes(`github.event_name == '${event}'`),
    ) &&
    events
      .filter((event) => PULL_REQUEST_EVENTS.has(event))
      .every((event) => cancel.includes(`github.event_name == '${event}'`));
  return [
    ...(typeof group === "string" && keys.some((key) => key.test(group))
      ? []
      : ["concurrency group is not keyed per pull request"]),
    ...(mixed && (typeof group !== "string" || !group.includes("github.run_id"))
      ? ["non-PR runs need a unique concurrency group"]
      : []),
    ...((mixed ? conditionalCancellation : cancel === true)
      ? []
      : ["concurrency must cancel only superseded PR runs"]),
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

  test("protected events never cancel workflow or job runs", async () => {
    const workflows = await repositoryWorkflows();
    const problems = workflows.flatMap(({ file, workflow }) => {
      if (!isRecord(workflow)) {
        return [];
      }
      const protectedEvents = triggers(workflow["on"]).filter((event) =>
        [
          "push",
          "merge_group",
          "release",
          "schedule",
          "workflow_dispatch",
        ].includes(event),
      );
      if (protectedEvents.length === 0) {
        return [];
      }
      const jobs = isRecord(workflow["jobs"])
        ? Object.values(workflow["jobs"])
        : [];
      return [workflow, ...jobs].flatMap((owner) => {
        if (!isRecord(owner) || !isRecord(owner["concurrency"])) {
          return [];
        }
        const cancel = owner["concurrency"]["cancel-in-progress"];
        return cancel === true ||
          (typeof cancel === "string" &&
            protectedEvents.some((event) =>
              cancel.includes(`github.event_name == '${event}'`),
            ))
          ? [`${file}: protected event can cancel a run`]
          : [];
      });
    });
    expect(problems).toEqual([]);
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
          group: `\${{ github.workflow }}-\${{ github.event.pull_request.number }}`,
          "cancel-in-progress": false,
        },
      }),
    ).toEqual([expect.stringContaining("cancel only")]);
  });

  test.each([
    ["pull_request", `\${{ github.workflow }}-\${{ github.ref }}`],
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
    [
      ["pull_request"],
      `\${{ github.workflow }}-\${{ github.event.pull_request.number }}`,
    ],
    [
      ["pull_request_target"],
      `\${{ github.workflow }}-\${{ github.event.number }}`,
    ],
  ])("accepts %p grouped as %s", (events, group) => {
    expect(
      concurrencyProblems({
        on: events,
        concurrency: { group, "cancel-in-progress": true },
      }),
    ).toEqual([]);
  });

  test("isolates protected events from superseded PR runs", () => {
    for (const event of [
      "push",
      "merge_group",
      "release",
      "schedule",
      "workflow_dispatch",
    ]) {
      const workflow = {
        on: { pull_request: null, [event]: null },
        concurrency: {
          group: `\${{ github.workflow }}-\${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('run-{0}', github.run_id) }}`,
          "cancel-in-progress": `\${{ github.event_name == 'pull_request' }}`,
        },
      };
      expect(concurrencyProblems(workflow)).toEqual([]);
      expect(
        concurrencyProblems({
          ...workflow,
          concurrency: { ...workflow.concurrency, "cancel-in-progress": true },
        }),
      ).toEqual([expect.stringContaining("cancel only")]);
      expect(
        concurrencyProblems({
          ...workflow,
          concurrency: {
            ...workflow.concurrency,
            group: `pr-\${{ github.event.pull_request.number }}`,
          },
        }),
      ).toEqual([expect.stringContaining("unique concurrency group")]);
    }
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
