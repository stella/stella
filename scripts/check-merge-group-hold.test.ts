import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import {
  checkMergeGroupHold,
  HOLD_LABEL,
  MergeGroupHoldError,
} from "./check-merge-group-hold.mjs";

const base = "a".repeat(40);
const groupFixture = (numbers: number[]) => {
  let parent = base;
  const commits = numbers.map((number, index) => {
    const sha = String(index + 1).repeat(40);
    const commit = {
      sha,
      parents: [{ sha: parent }],
      commit: { message: `Queue entry (#${number})\n\nBody` },
    };
    parent = sha;
    return commit;
  });
  return {
    group: {
      base_sha: base,
      head_sha: parent,
      head_ref: `refs/heads/gh-readonly-queue/main/pr-${numbers.at(-1)}-${base}`,
    },
    added: { total_commits: commits.length, commits },
  };
};
const fixture = (numbers: number[], held: number[] = []) => {
  const { group, added } = groupFixture(numbers);
  const calls: string[] = [];
  const labels = new Map(
    numbers.map(
      (number) =>
        [number, held.includes(number) ? [{ name: HOLD_LABEL }] : []] as const,
    ),
  );
  return {
    labels,
    calls,
    group,
    run: (eventName = "merge_group") =>
      checkMergeGroupHold({
        eventName,
        group,
        repository: "stella/stella",
        readApi: (endpoint: string) => {
          calls.push(endpoint);
          if (endpoint.includes("/compare/")) {
            return added;
          }
          const number = Number(endpoint.split("/").at(-1));
          expect(numbers).toContain(number);
          return { number, labels: labels.get(number) };
        },
      }),
  };
};

test("a held member refuses the group at every position", () => {
  for (const numbers of [[17], [17, 18, 19]]) {
    for (const number of numbers) {
      const run = fixture(numbers, [number]);
      expect(() => run.run()).toThrow(
        `HOLD_LABEL_PRESENT: group ${run.group.head_ref}`,
      );
      expect(run.calls.filter((call) => call.includes("/pulls/"))).toHaveLength(
        numbers.length,
      );
    }
  }
});

test("a group without held members passes after reading every member live", () => {
  const run = fixture([17, 18, 19]);
  expect(run.run()).toBeUndefined();
  expect(run.calls.filter((call) => call.includes("/pulls/"))).toHaveLength(3);
});

test("a label added after enqueue refuses the group", () => {
  const run = fixture([17, 18, 19]);
  run.labels.set(17, [{ name: HOLD_LABEL }]);
  expect(() => run.run()).toThrow("HOLD_LABEL_PRESENT");
});

test("pull request checks pass without API calls", () => {
  const run = fixture([17], [17]);
  expect(run.run("pull_request")).toBeUndefined();
  expect(run.calls).toEqual([]);
});

test("API errors fail closed with a typed message naming the group", () => {
  const { group, added } = groupFixture([17, 18, 19]);
  for (const failure of ["compare", "pulls/17", "pulls/18", "pulls/19"]) {
    const invoke = () =>
      checkMergeGroupHold({
        eventName: "merge_group",
        group,
        repository: "stella/stella",
        readApi: (endpoint: string) => {
          if (endpoint.includes(failure)) {
            throw new TypeError("API unavailable");
          }
          if (endpoint.includes("/compare/")) {
            return added;
          }
          return { number: Number(endpoint.split("/").at(-1)), labels: [] };
        },
      });
    expect(invoke).toThrow(MergeGroupHoldError);
    expect(invoke).toThrow(`HOLD_API_ERROR: group ${group.head_ref}`);
  }
});

test("unmappable or incomplete groups fail closed", () => {
  for (const mutate of [
    (added: ReturnType<typeof groupFixture>["added"]) => {
      added.total_commits += 1;
    },
    (added: ReturnType<typeof groupFixture>["added"]) => {
      for (const commit of added.commits) {
        commit.commit.message = "unknown";
      }
    },
    (added: ReturnType<typeof groupFixture>["added"]) => {
      for (const commit of added.commits) {
        commit.parents = [];
      }
    },
    (added: ReturnType<typeof groupFixture>["added"]) => {
      added.commits = [];
      added.total_commits = 0;
    },
  ]) {
    const { group, added } = groupFixture([17]);
    mutate(added);
    expect(() =>
      checkMergeGroupHold({
        eventName: "merge_group",
        group,
        repository: "stella/stella",
        readApi: () => added,
      }),
    ).toThrow("CLA_UNEXPECTED_GROUP_COMMIT");
  }
});

test("the contributor-signature parser is generated from the shared owner", () => {
  execFileSync("node", ["scripts/sync-merge-group-parser.mjs", "--check"], {
    cwd: new URL("..", import.meta.url),
  });
});

test("the required job runs on PRs and merge groups using only trusted base scripts", () => {
  const workflow = v.parse(
    v.object({
      on: v.object({
        pull_request: v.unknown(),
        merge_group: v.object({ types: v.array(v.string()) }),
      }),
      permissions: v.record(v.string(), v.string()),
      jobs: v.record(
        v.string(),
        v.object({
          name: v.string(),
          steps: v.array(
            v.object({
              if: v.optional(v.string()),
              "timeout-minutes": v.optional(v.number()),
              with: v.optional(v.record(v.string(), v.unknown())),
            }),
          ),
        }),
      ),
    }),
    Bun.YAML.parse(
      readFileSync(
        new URL("../.github/workflows/merge-group-hold.yml", import.meta.url),
        "utf-8",
      ),
    ),
  );
  expect(workflow.on).toHaveProperty("pull_request");
  expect(workflow.on.merge_group.types).toEqual(["checks_requested"]);
  expect(workflow.permissions).toEqual({
    contents: "read",
    "pull-requests": "read",
  });
  const job = workflow.jobs["merge-group-hold"];
  expect(job?.name).toBe("merge-group-hold");
  expect(job?.steps.at(0)?.with?.["ref"]).toBe(
    `\${{ github.event.merge_group.base_sha }}`,
  );
  expect(job?.steps.at(0)?.with?.["persist-credentials"]).toBe(false);
  expect(job?.steps.at(1)?.["timeout-minutes"]).toBeGreaterThan(0);
  expect(job?.steps.at(1)?.if).toBe("github.event_name == 'merge_group'");
});
