import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  jobCachePolicy,
  workflowCacheProblems,
} from "./workflow-cache-policy.ts";

const raw = { uses: "oven-sh/setup-bun@fixture", with: { "no-cache": true } };
const cached = { uses: "stella/.github/actions/setup-bun-cached@fixture" };

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
    const mutated = { steps: [...contract, { ...cached, with: raw.with }] };
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
