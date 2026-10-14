import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as v from "valibot";

import {
  MAIN_ONLY_BUN_CACHE_SAVE,
  jobCachePolicy,
  workflowCacheProblems,
} from "./workflow-cache-policy.ts";

const raw = { uses: "oven-sh/setup-bun@fixture", with: { "no-cache": true } };
const cached = {
  uses: "stella/.github/actions/setup-bun-cached@fixture",
  with: { save: MAIN_ONLY_BUN_CACHE_SAVE },
};

test("parallel groups cannot hide cache writers from protected jobs", () => {
  const cache = { uses: "actions/cache@fixture", with: { path: "dist" } };
  const workflow = {
    on: ["workflow_run"],
    jobs: { fixture: { steps: [{ parallel: [{ parallel: [cache] }] }] } },
  };
  expect(workflowCacheProblems(workflow)).toHaveLength(1);
  expect(workflowCacheProblems(workflow).at(0)).toContain("saves a cache");
});

test("raw setup and cache prohibition share the same job classification", () => {
  for (const protection of [
    "default-scope",
    "cold-install",
    "no-cache",
  ] as const) {
    const workflow = {
      on: protection === "default-scope" ? ["workflow_run"] : ["pull_request"],
    };
    const contract =
      protection === "cold-install"
        ? [{ uses: "./.github/actions/safe-chain" }]
        : [];
    const job = { steps: [...contract, raw] };
    expect(jobCachePolicy({ workflow, job })).toBe(protection);
    expect(
      workflowCacheProblems({ ...workflow, jobs: { fixture: job } }),
    ).toEqual([]);
    // Preserve explicit runtime policy when replacing its setup implementation.
    const mutated = {
      steps: [
        ...contract,
        { ...cached, with: { ...raw.with, save: MAIN_ONLY_BUN_CACHE_SAVE } },
      ],
    };
    expect(jobCachePolicy({ workflow, job: mutated })).toBe(protection);
    expect(
      workflowCacheProblems({ ...workflow, jobs: { fixture: mutated } }),
    ).toHaveLength(1);
  }
});

test("ordinary installs reject raw setup and accept the cached owner", () => {
  const workflow = { on: ["pull_request"] };
  const job = { steps: [{ uses: raw.uses }] };
  expect(jobCachePolicy({ workflow, job })).toBe("install-cache");
  expect(
    workflowCacheProblems({ ...workflow, jobs: { fixture: job } }),
  ).toHaveLength(1);
  expect(
    workflowCacheProblems({
      ...workflow,
      jobs: { fixture: { steps: [cached] } },
    }),
  ).toEqual([]);
});

test("raw pinned Bun setup is allowed only alongside the scoped install owner", () => {
  const pinnedRaw = {
    uses: "oven-sh/setup-bun@0123456789abcdef0123456789abcdef01234567",
  };
  const owner = { uses: "./.github/actions/ci-install" };
  const installWorkflow = { on: ["pull_request"] };
  expect(
    workflowCacheProblems({
      ...installWorkflow,
      jobs: { fixture: { steps: [pinnedRaw] } },
    }),
  ).toContain(
    "job 'fixture': raw Bun setup needs the shared install-cache action",
  );
  expect(
    workflowCacheProblems({
      ...installWorkflow,
      jobs: {
        fixture: {
          steps: [pinnedRaw, { uses: "./.github/actions/ci-install/" }],
        },
      },
    }),
  ).not.toEqual([]);
  expect(
    workflowCacheProblems({
      ...installWorkflow,
      jobs: { fixture: { steps: [pinnedRaw, owner] } },
    }),
  ).toEqual([]);
  const forbidden = [
    {
      workflow: { on: ["workflow_run"] },
      steps: [pinnedRaw, owner],
      policy: "default-scope",
    },
    {
      workflow: { on: ["pull_request"] },
      steps: [{ uses: "./.github/actions/safe-chain" }, pinnedRaw, owner],
      policy: "cold-install",
    },
    {
      workflow: { on: ["pull_request"] },
      steps: [{ ...raw, uses: pinnedRaw.uses }, owner],
      policy: "no-cache",
    },
    {
      workflow: { on: ["pull_request"] },
      steps: [pinnedRaw, owner],
      policy: "publish-chain",
      permissions: { contents: "write" },
    },
  ] as const;
  for (const { workflow, steps, policy, ...jobFields } of forbidden) {
    const job = { ...jobFields, steps };
    expect(jobCachePolicy({ workflow, job })).toBe(policy);
    expect(
      workflowCacheProblems({ ...workflow, jobs: { fixture: job } }),
    ).toContain(
      `job 'fixture': scoped install cache is forbidden by ${policy} policy`,
    );
  }
});

test("all committed workflows and composite actions obey the shared cache policy", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = [
    ...new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({ cwd: root }),
  ];
  expect(files.length).toBeGreaterThan(0);
  const problems = files.flatMap((file) => {
    const workflow: unknown = Bun.YAML.parse(
      readFileSync(`${root}/${file}`, "utf-8"),
    );
    return workflowCacheProblems(workflow).map(
      (problem) => `${file}: ${problem}`,
    );
  });
  const actions = [
    ...new Bun.Glob(".github/actions/**/action.{yml,yaml}").scanSync({
      cwd: root,
    }),
  ];
  for (const file of actions) {
    const action: unknown = Bun.YAML.parse(
      readFileSync(`${root}/${file}`, "utf-8"),
    );
    if (typeof action !== "object" || action === null) {
      continue;
    }
    const runs: unknown = Reflect.get(action, "runs");
    if (
      typeof runs !== "object" ||
      runs === null ||
      Reflect.get(runs, "using") !== "composite"
    ) {
      continue;
    }
    const workflow = {
      jobs: { composite: { steps: Reflect.get(runs, "steps") } },
    };
    problems.push(
      ...workflowCacheProblems(workflow).map(
        (problem) => `${file}: ${problem}`,
      ),
    );
  }
  expect(problems).toEqual([]);
});

test("Bun install cache restore remains available but saves require the exact main boundary", () => {
  for (const save of [
    undefined,
    true,
    "true",
    false,
    `\${{ github.event_name == 'push' }}`,
  ]) {
    expect(
      workflowCacheProblems({
        on: ["pull_request"],
        jobs: { fixture: { steps: [{ ...cached, with: { save } }] } },
      }),
    ).toEqual(["job 'fixture': Bun install cache saves must be main-only"]);
  }
  for (const path of [
    "~/.bun",
    "~/.bun/install",
    "~/.bun/install/",
    "~\\.bun\\install",
    "~/.bun/install/cache",
    "~/.bun/install/cache/package/archive",
    "~\\.bun\\install\\cache",
    "other/cache\n~/.bun/install/cache",
  ]) {
    const restore = { uses: "actions/cache/restore@fixture", with: { path } };
    const save = { uses: "actions/cache/save@fixture", with: { path } };
    expect(
      workflowCacheProblems({
        jobs: {
          fixture: {
            steps: [restore, { ...save, if: MAIN_ONLY_BUN_CACHE_SAVE }],
          },
        },
      }),
    ).toEqual([]);
    expect(
      workflowCacheProblems({ jobs: { fixture: { steps: [save] } } }),
    ).toEqual(["job 'fixture': Bun install cache saves must be main-only"]);
    expect(
      workflowCacheProblems({
        jobs: {
          fixture: {
            steps: [
              {
                ...save,
                uses: "actions/cache@fixture",
                if: MAIN_ONLY_BUN_CACHE_SAVE,
              },
            ],
          },
        },
      }),
    ).toEqual(["job 'fixture': split Bun cache restore from main-only save"]);
  }
  for (const path of ["~/.bun/bin", "~/.bun/install/other", "~/.bun-other"]) {
    expect(
      workflowCacheProblems({
        jobs: {
          fixture: {
            steps: [{ uses: "actions/cache@fixture", with: { path } }],
          },
        },
      }),
    ).toEqual([]);
  }
});

test("dropping save from a real Bun caller violates the repository contract", () => {
  const workflow = v.parse(
    v.looseObject({
      jobs: v.record(
        v.string(),
        v.looseObject({
          steps: v.optional(
            v.array(
              v.looseObject({
                uses: v.optional(v.string()),
                with: v.optional(v.record(v.string(), v.unknown())),
              }),
            ),
          ),
        }),
      ),
    }),
    Bun.YAML.parse(
      readFileSync(
        new URL("../.github/workflows/ci.yml", import.meta.url),
        "utf-8",
      ),
    ),
  );
  const caller = Object.entries(workflow.jobs)
    .flatMap(([id, job]) =>
      (job.steps ?? [])
        .filter((candidate) =>
          candidate.uses?.startsWith(
            "stella/.github/actions/setup-bun-cached@",
          ),
        )
        .map((step) => ({ id, step })),
    )
    .at(0);
  if (caller === undefined) {
    expect.unreachable("Missing real Bun cache caller");
  }
  const { step, id } = caller;
  if (!step.with) {
    expect.unreachable("Missing real Bun cache caller");
  }
  expect(workflowCacheProblems(workflow)).toEqual([]);
  delete step.with["save"];
  expect(workflowCacheProblems(workflow)).toContain(
    `job '${id}': Bun install cache saves must be main-only`,
  );
});
