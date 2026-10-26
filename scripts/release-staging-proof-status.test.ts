import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { contextFromNested, evaluate } from "./github-expression";

const script = path.join(import.meta.dir, "release-staging-proof-status.sh");
const repository = "stella/stella";
const head = "a".repeat(40);
const groupHead = "b".repeat(40);
const mainBase = "c".repeat(40);
const otherBase = "d".repeat(40);
const runId = 4242;
const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;
const bot = { login: "github-actions[bot]", type: "Bot" };

let directory = "";
let responses = "";

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "release-staging-proof-"));
  responses = path.join(directory, "responses");
  mkdirSync(responses);
  // Serves GET responses from files named after the endpoint and records
  // every POSTed status body; a posted status becomes the commit's newest, as
  // on GitHub.
  writeFileSync(
    path.join(directory, "gh-retry.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
endpoint=""
for argument in "$@"; do
  case "$argument" in repos/*) endpoint="$argument" ;; esac
done
if [[ " $* " == *" --method POST "* ]]; then
  body="$(jq -c .)"
  printf '%s %s\\n' "$endpoint" "$body" >> "$STATUS_LOG"
  listing="$RESPONSES/repos_stella_stella_commits_\${endpoint##*/}_statuses_per_page_100"
  [[ -f "$listing" ]] || printf '[[]]' > "$listing"
  jq -c --argjson status "$body" '.[0] |= [$status + {creator: {login: "github-actions[bot]", type: "Bot"}}] + .' "$listing" > "$listing.next"
  mv "$listing.next" "$listing"
  exit 0
fi
key="\${endpoint//[\\/?&=]/_}"
[[ -f "$RESPONSES/$key" ]] || { echo "unexpected endpoint: $endpoint" >&2; exit 1; }
cat "$RESPONSES/$key"
# A later response for the same endpoint, served from the next read on.
if [[ -f "$RESPONSES/$key.then" ]]; then mv "$RESPONSES/$key.then" "$RESPONSES/$key"; fi
`,
  );
  writeFileSync(path.join(directory, "statuses.log"), "");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const responsePath = (endpoint: string) =>
  path.join(responses, endpoint.replaceAll(/[/?&=]/gu, "_"));

const respond = (endpoint: string, body: unknown) => {
  writeFileSync(responsePath(endpoint), JSON.stringify(body));
};

type PullOverrides = {
  title?: string;
  draft?: boolean;
  state?: string;
  headRepository?: string | null;
  sha?: string;
  number?: number;
};
const pull = ({
  title = "chore: release v1.2.3",
  draft = false,
  state = "open",
  headRepository = repository,
  sha = head,
  number = 7,
}: PullOverrides = {}) => ({
  number,
  title,
  draft,
  state,
  head: {
    sha,
    ref: "release/v1.2.3",
    repo: headRepository === null ? null : { full_name: headRepository },
  },
  base: { ref: "main", repo: { full_name: repository } },
});

const stagingVerified = (
  state: string,
  description: string,
  creator: object = bot,
  targetUrl = runUrl,
) => ({
  context: "staging/verified",
  state,
  description,
  creator,
  target_url: targetUrl,
});

const statuses = (sha: string, entries: readonly object[]) => {
  respond(`repos/${repository}/commits/${sha}/statuses?per_page=100`, [
    entries,
  ]);
};

const runs = (entries: readonly object[]) => {
  respond(
    `repos/${repository}/actions/workflows/deploy-staging.yml/runs?event=workflow_dispatch&branch=main&per_page=100`,
    { workflow_runs: entries },
  );
};

const stagingRun = (status: string, conclusion: string | null = null) => ({
  id: runId,
  html_url: runUrl,
  status,
  conclusion,
  head_branch: "main",
  path: ".github/workflows/deploy-staging.yml",
  display_title: `Staging release proof ${head}`,
  repository: { full_name: repository },
});

// The status body the script POSTs; any other field fails the test.
const postedStatus = v.strictObject({
  state: v.string(),
  context: v.string(),
  description: v.string(),
  target_url: v.optional(v.string()),
});

const run = (args: readonly string[], env: Record<string, string> = {}) => {
  const result = Bun.spawnSync(["bash", script, ...args], {
    env: {
      ...process.env,
      GITHUB_REPOSITORY: repository,
      GITHUB_SERVER_URL: "https://github.com",
      GH_RETRY_SCRIPT: path.join(directory, "gh-retry.sh"),
      RESPONSES: responses,
      STATUS_LOG: path.join(directory, "statuses.log"),
      NO_PROOF_REASON: "",
      ...env,
    },
  });
  const posted = readFileSync(path.join(directory, "statuses.log"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [endpoint = "", ...body] = line.split(" ");
      return {
        sha: endpoint.split("/").at(-1),
        ...v.parse(postedStatus, JSON.parse(body.join(" "))),
      };
    });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    posted,
  };
};

describe("pull request heads", () => {
  test("a non-release pull request passes at once", () => {
    respond(`repos/${repository}/pulls/7`, pull({ title: "feat: thing" }));
    const result = run(["pull-request", "7"]);
    expect(result.exitCode).toBe(0);
    expect(result.posted).toEqual([
      {
        sha: head,
        state: "success",
        context: "release/staging-proof",
        description: "Not a release pull request",
      },
    ]);
  });

  for (const [name, overrides] of [
    ["a draft", { draft: true }],
    ["a fork", { headRepository: "someone/stella" }],
    ["a deleted fork", { headRepository: null }],
  ] as const) {
    test(`${name} release-titled pull request is not a release`, () => {
      respond(`repos/${repository}/pulls/7`, pull(overrides));
      const result = run(["pull-request", "7"]);
      expect(result.exitCode).toBe(0);
      expect(result.posted.map(({ state }) => state)).toEqual(["success"]);
      expect(result.posted[0]?.description).toBe("Not a release pull request");
    });
  }

  test("a closed pull request records nothing", () => {
    respond(`repos/${repository}/pulls/7`, pull({ state: "closed" }));
    const result = run(["pull-request", "7"]);
    expect(result.exitCode).toBe(0);
    expect(result.posted).toEqual([]);
  });

  const recordedResult = {
    context: "release/staging-proof",
    state: "success",
    description: `Staging proof passed; main=${mainBase}`,
    creator: bot,
    target_url: runUrl,
  };

  test("a completed run that recorded no result fails the head with the dispatch", () => {
    // Its last job never ran; the head still shows the run's pending status,
    // and staging/verified is not read as a result.
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, [
      {
        context: "release/staging-proof",
        state: "pending",
        description: `Staging proof running: run ${runId}`,
        creator: bot,
        target_url: runUrl,
      },
      stagingVerified(
        "success",
        `Staging smoke success: run ${runId}; main=${mainBase}`,
      ),
    ]);
    runs([stagingRun("completed", "cancelled")]);
    expect(run(["pull-request", "7"]).posted).toEqual([
      {
        sha: head,
        state: "failure",
        context: "release/staging-proof",
        description: `Proof run ${runId} recorded no result; dispatch deploy-staging.yml release_candidate=true sha=${head}`,
        target_url: runUrl,
      },
    ]);
  });

  test("the release sweep records release heads only", () => {
    respond(`repos/${repository}/pulls?state=open&base=main&per_page=100`, [
      [pull({ title: "feat: one", sha: "e".repeat(40), number: 1 }), pull()],
    ]);
    statuses(head, []);
    runs([]);
    expect(
      run(["open-pull-requests"], { RELEASES_ONLY: "true" }).posted.map(
        ({ sha, state }) => [sha, state],
      ),
    ).toEqual([[head, "failure"]]);
  });

  test("a completed run that recorded success keeps it", () => {
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, [recordedResult]);
    runs([
      { ...stagingRun("completed", "failure"), display_title: "other" },
      stagingRun("completed", "success"),
    ]);
    expect(run(["pull-request", "7"]).posted).toEqual([
      {
        sha: head,
        state: "success",
        context: "release/staging-proof",
        description: `Staging proof passed; main=${mainBase}`,
        target_url: runUrl,
      },
    ]);
  });

  test("a running staging proof keeps the head pending", () => {
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, []);
    runs([stagingRun("in_progress")]);
    const result = run(["pull-request", "7"]);
    expect(result.posted).toEqual([
      {
        sha: head,
        state: "pending",
        context: "release/staging-proof",
        description: `Staging proof running: run ${runId}`,
        target_url: runUrl,
      },
    ]);
  });

  test("a run that completes between the reconciliation's reads ends with finished_run's success", () => {
    // The reconciliation listed the run unfinished; the run then completed and
    // its last job recorded success before the pending write landed.
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, [recordedResult]);
    runs([stagingRun("in_progress")]);
    const result = run(["pull-request", "7"]);
    expect(result.exitCode).toBe(0);
    expect(result.posted.map(({ state }) => state)).toEqual([
      "pending",
      "success",
    ]);
    expect(result.posted.at(-1)).toEqual({
      sha: head,
      state: "success",
      context: "release/staging-proof",
      description: `Staging proof passed; main=${mainBase}`,
      target_url: runUrl,
    });
  });

  for (const state of ["success", "failure", "pending"]) {
    test(`a reconciliation selected before a newer run posts ${state} leaves it last`, () => {
      respond(`repos/${repository}/pulls/7`, pull());
      statuses(head, [recordedResult]);
      runs([stagingRun("completed", "success")]);
      const newerResult = {
        ...recordedResult,
        state,
        target_url: `https://github.com/${repository}/actions/runs/${runId + 1}`,
      };
      const statusEndpoint = `repos/${repository}/commits/${head}/statuses?per_page=100`;
      // A's result is selected once; B posts before reconciliation resumes.
      respond(`${statusEndpoint}.then`, [[newerResult, recordedResult]]);
      const result = run(["pull-request", "7"]);
      expect(result.exitCode).toBe(0);
      expect(result.posted).toEqual([]);
      expect(readFileSync(responsePath(statusEndpoint), "utf-8")).toBe(
        JSON.stringify([[newerResult, recordedResult]]),
      );
    });
  }

  test("a newer run taking ownership prevents an older pending write", () => {
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, []);
    runs([stagingRun("in_progress")]);
    const endpoint = `repos/${repository}/actions/workflows/deploy-staging.yml/runs?event=workflow_dispatch&branch=main&per_page=100`;
    writeFileSync(
      path.join(responses, `${endpoint.replaceAll(/[/?&=]/gu, "_")}.then`),
      JSON.stringify({
        workflow_runs: [
          {
            ...stagingRun("in_progress"),
            id: runId + 1,
            html_url: `https://github.com/${repository}/actions/runs/${runId + 1}`,
          },
        ],
      }),
    );
    const result = run(["pull-request", "7"]);
    expect(result.exitCode).toBe(0);
    expect(result.posted).toEqual([]);
  });

  test("a pending write for a newer run keeps that run pending", () => {
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, [
      {
        context: "release/staging-proof",
        state: "failure",
        description: "Staging proof failed: run 1",
        creator: bot,
        target_url: `https://github.com/${repository}/actions/runs/1`,
      },
    ]);
    runs([stagingRun("in_progress")]);
    expect(run(["pull-request", "7"]).posted.map(({ state }) => state)).toEqual(
      ["pending"],
    );
  });

  test("a head with no proof gets an actionable failure", () => {
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, []);
    runs([]);
    expect(run(["pull-request", "7"]).posted).toEqual([
      {
        sha: head,
        state: "failure",
        context: "release/staging-proof",
        description: `No staging proof for this head; dispatch deploy-staging.yml release_candidate=true sha=${head}`,
      },
    ]);
  });

  test("a head with no proof fails with the reason the dispatcher gives", () => {
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, []);
    runs([]);
    const result = run(["pull-request", "7"], {
      NO_PROOF_REASON: "Main moved past this head",
    });
    expect(result.posted[0]).toMatchObject({
      state: "failure",
      description: "Main moved past this head",
    });
  });

  test("a proof this run just dispatched stays pending until its run is listed", () => {
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, []);
    runs([]);
    const result = run(["pull-request", "7"], { PROOF_DISPATCHED: "true" });
    expect(result.posted).toEqual([
      {
        sha: head,
        state: "pending",
        context: "release/staging-proof",
        description: "Staging proof dispatched; waiting for its run to start",
      },
    ]);
  });

  test("a dispatched run that records success before the pending write ends on success", () => {
    // The listing is empty at first; the run then shows up and its last job
    // records success before the pending write lands.
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, [recordedResult]);
    runs([]);
    writeFileSync(
      path.join(
        responses,
        `repos/${repository}/actions/workflows/deploy-staging.yml/runs?event=workflow_dispatch&branch=main&per_page=100.then`.replaceAll(
          /[/?&=]/gu,
          "_",
        ),
      ),
      JSON.stringify({ workflow_runs: [stagingRun("completed", "success")] }),
    );
    const result = run(["pull-request", "7"], { PROOF_DISPATCHED: "true" });
    expect(result.exitCode).toBe(0);
    expect(result.posted.map(({ state }) => state)).toEqual(["success"]);
    expect(result.posted.at(-1)).toEqual({
      sha: head,
      state: "success",
      context: "release/staging-proof",
      description: `Staging proof passed; main=${mainBase}`,
      target_url: runUrl,
    });
  });

  test("open pull requests are all recorded", () => {
    respond(`repos/${repository}/pulls?state=open&base=main&per_page=100`, [
      [
        pull({ title: "feat: one", sha: "e".repeat(40), number: 1 }),
        pull({ title: "fix: two", sha: "f".repeat(40), number: 2 }),
      ],
    ]);
    const result = run(["open-pull-requests"]);
    expect(result.exitCode).toBe(0);
    expect(result.posted.map(({ sha, state }) => [sha, state])).toEqual([
      ["e".repeat(40), "success"],
      ["f".repeat(40), "success"],
    ]);
  });
});

describe("merge groups", () => {
  const commits = (groupTree: string, headTree: string) => {
    respond(`repos/${repository}/commits/${groupHead}`, {
      commit: { tree: { sha: groupTree } },
    });
    respond(`repos/${repository}/commits/${head}`, {
      commit: { tree: { sha: headTree } },
    });
  };
  const tree = "1".repeat(40);

  const version = (sha: string, value: string) => {
    writeFileSync(
      path.join(
        responses,
        `repos/${repository}/contents/VERSION?ref=${sha}`.replaceAll(
          /[/?&=]/gu,
          "_",
        ),
      ),
      `${value}\n`,
    );
  };

  test("a non-release merge group that lands no release passes", () => {
    respond(`repos/${repository}/pulls/7`, pull({ title: "feat: thing" }));
    version(groupHead, "1.2.2");
    version(mainBase, "1.2.2");
    const result = run(["merge-group", "7", groupHead, mainBase]);
    expect(result.exitCode).toBe(0);
    expect(result.posted).toEqual([
      {
        sha: groupHead,
        state: "success",
        context: "release/staging-proof",
        description: "Not a release pull request",
      },
    ]);
  });

  test("an unproven release queued ahead of an ordinary pull request fails the group", () => {
    // The queue ref names the ordinary entry; the release ahead of it changed
    // VERSION between the resolved base and the group head.
    respond(`repos/${repository}/pulls/8`, pull({ title: "feat: thing" }));
    version(groupHead, "1.2.3");
    version(mainBase, "1.2.2");
    const result = run(["merge-group", "8", groupHead, mainBase]);
    expect(result.exitCode).toBe(0);
    expect(result.posted).toEqual([
      {
        sha: groupHead,
        state: "failure",
        context: "release/staging-proof",
        description:
          "This merge group also lands a release; a release merges alone, so requeue after it lands",
      },
    ]);
  });

  test("an unreadable VERSION fails closed without a status", () => {
    respond(`repos/${repository}/pulls/8`, pull({ title: "feat: thing" }));
    version(groupHead, "1.2.2");
    const result = run(["merge-group", "8", groupHead, mainBase]);
    expect(result.exitCode).not.toBe(0);
    expect(result.posted).toEqual([]);
  });

  test("a release lands only the proven tree on the proven main", () => {
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, [
      stagingVerified(
        "success",
        `Staging smoke success: run ${runId}; main=${mainBase}`,
      ),
    ]);
    commits(tree, tree);
    const result = run(["merge-group", "7", groupHead, mainBase]);
    expect(result.exitCode).toBe(0);
    expect(result.posted).toEqual([
      {
        sha: groupHead,
        state: "success",
        context: "release/staging-proof",
        description: `Lands the proven tree of ${head.slice(0, 12)}; main=${mainBase}`,
        target_url: runUrl,
      },
    ]);
  });

  test("a release whose proof deployed with another main is refused", () => {
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, [
      stagingVerified(
        "success",
        `Staging smoke success: run ${runId}; main=${otherBase}`,
      ),
    ]);
    commits(tree, tree);
    const result = run(["merge-group", "7", groupHead, mainBase]);
    expect(result.posted[0]).toMatchObject({
      sha: groupHead,
      state: "failure",
    });
    expect(result.posted[0]?.description).toStartWith("Main moved");
  });

  test("a release whose merge group tree differs from the proven head is refused", () => {
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, [
      stagingVerified(
        "success",
        `Staging smoke success: run ${runId}; main=${mainBase}`,
      ),
    ]);
    commits(tree, "2".repeat(40));
    expect(
      run(["merge-group", "7", groupHead, mainBase]).posted[0],
    ).toMatchObject({ sha: groupHead, state: "failure" });
  });

  for (const [name, entries] of [
    ["no proof", []],
    ["a failed proof", [stagingVerified("failure", `x; main=${mainBase}`)]],
    ["a pending proof", [stagingVerified("pending", "running")]],
    [
      "a forged proof",
      [
        stagingVerified("success", `x; main=${mainBase}`, {
          login: "someone",
          type: "User",
        }),
      ],
    ],
  ] as const) {
    test(`a release with ${name} is refused`, () => {
      respond(`repos/${repository}/pulls/7`, pull());
      statuses(head, entries);
      commits(tree, tree);
      expect(
        run(["merge-group", "7", groupHead, mainBase]).posted[0],
      ).toMatchObject({ sha: groupHead, state: "failure" });
    });
  }
});

describe("finished staging runs", () => {
  const pulls = (entries: readonly object[]) => {
    respond(`repos/${repository}/commits/${head}/pulls?per_page=100`, [
      entries,
    ]);
  };

  test("a run that verified the release head passes it", () => {
    pulls([pull()]);
    statuses(head, [
      stagingVerified(
        "success",
        `Staging smoke success: run ${runId}; main=${mainBase}`,
      ),
    ]);
    const result = run(["finished-run", head, String(runId)]);
    expect(result.exitCode).toBe(0);
    expect(result.posted).toEqual([
      {
        sha: head,
        state: "success",
        context: "release/staging-proof",
        description: `Staging proof passed; main=${mainBase}`,
        target_url: runUrl,
      },
    ]);
  });

  test("a run that ended without its own staging verification fails the head", () => {
    pulls([pull()]);
    statuses(head, [
      stagingVerified(
        "success",
        `Staging smoke success: run 1; main=${mainBase}`,
        bot,
        `https://github.com/${repository}/actions/runs/1`,
      ),
    ]);
    const result = run(["finished-run", head, String(runId)]);
    expect(result.posted).toEqual([
      {
        sha: head,
        state: "failure",
        context: "release/staging-proof",
        description: `Staging proof failed: run ${runId}`,
        target_url: runUrl,
      },
    ]);
  });

  test("a commit that heads no open release pull request records nothing", () => {
    pulls([pull({ state: "closed" }), pull({ title: "feat: thing" })]);
    const result = run(["finished-run", head, String(runId)]);
    expect(result.exitCode).toBe(0);
    expect(result.posted).toEqual([]);
  });
});

test("malformed arguments are refused before any request", () => {
  for (const args of [
    [],
    ["pull-request", "0"],
    ["pull-request", "7 8"],
    ["merge-group", "7", "B".repeat(40), mainBase],
    ["merge-group", "7", groupHead],
    ["finished-run", head, "run"],
    ["unknown"],
  ]) {
    const result = run(args);
    expect(result.exitCode).toBe(2);
    expect(result.posted).toEqual([]);
  }
});

describe("release-proof.yml records the status on every head that needs it", () => {
  const workflow = v.parse(
    v.object({
      concurrency: v.object({ group: v.string() }),
      jobs: v.object({ dispatch: v.object({ if: v.string() }) }),
    }),
    Bun.YAML.parse(
      readFileSync(
        path.join(import.meta.dir, "../.github/workflows/release-proof.yml"),
        "utf-8",
      ),
    ),
  );
  const contextFor = (event: object) =>
    contextFromNested({
      github: {
        event_name: "pull_request_target",
        ref: "refs/heads/main",
        workflow: "Prove release PR tree",
        run_id: 99,
        event: { pull_request: { number: 7 }, ...event },
      },
    });
  const runsFor = (event: object) =>
    evaluate(workflow.jobs.dispatch.if, contextFor(event));
  // Concurrency is decided before the job condition, for every event.
  const groupFor = (event: object) =>
    workflow.concurrency.group.replaceAll(
      /\$\{\{(.*?)\}\}/gu,
      (_, expression: string) =>
        v.parse(v.string(), evaluate(expression, contextFor(event))),
    );

  test("an ignored edit takes its own concurrency group and cancels nothing", () => {
    const bodyOnly = {
      action: "edited",
      changes: { body: { from: "old" }, title: null, base: null },
    };
    expect(runsFor(bodyOnly)).toBe(false);
    expect(groupFor(bodyOnly)).toBe("Prove release PR tree-run-99");
    expect(groupFor({ action: "synchronize" })).toBe(
      "Prove release PR tree-pr-7",
    );
    expect(
      groupFor({
        action: "edited",
        changes: { title: { from: "feat: x" }, base: null },
      }),
    ).toBe("Prove release PR tree-pr-7");
  });

  test("a pull request retargeted to main is recorded", () => {
    expect(
      runsFor({
        action: "edited",
        changes: {
          title: null,
          base: { ref: { from: "next" }, sha: { from: "e".repeat(40) } },
        },
      }),
    ).toBe(true);
  });

  test("a title edit is recorded", () => {
    expect(
      runsFor({
        action: "edited",
        changes: { title: { from: "feat: x" }, base: null },
      }),
    ).toBe(true);
  });

  test("a body-only edit is not", () => {
    // GitHub reads an absent property as null; the evaluator needs it spelled.
    expect(
      runsFor({
        action: "edited",
        changes: { body: { from: "old" }, title: null, base: null },
      }),
    ).toBe(false);
  });

  test("other pull request events are recorded", () => {
    for (const action of [
      "opened",
      "synchronize",
      "reopened",
      "ready_for_review",
    ]) {
      expect(runsFor({ action })).toBe(true);
    }
  });
});
