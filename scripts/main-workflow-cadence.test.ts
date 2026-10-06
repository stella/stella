import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

const schema = v.looseObject({
  on: v.record(v.string(), v.unknown()),
  jobs: v.record(
    v.string(),
    v.looseObject({
      if: v.optional(v.string()),
      permissions: v.optional(v.record(v.string(), v.string())),
      steps: v.optional(
        v.array(
          v.looseObject({
            id: v.optional(v.string()),
            name: v.optional(v.string()),
            if: v.optional(v.string()),
            uses: v.optional(v.string()),
            run: v.optional(v.string()),
            with: v.optional(v.record(v.string(), v.unknown())),
          }),
        ),
      ),
    }),
  ),
});
const read = (file: string) =>
  v.parse(
    schema,
    Bun.YAML.parse(
      readFileSync(
        new URL(`../.github/workflows/${file}.yml`, import.meta.url),
        "utf-8",
      ),
    ),
  );
const heavy = read("main-heavy");
const selection = heavy.jobs["validate"]?.steps?.find(
  (step) => step.id === "selection",
);
const selectionScript = v.parse(v.string(), selection?.with?.["script"]);
const currentSha = "a".repeat(40);
type SelectionRunOptions = {
  eventName: string;
  statuses?: unknown[];
  fail?: boolean;
};
const selectionRun = async ({
  eventName,
  statuses = [],
  fail = false,
}: SelectionRunOptions) => {
  const outputs: Record<string, string> = {};
  const queries: unknown[] = [];
  const summary = { addRaw: (_text: string) => summary, write: async () => {} };
  await new Script(`(async () => { ${selectionScript} })()`).runInNewContext({
    context: {
      eventName,
      sha: currentSha,
      repo: { owner: "example", repo: "repository" },
    },
    core: {
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      summary,
    },
    github: {
      rest: {
        repos: {
          listCommitStatusesForRef: async (query: unknown) => {
            queries.push(query);
            if (fail) {
              throw new TypeError("Workflow history unavailable");
            }
            return { data: statuses };
          },
        },
      },
    },
  });
  return { outputs, queries };
};

test("hourly heavy scheduling skips only the last completed tested SHA and always allows release/manual runs", async () => {
  expect(heavy.on["schedule"]).toEqual([{ cron: "17 * * * *" }]);
  for (const [statuses, required] of [
    [[], true],
    [
      [
        {
          context: "other",
          state: "success",
          creator: { login: "github-actions[bot]" },
        },
      ],
      true,
    ],
    [
      [
        {
          context: "main/heavy",
          state: "success",
          creator: { login: "human" },
        },
      ],
      true,
    ],
    [
      [
        {
          context: "main/heavy",
          state: "pending",
          creator: { login: "github-actions[bot]" },
        },
      ],
      true,
    ],
    [
      [
        {
          context: "main/heavy",
          state: "success",
          creator: { login: "github-actions[bot]" },
        },
      ],
      false,
    ],
    [
      [
        {
          context: "main/heavy",
          state: "failure",
          creator: { login: "github-actions[bot]" },
        },
      ],
      false,
    ],
  ] as const) {
    const run = await selectionRun({
      eventName: "schedule",
      statuses: [...statuses],
    });
    expect(run.outputs).toEqual({ run: String(required) });
    expect(run.queries).toEqual([
      { owner: "example", repo: "repository", ref: currentSha, per_page: 100 },
    ]);
  }
  for (const event of ["push", "workflow_dispatch"]) {
    expect(await selectionRun({ eventName: event })).toEqual({
      outputs: { run: "true" },
      queries: [],
    });
  }
  expect(
    String(
      await rejectionOf(selectionRun({ eventName: "schedule", fail: true })),
    ),
  ).toContain("Workflow history unavailable");
  expect(heavy.jobs["validate"]?.permissions).toEqual({
    contents: "read",
    statuses: "read",
  });
});

test("an unchanged scheduled SHA allocates no suite or status runner and fetches no history", () => {
  for (const job of ["suites", "status"]) {
    const condition = v.parse(v.string(), heavy.jobs[job]?.if);
    expect(
      new Script(`Boolean(${condition})`).runInNewContext({
        always: () => true,
        needs: { validate: { result: "success", outputs: { run: "false" } } },
      }),
      job,
    ).toBe(false);
  }
  for (const name of [
    "Validate SHA format",
    "Fetch main history",
    "Verify main ancestry",
  ]) {
    expect(
      heavy.jobs["validate"]?.steps?.find((step) => step.name === name)?.if,
      name,
    ).toBe("steps.selection.outputs.run == 'true'");
  }
});

test("main maintenance triggers avoid duplicate push work and cache warming follows its owner paths", () => {
  expect(Object.keys(read("scorecard").on)).toEqual(["schedule"]);
  expect(read("release-pr").on).toEqual({ push: { branches: ["main"] } });
  const warm = v.parse(
    v.object({ branches: v.array(v.string()), paths: v.array(v.string()) }),
    read("safe-chain-cache").on["push"],
  );
  expect(warm.branches).toEqual(["main"]);
  expect(warm.paths).toEqual([
    ".github/actions/safe-chain/**",
    ".github/workflows/safe-chain-cache.yml",
  ]);
  for (const filename of [
    ".github/actions/safe-chain/action.yml",
    ".github/actions/safe-chain/install.sh",
    ".github/workflows/safe-chain-cache.yml",
  ]) {
    expect(
      warm.paths.some((pattern) => new Bun.Glob(pattern).match(filename)),
      filename,
    ).toBe(true);
  }
  expect(
    warm.paths.some((pattern) =>
      new Bun.Glob(pattern).match("apps/web/src/example.tsx"),
    ),
  ).toBe(false);
});

test("baseline labels dispatch trusted main while recording permissions stay read-only", async () => {
  const recording = read("network-baseline-record");
  const requester = read("network-baseline-request");
  expect(Object.keys(recording.on)).toEqual(["schedule", "workflow_dispatch"]);
  expect(Object.keys(requester.on)).toEqual(["pull_request_target"]);
  expect(requester.on["pull_request_target"]).toEqual({
    branches: ["main"],
    types: ["labeled", "closed"],
  });
  const build = recording.jobs["build"];
  const buildCondition = v.parse(v.string(), build?.if);
  for (const ref of ["refs/heads/main", "refs/pull/42/merge"]) {
    for (const event_name of [
      "schedule",
      "workflow_dispatch",
      "pull_request_target",
      "push",
    ]) {
      for (const label of ["baseline:record", "unrelated"]) {
        const permitted =
          ref === "refs/heads/main" &&
          (event_name === "schedule" || event_name === "workflow_dispatch");
        expect(
          new Script(`Boolean(${buildCondition})`).runInNewContext({
            github: { ref, event_name, event: { label: { name: label } } },
          }),
        ).toBe(permitted);
      }
    }
  }
  expect(Object.keys(recording.jobs)).toEqual(["build", "record"]);
  for (const job of Object.values(recording.jobs)) {
    expect(
      Object.values(job.permissions ?? {}).every((value) => value === "read"),
    ).toBe(true);
    for (const step of job.steps ?? []) {
      if (!step.uses?.startsWith("actions/checkout@")) {
        continue;
      }
      expect(step.with).toMatchObject({
        ref: `\${{ github.sha }}`,
        "persist-credentials": false,
      });
    }
  }
  expect(Object.keys(requester.jobs)).toEqual(["request"]);
  const request = requester.jobs["request"];
  const requestCondition = v.parse(v.string(), request?.if);
  expect(request?.permissions).toEqual({
    actions: "write",
    "pull-requests": "read",
  });
  expect(request?.steps).toHaveLength(1);
  expect(request?.steps?.at(0)?.uses).toBe(
    "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
  );
  expect(request?.steps?.at(0)?.run).toBeUndefined();
  expect(request?.steps?.at(0)?.with?.["retries"]).toBe(0);
  const requestScript = v.parse(
    v.string(),
    request?.steps?.at(0)?.with?.["script"],
  );
  expect(requestScript).not.toMatch(
    /checkout|cache|exec|spawn|require\(|import\(/u,
  );
  const dispatchFor = async ({
    event_name,
    action,
    label,
    merged,
    files = [],
  }: {
    event_name: string;
    action: string;
    label?: string;
    merged?: boolean;
    files?: { filename: string; previous_filename?: string }[];
  }): Promise<unknown[]> => {
    const event = {
      action,
      ...(label === undefined ? {} : { label: { name: label } }),
      pull_request: { number: 7, merged: merged ?? false },
    };
    const enabled = new Script(`Boolean(${requestCondition})`).runInNewContext({
      github: { event_name, event },
    });
    if (!enabled) {
      return [];
    }
    const calls: unknown[] = [];
    const listFiles = async () => files;
    await new Script(`(async () => { ${requestScript} })()`).runInNewContext({
      context: {
        repo: { owner: "example", repo: "repository" },
        payload: {
          ...event,
          pull_request: { ...event.pull_request, head: { ref: "untrusted" } },
        },
      },
      github: {
        paginate: async (method: unknown, query: unknown) => {
          expect(method).toBe(listFiles);
          expect(query).toEqual({
            owner: "example",
            repo: "repository",
            pull_number: 7,
            per_page: 100,
          });
          return files;
        },
        rest: {
          pulls: { listFiles },
          actions: {
            createWorkflowDispatch: async (query: unknown) => {
              calls.push(query);
            },
          },
        },
      },
    });
    return calls;
  };
  const dispatched = [
    {
      owner: "example",
      repo: "repository",
      workflow_id: "network-baseline-record.yml",
      ref: "main",
    },
  ];
  for (const event_name of [
    "pull_request_target",
    "workflow_dispatch",
    "schedule",
  ]) {
    for (const label of ["baseline:record", "unrelated"]) {
      expect(
        await dispatchFor({ event_name, action: "labeled", label }),
      ).toEqual(
        event_name === "pull_request_target" && label === "baseline:record"
          ? dispatched
          : [],
      );
    }
  }
  // A merged PR's exempt route and budget changes need a main recording.
  for (const files of [
    [{ filename: "apps/web/src/routes/_protected.settings/account.tsx" }],
    [{ filename: "apps/web/e2e/specs/route-smoke.spec.ts" }],
    [{ filename: "apps/web/e2e/network-budgets/lists.json" }],
    [
      {
        filename: "apps/web/src/components/moved.tsx",
        previous_filename: "apps/web/src/routes/old.tsx",
      },
    ],
  ]) {
    expect(
      await dispatchFor({
        event_name: "pull_request_target",
        action: "closed",
        merged: true,
        files,
      }),
    ).toEqual(dispatched);
    expect(
      await dispatchFor({
        event_name: "pull_request_target",
        action: "closed",
        merged: false,
        files,
      }),
    ).toEqual([]);
  }
  for (const files of [
    [],
    [{ filename: "apps/web/src/components/button.tsx" }],
    [{ filename: "apps/web/e2e/network-budgets/nested/x.json" }],
    [{ filename: "apps/web/e2e/network-baseline.json" }],
  ]) {
    expect(
      await dispatchFor({
        event_name: "pull_request_target",
        action: "closed",
        merged: true,
        files,
      }),
    ).toEqual([]);
  }
  expect(read("network-baseline-deliver").jobs["deliver"]?.if).toContain(
    '["schedule", "workflow_dispatch"]',
  );
});

test("landing dispatch ends after acceptance, propagates rejection and never waits or retries", () => {
  const deploy = read("deploy-landing").jobs["deploy"];
  const script = v.parse(
    v.string(),
    deploy?.steps?.find((step) => step.name === "Dispatch deploy-landing.yml")
      ?.run,
  );
  expect(script).not.toMatch(
    /gh run (?:watch|list|view)|\bsleep\b|attempt_deploy/u,
  );
  const directory = mkdtempSync(path.join(tmpdir(), "landing-dispatch-"));
  try {
    const executable = path.join(directory, "gh");
    writeFileSync(
      executable,
      '#!/bin/bash\nprintf "%s\\n" "$@" > "$CALLS"\nexit "$DISPATCH_EXIT"\n',
    );
    chmodSync(executable, 0o755);
    for (const exitCode of [0, 7]) {
      const calls = path.join(directory, "calls");
      const summary = path.join(directory, "summary");
      const result = Bun.spawnSync(["bash", "-e", "-c", script], {
        env: {
          ...process.env,
          PATH: `${directory}:${v.parse(v.string(), process.env["PATH"])}`,
          CALLS: calls,
          DISPATCH_EXIT: String(exitCode),
          GITHUB_STEP_SUMMARY: summary,
          PRIVATE_WORKFLOWS_REPO: "example/private",
          SOURCE_REPOSITORY: "example/public",
          SOURCE_REF: "refs/heads/main",
          SOURCE_SHA: currentSha,
          SOURCE_RUN_ID: "42",
          ARTIFACT_NAME: "site",
          ARTIFACT_DIGEST: "digest",
          AWS_ROLE_ARN_DEPLOY: "role",
        },
      });
      expect(result.exitCode).toBe(exitCode);
      expect(readFileSync(calls, "utf-8").split("\n").slice(0, 3)).toEqual([
        "workflow",
        "run",
        "deploy-landing.yml",
      ]);
      expect(readFileSync(calls, "utf-8")).toContain(
        `source_sha=${currentSha}`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
