import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import {
  checkMergeGroupHold,
  dequeueHeldPullRequest,
  HeldPullRequestError,
  HOLD_CONTEXT,
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
      head_ref: `refs/heads/gh-readonly-queue/main/pr-${String(numbers.at(-1))}-${base}`,
    },
    added: { total_commits: commits.length, commits },
  };
};
const headOf = (number: number) => number.toString(16).padStart(40, "c");
const fixture = (numbers: number[], held: number[] = []) => {
  const { group, added } = groupFixture(numbers);
  const calls: string[] = [];
  const labels = new Map(
    numbers.map(
      (number) =>
        [number, held.includes(number) ? [{ name: HOLD_LABEL }] : []] as const,
    ),
  );
  const variables: Record<string, unknown> = { [HOLD_CONTEXT]: "1" };
  return {
    labels,
    variables,
    calls,
    group,
    // A rest parameter keeps an explicit `undefined` distinct from "use the
    // fixture variables", which a default parameter would conflate.
    run: (eventName = "merge_group", ...override: [unknown?]) =>
      checkMergeGroupHold({
        eventName,
        group,
        repository: "stella/stella",
        holdVariables: override.length > 0 ? override[0] : variables,
        readApi: (endpoint) => {
          calls.push(endpoint);
          if (endpoint.includes("/compare/")) {
            return added;
          }
          const number = Number(endpoint.split("/").at(-1));
          expect(numbers).toContain(number);
          return {
            number,
            labels: labels.get(number),
            head: { sha: headOf(number) },
          };
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
  run.run();
  expect(run.calls.filter((call) => call.includes("/pulls/"))).toHaveLength(3);
});

test("a label added after enqueue refuses the group", () => {
  const run = fixture([17, 18, 19]);
  run.labels.set(17, [{ name: HOLD_LABEL }]);
  expect(() => run.run()).toThrow("HOLD_LABEL_PRESENT");
});

test("a hold variable refuses its member without the label", () => {
  for (const value of [
    "pending",
    "held since 2027-01-15T07:00Z",
    `cleared @${"d".repeat(40)} after review`, // a clearance for an earlier head
    `cleared @${headOf(18).toUpperCase()}`, // the grammar is exact lower-case hex
  ]) {
    const run = fixture([17, 18, 19]);
    run.variables["STELLA_PR_HOLD_18"] = value;
    expect(() => run.run()).toThrow(
      `HOLD_VARIABLE_PRESENT: group ${run.group.head_ref} (${run.group.head_sha}): pull requests #18 are held for their current head`,
    );
    expect(run.calls.filter((call) => call.includes("/pulls/"))).toHaveLength(
      3,
    );
  }
});

test("an empty variable or a clearance of the live head passes", () => {
  for (const value of [
    "",
    `cleared @${headOf(18)}`,
    `cleared @${headOf(18)} at 2027-01-15T07:00Z`,
  ]) {
    const run = fixture([17, 18, 19]);
    run.variables["STELLA_PR_HOLD_18"] = value;
    run.variables["UNRELATED"] = "pending";
    run.run();
  }
});

test("a label and a variable are both named", () => {
  const run = fixture([17, 18], [17]);
  run.variables["STELLA_PR_HOLD_18"] = "pending";
  expect(() => run.run()).toThrow(
    "HOLD_LABEL_PRESENT: group " +
      `${run.group.head_ref} (${run.group.head_sha}): pull requests #17 carry ${HOLD_LABEL}; pull requests #18 are held for their current head`,
  );
});

test("missing or malformed variable context fails closed before any read", () => {
  // Without the sentinel an unreadable variable would read as "no hold".
  for (const holdVariables of [
    undefined,
    null,
    "{}",
    ["x"],
    {},
    { [HOLD_CONTEXT]: "" },
    { [HOLD_CONTEXT]: 1 },
    { STELLA_PR_HOLD_17: "" },
  ]) {
    const run = fixture([17]);
    expect(() => run.run("merge_group", holdVariables)).toThrow(
      "HOLD_MISSING_VARIABLE_CONTEXT",
    );
    expect(run.calls).toEqual([]);
  }
  const run = fixture([17]);
  run.variables["STELLA_PR_HOLD_17"] = 1;
  expect(() => run.run()).toThrow("HOLD_INVALID_VARIABLE");
});

test("a member without a readable head fails closed", () => {
  const { group, added } = groupFixture([17]);
  for (const head of [undefined, { sha: "x" }, { sha: "A".repeat(40) }]) {
    expect(() =>
      checkMergeGroupHold({
        eventName: "merge_group",
        group,
        repository: "stella/stella",
        holdVariables: { [HOLD_CONTEXT]: "1" },
        readApi: (endpoint: string) =>
          endpoint.includes("/compare/")
            ? added
            : { number: 17, labels: [], head },
      }),
    ).toThrow("HOLD_INVALID_PULL");
  }
});

test("pull request checks pass without API calls", () => {
  const run = fixture([17], [17]);
  run.run("pull_request");
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
        holdVariables: { [HOLD_CONTEXT]: "1" },
        readApi: (endpoint: string) => {
          if (endpoint.includes(failure)) {
            throw new TypeError("API unavailable");
          }
          if (endpoint.includes("/compare/")) {
            return added;
          }
          const number = Number(endpoint.split("/").at(-1));
          return { number, labels: [], head: { sha: headOf(number) } };
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
        holdVariables: { [HOLD_CONTEXT]: "1" },
        readApi: () => added,
      }),
    ).toThrow("HOLD_UNMAPPABLE_GROUP");
  }
});

const labelFixtures = (names: string[]) => names.map((name) => ({ name }));
const dequeueFixture = () => {
  const pull = {
    number: 17,
    node_id: "PR_fixture_17",
    head: { sha: "b".repeat(40) },
    labels: labelFixtures([HOLD_LABEL]),
  };
  const event = {
    action: "labeled",
    label: { name: HOLD_LABEL },
    pull_request: { number: 17 },
  };
  const calls: { query: string; id: string }[] = [];
  const reads: string[] = [];
  const restored: string[] = [];
  const hold: { value: string; context: string | undefined } = {
    value: "",
    context: "1",
  };
  const responses: { query: unknown; mutation: unknown } = {
    query: {
      data: {
        node: { id: pull.node_id, mergeQueueEntry: { id: "QUEUE_fixture_17" } },
      },
    },
    mutation: {
      data: {
        dequeuePullRequest: { mergeQueueEntry: { id: "QUEUE_fixture_17" } },
      },
    },
  };
  const transport: {
    failure: "none" | "query" | "mutation" | "read" | "restore";
  } = {
    failure: "none",
  };
  return {
    pull,
    event,
    calls,
    reads,
    responses,
    transport,
    restored,
    hold,
    run: () =>
      dequeueHeldPullRequest({
        event,
        repository: "stella/stella",
        holdValue: hold.value,
        holdContext: hold.context,
        addLabel: (endpoint: string) => {
          restored.push(endpoint);
          if (transport.failure === "restore") {
            throw new TypeError("GitHub API unavailable");
          }
          pull.labels = labelFixtures([HOLD_LABEL]);
          return pull.labels;
        },
        readApi: (endpoint: string) => {
          reads.push(endpoint);
          if (transport.failure === "read") {
            throw new TypeError("GitHub API unavailable");
          }
          return pull;
        },
        graphql: ({ query, id }) => {
          calls.push({ query, id });
          const operation = query.startsWith("mutation") ? "mutation" : "query";
          if (transport.failure === operation) {
            throw new TypeError("GitHub API unavailable");
          }
          return responses[operation];
        },
      }),
  };
};

test("applying hold after successful group verification dequeues the held pull request", () => {
  const group = fixture([17, 18, 19]);
  const labels = labelFixtures([]);
  group.labels.set(17, labels);
  group.run();
  labels.push({ name: HOLD_LABEL });
  const target = dequeueFixture();
  target.pull.labels = labels;
  target.run();
  expect(target.reads).toEqual(["repos/stella/stella/pulls/17"]);
  expect(target.calls).toHaveLength(2);
  expect(target.calls.at(0)?.query).toContain("mergeQueueEntry");
  expect(target.calls.at(1)).toEqual({
    query: expect.stringContaining("dequeuePullRequest"),
    id: target.pull.node_id,
  });
});

test("a held pull request outside the queue needs no dequeue mutation", () => {
  const target = dequeueFixture();
  target.responses.query = {
    data: { node: { id: target.pull.node_id, mergeQueueEntry: null } },
  };
  target.run();
  expect(target.calls).toHaveLength(1);
  expect(target.calls.at(0)?.query).toMatch(/^query/u);
});

test("reopening a queued held pull request dequeues it using live labels", () => {
  const target = dequeueFixture();
  target.event.action = "reopened";
  target.run();
  expect(target.calls.at(1)?.query).toContain("dequeuePullRequest");
  expect(target.reads).toEqual(["repos/stella/stella/pulls/17"]);
});

test("an unrelated applied label makes no API calls", () => {
  const target = dequeueFixture();
  target.event.label.name = "documentation";
  target.run();
  expect(target.reads).toEqual([]);
  expect(target.calls).toEqual([]);
});

test("a hold removed before the label handler reads live state needs no mutation", () => {
  const target = dequeueFixture();
  target.pull.labels = [];
  target.run();
  expect(target.reads).toEqual(["repos/stella/stella/pulls/17"]);
  expect(target.calls).toEqual([]);
});

test("queue query and dequeue transport errors fail with a typed PR-specific message", () => {
  for (const operation of ["query", "mutation"] as const) {
    const target = dequeueFixture();
    target.transport.failure = operation;
    expect(target.run).toThrow(HeldPullRequestError);
    expect(target.run).toThrow("HOLD_DEQUEUE_API_ERROR: PR #17");
  }
});

test("malformed and GraphQL error queue responses fail closed", () => {
  for (const response of [
    { errors: [{ message: "Resource not accessible by integration" }] },
    { data: { node: null } },
    { data: { node: { id: "PR_other", mergeQueueEntry: null } } },
    { data: { node: { id: "PR_fixture_17", mergeQueueEntry: {} } } },
  ]) {
    const target = dequeueFixture();
    target.responses.query = response;
    expect(target.run).toThrow("HOLD_INVALID_QUEUE_RESPONSE: PR #17");
    expect(target.calls.every(({ query }) => query.startsWith("query"))).toBe(
      true,
    );
  }
});

test("malformed and GraphQL error dequeue results fail closed", () => {
  for (const response of [
    { errors: [{ message: "Resource not accessible by integration" }] },
    { data: { dequeuePullRequest: null } },
    {
      data: { dequeuePullRequest: { mergeQueueEntry: { id: "QUEUE_other" } } },
    },
  ]) {
    const target = dequeueFixture();
    target.responses.mutation = response;
    expect(target.run).toThrow(HeldPullRequestError);
    expect(target.run).toThrow("HOLD_DEQUEUE_FAILED: PR #17");
  }
});

test("the contributor-signature parser is generated from the shared owner", () => {
  execFileSync("node", ["scripts/sync-merge-group-parser.mjs", "--check"], {
    cwd: new URL("..", import.meta.url),
    maxBuffer: 1024 * 1024,
  });
});

test("the required job runs on PRs and merge groups using only trusted base scripts", () => {
  const workflow = v.parse(
    v.object({
      on: v.object({
        pull_request: v.unknown(),
        pull_request_target: v.object({ types: v.array(v.string()) }),
        merge_group: v.object({ types: v.array(v.string()) }),
      }),
      permissions: v.record(v.string(), v.string()),
      jobs: v.record(
        v.string(),
        v.object({
          name: v.optional(v.string()),
          if: v.optional(v.string()),
          permissions: v.optional(v.record(v.string(), v.string())),
          steps: v.array(
            v.object({
              if: v.optional(v.string()),
              "timeout-minutes": v.optional(v.number()),
              with: v.optional(v.record(v.string(), v.unknown())),
              env: v.optional(v.record(v.string(), v.string())),
              run: v.optional(v.string()),
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
  expect(workflow.on.pull_request_target.types).toEqual([
    "labeled",
    "unlabeled",
    "reopened",
  ]);
  expect(workflow.on.merge_group.types).toEqual(["checks_requested"]);
  expect(workflow.permissions).toEqual({
    contents: "read",
    "pull-requests": "read",
  });
  const job = workflow.jobs["merge-group-hold"];
  expect(job?.name).toBe("merge-group-hold");
  expect(job?.if).toBe("github.event_name != 'pull_request_target'");
  expect(job?.steps.at(0)?.with?.["ref"]).toBe(
    `\${{ github.event.merge_group.base_ref }}`,
  );
  expect(job?.steps.at(1)?.with?.["ref"]).toBe(
    `\${{ github.event.merge_group.head_sha }}`,
  );
  expect(job?.steps.at(2)?.run).toBe(
    'bash "$GITHUB_WORKSPACE/.workflow-tooling/scripts/merge-target-base.sh"',
  );
  expect(job?.steps.at(4)?.env?.["MERGE_GROUP_BASE_SHA"]).toBe(
    `\${{ steps.target-base.outputs.base_sha }}`,
  );
  expect(job?.steps.at(4)?.env?.["HOLD_VARS"]).toBe(`\${{ toJSON(vars) }}`);
  expect(job?.steps.at(3)?.with?.["ref"]).toBe(
    `\${{ steps.target-base.outputs.base_sha }}`,
  );
  expect(job?.steps.at(3)?.with?.["persist-credentials"]).toBe(false);
  expect(job?.steps.at(4)?.["timeout-minutes"]).toBeGreaterThan(0);
  expect(job?.steps.at(4)?.if).toBe("github.event_name == 'merge_group'");
  const dequeue = workflow.jobs["dequeue-held-pull-request"];
  expect(dequeue?.if).toBe(
    "github.event_name == 'pull_request_target' && github.event.pull_request.base.ref == github.event.repository.default_branch",
  );
  expect(dequeue?.permissions).toEqual({
    contents: "read",
    "pull-requests": "write",
  });
  expect(dequeue?.steps.at(0)?.with?.["ref"]).toBe(
    `\${{ github.event.pull_request.base.sha }}`,
  );
  expect(dequeue?.steps.at(0)?.with?.["persist-credentials"]).toBe(false);
  expect(dequeue?.steps.at(0)?.["timeout-minutes"]).toBeGreaterThan(0);
  expect(dequeue?.steps.at(1)?.["timeout-minutes"]).toBeGreaterThan(0);
});

test("removing hold while a variable holds this head restores the label and dequeues", () => {
  for (const value of [
    "pending",
    `cleared @${"c".repeat(40)}`,
    `cleared @${"b".repeat(40)}extra`,
    ` cleared @${"b".repeat(40)}`,
    "cleared @short",
  ]) {
    const target = dequeueFixture();
    target.event.action = "unlabeled";
    target.pull.labels = [];
    target.hold.value = value;
    target.run();
    expect(target.pull.labels).toEqual(labelFixtures([HOLD_LABEL]));
    expect(target.restored).toEqual(["repos/stella/stella/issues/17/labels"]);
    expect(target.calls.at(1)?.query).toContain("dequeuePullRequest");
  }
});

test("a clearance for the live head leaves the label removed", () => {
  for (const suffix of ["", " neutral status", "\nstatus", "\tstatus"]) {
    const target = dequeueFixture();
    target.event.action = "unlabeled";
    target.pull.labels = [];
    target.hold.value = `cleared @${target.pull.head.sha}${suffix}`;
    target.run();
    expect(target.restored).toEqual([]);
    expect(target.calls).toEqual([]);
    expect(target.pull.labels).toEqual([]);
  }
});

test("removing hold without a repository variable needs no API calls", () => {
  const target = dequeueFixture();
  target.event.action = "unlabeled";
  target.pull.labels = [];
  target.run();
  expect(target.reads).toEqual([]);
  expect(target.restored).toEqual([]);
  expect(target.calls).toEqual([]);
});

test("removing hold without the variable context sentinel fails closed", () => {
  for (const context of [undefined, "", "0"]) {
    const target = dequeueFixture();
    target.event.action = "unlabeled";
    target.pull.labels = [];
    target.hold.context = context;
    expect(() => target.run()).toThrow("HOLD_MISSING_VARIABLE_CONTEXT");
    expect(target.reads).toEqual([]);
  }
  // A labeled event needs no variable, so it never depends on the sentinel.
  const labeled = dequeueFixture();
  labeled.hold.context = undefined;
  labeled.run();
  expect(labeled.calls.map(({ query }) => query.split("(")[0])).toEqual([
    "query",
    "mutation",
  ]);
});

test("restoring a hold outside the queue leaves the label restored", () => {
  const target = dequeueFixture();
  target.event.action = "unlabeled";
  target.pull.labels = [];
  target.hold.value = "pending";
  target.responses.query = {
    data: { node: { id: target.pull.node_id, mergeQueueEntry: null } },
  };
  target.run();
  expect(target.pull.labels).toEqual(labelFixtures([HOLD_LABEL]));
  expect(target.calls).toHaveLength(1);
});

test("hold restoration fails loudly on every API failure", () => {
  for (const failure of ["read", "restore", "query", "mutation"] as const) {
    const target = dequeueFixture();
    target.event.action = "unlabeled";
    target.pull.labels = [];
    target.hold.value = "pending";
    target.transport.failure = failure;
    expect(target.run).toThrow("HOLD_DEQUEUE_API_ERROR: PR #17");
  }
});

test("the hold variable travels through env as data on the trusted target job", () => {
  const source = readFileSync(
    new URL("../.github/workflows/merge-group-hold.yml", import.meta.url),
    "utf-8",
  );
  expect(source).toContain(
    `PR_HOLD_VALUE: \${{ vars[format('STELLA_PR_HOLD_{0}', github.event.pull_request.number)] }}`,
  );
  expect(source).toContain(`PR_HOLD_CONTEXT: \${{ vars.${HOLD_CONTEXT} }}`);
  expect(source).not.toMatch(/run:.*vars[.[]/u);
});
