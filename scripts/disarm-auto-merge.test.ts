import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

const workflow = v.parse(
  v.looseObject({
    on: v.record(v.string(), v.object({ types: v.array(v.string()) })),
    permissions: v.record(v.string(), v.string()),
    concurrency: v.optional(v.unknown()),
    jobs: v.object({
      disarm: v.looseObject({
        permissions: v.record(v.string(), v.string()),
        if: v.string(),
        concurrency: v.optional(v.unknown()),
        steps: v.array(
          v.object({
            uses: v.string(),
            with: v.object({ script: v.string() }),
          }),
        ),
      }),
    }),
  }),
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/disarm-auto-merge.yml", import.meta.url),
      "utf-8",
    ),
  ),
);
const source = workflow.jobs.disarm.steps.at(0)?.with.script;
if (!source) {
  throw new Error("Missing auto-merge disarm script");
}
const decisionSource = source.slice(0, source.indexOf("const { owner, repo }"));
const decision = new Script(
  `(() => { ${decisionSource}; return shouldDisarm(input); })()`,
);
const script = new Script(`(async () => { ${source} })()`);
const trusted = { login: "autofix-ci[bot]", id: 114_827_586, type: "Bot" };
const armed = { enabledAt: "2026-10-04T12:00:00Z" };
const pushedAt = "2026-10-04T12:01:00Z";
const senders = [
  { name: "trusted sender", sender: trusted, disarm: false },
  {
    name: "human sender",
    sender: { login: "contributor", id: 12, type: "User" },
    disarm: true,
  },
  {
    name: "different login",
    sender: { ...trusted, login: "other[bot]" },
    disarm: true,
  },
  { name: "different ID", sender: { ...trusted, id: 12 }, disarm: true },
  { name: "string ID", sender: { ...trusted, id: "114827586" }, disarm: true },
  { name: "human type", sender: { ...trusted, type: "User" }, disarm: true },
  {
    name: "missing type",
    sender: { login: trusted.login, id: trusted.id },
    disarm: true,
  },
  {
    name: "missing ID",
    sender: { login: trusted.login, type: trusted.type },
    disarm: true,
  },
  {
    name: "missing login",
    sender: { id: trusted.id, type: trusted.type },
    disarm: true,
  },
  { name: "absent sender", sender: undefined, disarm: true },
  { name: "null sender", sender: null, disarm: true },
];

for (const { name, sender, disarm } of senders) {
  test(`armed auto-merge requires complete trusted identity: ${name}`, () => {
    expect(
      decision.runInNewContext({
        input: { sender, autoMerge: armed, pushedAt },
      }),
    ).toBe(disarm);
    expect(
      decision.runInNewContext({
        input: { sender, autoMerge: null, pushedAt },
      }),
    ).toBe(false);
  });
}

type RunOptions = {
  sender?: unknown;
  current?: typeof armed | null;
  receipt?: { id: string; autoMergeRequest: typeof armed | null };
  failure?: "read" | "disable";
};
const run = async ({
  sender,
  current = armed,
  receipt = { id: "PR_node", autoMergeRequest: null },
  failure,
}: RunOptions = {}) => {
  const calls: { query: string; variables: unknown }[] = [];
  const summaries: string[] = [];
  await script.runInNewContext({
    context: {
      repo: { owner: "owner", repo: "repository" },
      actor: trusted.login,
      triggering_actor: trusted.login,
      payload: {
        sender,
        pull_request: {
          number: 42,
          updated_at: pushedAt,
          user: trusted,
          auto_merge: null,
          head: { sha: "stale" },
        },
      },
    },
    github: {
      graphql: async (query: string, variables: unknown) => {
        calls.push({ query, variables });
        if (query.includes("mutation")) {
          if (failure === "disable") {
            throw new Error("Disable API unavailable");
          }
          return { disablePullRequestAutoMerge: { pullRequest: receipt } };
        }
        if (failure === "read") {
          throw new Error("Read API unavailable");
        }
        return {
          repository: {
            pullRequest: { id: "PR_node", autoMergeRequest: current },
          },
        };
      },
    },
    core: {
      summary: {
        addRaw: (message: string) => {
          summaries.push(message);
          return { write: async () => {} };
        },
      },
    },
  });
  return { calls, summaries };
};

test("human synchronization disarms current state despite an unarmed snapshot and trusted actors", async () => {
  const { calls, summaries } = await run({
    sender: { login: "contributor", id: 12, type: "User" },
  });
  expect(calls).toHaveLength(2);
  expect(calls.at(0)?.variables).toEqual({
    owner: "owner",
    repo: "repository",
    number: 42,
  });
  expect(calls.at(1)?.query).toContain("disablePullRequestAutoMerge");
  expect(calls.at(1)?.variables).toEqual({ id: "PR_node" });
  expect(summaries).toEqual(["PR #42: auto-merge disabled after push."]);
});

test("trusted sender preserves armed auto-merge", async () => {
  const { calls, summaries } = await run({ sender: trusted });
  expect(calls).toHaveLength(1);
  expect(summaries).toEqual(["PR #42: auto-merge kept or already disabled."]);
});

test("already disabled auto-merge requires no mutation", async () => {
  const { calls } = await run({ current: null });
  expect(calls).toHaveLength(1);
});

for (const { enabledAt, disarm } of [
  { enabledAt: "2026-10-04T12:00:59Z", disarm: true },
  { enabledAt: pushedAt, disarm: true },
  { enabledAt: "2026-10-04T12:01:01Z", disarm: false },
]) {
  test(`push ordering preserves only provably newer arms: ${enabledAt}`, async () => {
    const autoMerge = { enabledAt };
    expect(decision.runInNewContext({ input: { autoMerge, pushedAt } })).toBe(
      disarm,
    );
    const { calls } = await run({ current: autoMerge });
    expect(calls).toHaveLength(disarm ? 2 : 1);
  });
}

for (const input of [
  { autoMerge: { enabledAt: "invalid" }, pushedAt },
  { autoMerge: armed, pushedAt: "invalid" },
  { autoMerge: armed },
]) {
  test(`invalid ordering fails visibly: ${JSON.stringify(input)}`, () => {
    expect(() => decision.runInNewContext({ input })).toThrow(
      "Cannot establish auto-merge and push ordering",
    );
  });
}

const jobCondition = new Script(workflow.jobs.disarm.if);
test("invalid arm ordering surfaces through the workflow script", async () => {
  expect(
    String(await rejectionOf(run({ current: { enabledAt: "invalid" } }))),
  ).toContain("Cannot establish auto-merge and push ordering");
});

for (const { headRepository, actor, runs } of [
  { headRepository: "owner/repository", actor: "contributor", runs: true },
  { headRepository: "fork/repository", actor: "contributor", runs: false },
  { headRepository: "owner/repository", actor: "dependabot[bot]", runs: false },
  { headRepository: "fork/repository", actor: "dependabot[bot]", runs: false },
  { headRepository: "owner/repository", actor: trusted.login, runs: true },
]) {
  test(`job token eligibility: ${headRepository}/${actor}`, () => {
    expect(
      jobCondition.runInNewContext({
        github: {
          repository: "owner/repository",
          actor,
          event: {
            pull_request: { head: { repo: { full_name: headRepository } } },
          },
        },
      }),
    ).toBe(runs);
  });
}

for (const receipt of [
  { id: "wrong_node", autoMergeRequest: null },
  { id: "PR_node", autoMergeRequest: armed },
]) {
  test(`disable receipt must confirm identity and state: ${receipt.id}/${receipt.autoMergeRequest === null}`, async () => {
    expect(String(await rejectionOf(run({ receipt })))).toContain(
      "Auto-merge disable receipt did not confirm disarming",
    );
  });
}

for (const failure of ["read", "disable"] as const) {
  test(`surfaces ${failure} API failure`, async () => {
    expect(String(await rejectionOf(run({ failure })))).toContain(
      failure === "read" ? "Read API unavailable" : "Disable API unavailable",
    );
  });
}

test("workflow limits its trigger, token and executable code", () => {
  expect(workflow.on).toEqual({ pull_request: { types: ["synchronize"] } });
  expect(workflow.permissions).toEqual({});
  expect(workflow.jobs.disarm.permissions).toEqual({
    contents: "write",
    "pull-requests": "write",
  });
  expect(
    workflow.jobs.disarm.steps.some(({ uses }) =>
      uses.startsWith("actions/checkout@"),
    ),
  ).toBe(false);
  expect(workflow.concurrency).toEqual({
    group: `\${{ github.workflow }}-\${{ github.run_id }}`,
    "cancel-in-progress": false,
  });
  expect(workflow.jobs.disarm.concurrency).toBeUndefined();
  expect(workflow.jobs.disarm.steps).toHaveLength(1);
  expect(workflow.jobs.disarm.steps.at(0)?.uses).toMatch(
    /^actions\/github-script@[0-9a-f]{40}$/u,
  );
  expect(source).not.toContain("${{");
});
