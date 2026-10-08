import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// A superseded pull request run keeps its runners busy until it finishes.
// GitHub has no shared `concurrency` across workflows, so every workflow a
// pull request triggers declares its own, and this is the one rule they share:
// a top-level group keyed per pull request, cancelling in progress.
// Main-push workflows supersede by branch; other events follow their owners.

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

const HEAVY_BRANCH_GROUP = `\${{ github.workflow }}-\${{ github.event_name == 'push' && !startsWith(github.event.head_commit.message, 'chore: release v') && github.run_id || github.ref }}`;

const hasMainBranchConcurrency = (workflow: unknown) => {
  if (
    !isRecord(workflow) ||
    !isRecord(workflow["on"]) ||
    !isRecord(workflow["concurrency"])
  ) {
    return false;
  }
  const push = workflow["on"]["push"];
  return (
    isRecord(push) &&
    Array.isArray(push["branches"]) &&
    push["branches"].includes("main") &&
    (workflow["concurrency"]["group"] ===
      `\${{ github.workflow }}-\${{ github.ref }}` ||
      (workflow["name"] === "Main heavy suites" &&
        workflow["concurrency"]["group"] === HEAVY_BRANCH_GROUP))
  );
};

type ConcurrencyProblemsOptions = {
  supersedingEvents?: readonly string[];
  mode?: "supersede" | "preserve-events";
};

/** Why a pull request workflow's runs would not supersede each other. */
const concurrencyProblems = (
  workflow: unknown,
  {
    supersedingEvents = [],
    mode = "supersede",
  }: ConcurrencyProblemsOptions = {},
): string[] => {
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
  // Disarming consumes individual push events. A later trusted autofix must
  // never supersede an earlier invalidation, including a pending run.
  if (mode === "preserve-events") {
    return [
      ...(group === `\${{ github.workflow }}-\${{ github.run_id }}`
        ? []
        : ["event-preserving workflow needs a unique run group"]),
      ...(cancel === false
        ? []
        : ["event-preserving workflow must not cancel runs"]),
    ];
  }
  if (hasMainBranchConcurrency(workflow)) {
    return [
      ...(!events.includes("issue_comment") &&
      events
        .filter((event) => PULL_REQUEST_EVENTS.has(event))
        .every((event) => event === "pull_request")
        ? []
        : [
            "branch concurrency does not identify target or review pull requests, or commented issues",
          ]),
      ...(cancel === true
        ? []
        : ["branch concurrency must cancel superseded analysis runs"]),
    ];
  }
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
      (event) =>
        supersedingEvents.includes(event) ||
        !cancel.includes(`github.event_name == '${event}'`),
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

const TURBO_CACHE_ACTION = "rharkor/caching-for-turbo@";

const turboCacheSites = (workflow: unknown) => {
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    return [];
  }
  return Object.entries(workflow["jobs"]).flatMap(([job, value]) => {
    if (!isRecord(value) || !Array.isArray(value["steps"])) {
      return [];
    }
    return value["steps"].flatMap((step: unknown, index) => {
      if (
        !isRecord(step) ||
        typeof step["uses"] !== "string" ||
        !step["uses"].startsWith(TURBO_CACHE_ACTION)
      ) {
        return [];
      }
      return [
        {
          job,
          index,
          port: isRecord(step["with"])
            ? step["with"]["server-port"]
            : undefined,
        },
      ];
    });
  });
};

const turboCachePortProblems = (workflow: unknown) =>
  turboCacheSites(workflow).filter(({ port }) => port !== "0");

describe("Turbo cache server port isolation", () => {
  test("every workflow cache server requests an available port", async () => {
    const workflows = await repositoryWorkflows();
    const sites = workflows.flatMap(({ workflow }) =>
      turboCacheSites(workflow),
    );
    expect(sites.length).toBeGreaterThan(0);
    expect(
      workflows.flatMap(({ file, workflow }) =>
        turboCachePortProblems(workflow).map(
          ({ job, index }) =>
            `${file}: ${job} step ${index} needs server-port: "0"`,
        ),
      ),
    ).toEqual([]);
  });

  test.each([
    ["missing inputs", "", false],
    ["missing port", "with: {}", false],
    ["fixed port", 'with: {server-port: "41230"}', false],
    ["ephemeral port", 'with: {server-port: "0"}', true],
  ])("detects %s in every job", (_name, inputs, isolated) => {
    const workflow: unknown = Bun.YAML.parse(`
jobs:
  first:
    steps:
      - uses: actions/checkout@fixture
      - uses: rharkor/caching-for-turbo@fixture
        ${inputs}
  second:
    steps:
      - uses: rharkor/caching-for-turbo@fixture
        ${inputs}
`);
    const sites = turboCacheSites(workflow);
    expect(sites.map(({ job, index }) => ({ job, index }))).toEqual([
      { job: "first", index: 1 },
      { job: "second", index: 0 },
    ]);
    expect(turboCachePortProblems(workflow)).toHaveLength(isolated ? 0 : 2);
  });
});

const concurrencyModes: Record<
  string,
  NonNullable<ConcurrencyProblemsOptions["mode"]>
> = {
  "disarm-auto-merge.yml": "preserve-events",
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
        concurrencyProblems(workflow, {
          supersedingEvents:
            file === "ci.yml" ? ["workflow_dispatch", "push"] : [],
          mode: concurrencyModes[file] ?? "supersede",
        }).map((problem) => `${file}: ${problem}`),
      ),
    ).toEqual([]);
  });

  test("event-preserving concurrency rejects shared groups and cancellation", () => {
    const workflow = {
      on: { pull_request: { types: ["synchronize"] } },
      concurrency: {
        group: `\${{ github.workflow }}-\${{ github.run_id }}`,
        "cancel-in-progress": false,
      },
    };
    expect(concurrencyProblems(workflow, { mode: "preserve-events" })).toEqual(
      [],
    );
    expect(concurrencyProblems(workflow)).not.toEqual([]);
    for (const concurrency of [
      {
        ...workflow.concurrency,
        group: `\${{ github.event.pull_request.number }}`,
      },
      { ...workflow.concurrency, "cancel-in-progress": true },
      { ...workflow.concurrency, "cancel-in-progress": `\${{ true }}` },
    ]) {
      expect(
        concurrencyProblems(
          { ...workflow, concurrency },
          { mode: "preserve-events" },
        ),
      ).not.toEqual([]);
    }
  });

  test("protected events cancel only in explicit supersession groups", async () => {
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
        const concurrency = owner["concurrency"];
        const group = concurrency["group"];
        if (owner === workflow && hasMainBranchConcurrency(workflow)) {
          return [];
        }
        // These workflows deliberately supersede builds/deploys or manual
        // CI on one branch. Staging builds supersede only a build of the
        // same commit. Promotion itself still must finish.
        const deliberate =
          (file === "deploy-staging.yml" &&
            [
              `staging-api-build-\${{ needs.resolve.outputs.sha }}`,
              `staging-web-build-\${{ needs.resolve.outputs.sha }}`,
            ].includes(String(group))) ||
          (file === "deploy-landing.yml" &&
            group === `deploy-landing-\${{ github.ref }}`);
        if (deliberate) {
          return [];
        }
        const cancel = concurrency["cancel-in-progress"];
        return cancel === true ||
          (typeof cancel === "string" &&
            protectedEvents.some(
              (event) =>
                !(
                  file === "ci.yml" &&
                  owner === workflow &&
                  event === "workflow_dispatch"
                ) && cancel.includes(`github.event_name == '${event}'`),
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

  test("main analysis supersedes its branch while target events retain pull request identity", () => {
    const workflow = {
      on: { push: { branches: ["main"] }, pull_request: null, schedule: [] },
      concurrency: {
        group: `\${{ github.workflow }}-\${{ github.ref }}`,
        "cancel-in-progress": true,
      },
    };
    expect(concurrencyProblems(workflow)).toEqual([]);
    for (const event of [
      "pull_request_review",
      "pull_request_review_comment",
      "issue_comment",
    ]) {
      expect(
        concurrencyProblems({
          ...workflow,
          on: { ...workflow.on, [event]: null },
        }),
      ).toEqual([expect.stringContaining("does not identify")]);
    }
    expect(
      concurrencyProblems({
        ...workflow,
        on: { ...workflow.on, pull_request_target: null },
      }),
    ).toEqual([expect.stringContaining("target or review")]);
    expect(
      concurrencyProblems({
        ...workflow,
        on: { pull_request: null, schedule: [] },
      }),
    ).not.toEqual([]);
    expect(
      concurrencyProblems({
        ...workflow,
        concurrency: { ...workflow.concurrency, "cancel-in-progress": false },
      }),
    ).toEqual([expect.stringContaining("cancel superseded analysis")]);
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

type ConcurrencyContext = {
  workflow: string;
  event_name: string;
  ref: string;
  run_id: number;
  event: {
    pull_request?: { number: number; head: { sha: string } };
    label?: { name: string };
  };
};
const groupFor = async (file: string, github: ConcurrencyContext) => {
  const workflow: unknown = Bun.YAML.parse(
    await Bun.file(new URL(file, WORKFLOWS_URL)).text(),
  );
  if (!isRecord(workflow) || !isRecord(workflow["concurrency"])) {
    throw new Error("Missing concurrency");
  }
  const group = workflow["concurrency"]["group"];
  if (typeof group !== "string") {
    throw new TypeError("Missing group");
  }
  // These group expressions use the same short-circuit/string operations
  // as JavaScript. Execute the actual file, rather than a copied key.
  return group.replace(/\$\{\{(.*?)\}\}/gu, (_match, expression: string) =>
    String(
      new Script(expression).runInNewContext({
        github,
        inputs: {},
        format: (template: string, ...values: (string | number)[]) =>
          template.replace(/\{(\d+)\}/gu, (_placeholder, index: string) =>
            String(values.at(Number(index)) ?? ""),
          ),
      }),
    ),
  );
};
const recording = {
  workflow: "Record network baseline",
  event_name: "pull_request",
  ref: "refs/pull/12/merge",
  run_id: 1,
  event: {
    pull_request: { number: 12, head: { sha: "head-one" } },
    label: { name: "baseline:record" },
  },
};

test("main recordings serialize without cancelling a committed baseline", async () => {
  const source = await Bun.file(
    new URL("network-baseline-record.yml", WORKFLOWS_URL),
  ).text();
  const parsed: unknown = Bun.YAML.parse(source);
  expect(isRecord(parsed) && parsed["concurrency"]).toMatchObject({
    "cancel-in-progress": false,
  });
  const main = {
    ...recording,
    event_name: "push",
    ref: "refs/heads/main",
    event: {},
  };
  expect(await groupFor("network-baseline-record.yml", main)).toBe(
    await groupFor("network-baseline-record.yml", { ...main, run_id: 2 }),
  );
});

test("unrelated labels cannot supersede baseline recording requests", async () => {
  const file = "network-baseline-request.yml";
  const request = {
    ...recording,
    workflow: "Request network baseline",
    event_name: "pull_request_target",
  };
  const group = await groupFor(file, request);
  expect(group).toBe("Request network baseline-pr-12");
  expect(await groupFor(file, { ...request, run_id: 2 })).toBe(group);
  const unrelated = {
    ...request,
    event: { ...request.event, label: { name: "unrelated" } },
  };
  expect(await groupFor(file, unrelated)).not.toBe(group);
  expect(await groupFor(file, { ...unrelated, run_id: 2 })).not.toBe(
    await groupFor(file, unrelated),
  );
});

test("manual CI replaces the same branch while PRs and merge groups stay isolated", async () => {
  const file = "ci.yml";
  const dispatch = {
    ...recording,
    workflow: "CI Checks",
    event_name: "workflow_dispatch",
    ref: "refs/heads/topic",
    event: {},
  };
  const key = await groupFor(file, dispatch);
  expect(await groupFor(file, { ...dispatch, run_id: 2 })).toBe(key);
  expect(
    await groupFor(file, { ...dispatch, ref: "refs/heads/other" }),
  ).not.toBe(key);
  expect(
    await groupFor(file, {
      ...dispatch,
      event_name: "pull_request",
      event: recording.event,
    }),
  ).not.toBe(key);
  const merge = { ...dispatch, event_name: "merge_group" };
  expect(await groupFor(file, { ...merge, run_id: 2 })).not.toBe(
    await groupFor(file, merge),
  );
});
