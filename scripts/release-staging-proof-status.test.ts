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
  // every POSTed status body.
  writeFileSync(
    path.join(directory, "gh-retry.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
endpoint=""
for argument in "$@"; do
  case "$argument" in repos/*) endpoint="$argument" ;; esac
done
if [[ " $* " == *" --method POST "* ]]; then
  printf '%s %s\\n' "$endpoint" "$(jq -c .)" >> "$STATUS_LOG"
  exit 0
fi
key="\${endpoint//[\\/?&=]/_}"
[[ -f "$RESPONSES/$key" ]] || { echo "unexpected endpoint: $endpoint" >&2; exit 1; }
cat "$RESPONSES/$key"
`,
  );
  writeFileSync(path.join(directory, "statuses.log"), "");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const respond = (endpoint: string, body: unknown) => {
  writeFileSync(
    path.join(responses, endpoint.replaceAll(/[/?&=]/gu, "_")),
    JSON.stringify(body),
  );
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

  test("a release head mirrors its passing staging proof and the main it deployed with", () => {
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, [
      stagingVerified(
        "success",
        `Staging smoke success: run ${runId}; main=${mainBase}`,
      ),
      stagingVerified("failure", "an older run"),
    ]);
    const result = run(["pull-request", "7"]);
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

  test("a passing proof without its main binding fails", () => {
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, [stagingVerified("success", "Staging smoke success")]);
    expect(run(["pull-request", "7"]).posted[0]?.state).toBe("failure");
  });

  test("a failed staging proof fails the head", () => {
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, [stagingVerified("failure", "Staging smoke failure")]);
    const result = run(["pull-request", "7"]);
    expect(result.posted[0]?.state).toBe("failure");
    expect(result.posted[0]?.target_url).toBe(runUrl);
  });

  test("a staging/verified status written outside GitHub Actions is ignored", () => {
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, [
      stagingVerified("success", `forged; main=${mainBase}`, {
        login: "someone",
        type: "User",
      }),
    ]);
    runs([]);
    const result = run(["pull-request", "7"]);
    expect(result.posted[0]?.state).toBe("failure");
    expect(result.posted[0]?.description).toStartWith(
      "No staging proof was started",
    );
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

  test("a staging run that ended before verifying fails the head", () => {
    respond(`repos/${repository}/pulls/7`, pull());
    statuses(head, []);
    runs([
      { ...stagingRun("completed", "failure"), display_title: "other" },
      stagingRun("completed", "failure"),
    ]);
    const result = run(["pull-request", "7"]);
    expect(result.posted[0]?.state).toBe("failure");
    expect(result.posted[0]?.description).toBe(
      `Staging proof run ${runId} ended failure before staging verified it`,
    );
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

  test("a non-release merge group passes at once", () => {
    respond(`repos/${repository}/pulls/7`, pull({ title: "feat: thing" }));
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
      jobs: v.object({ dispatch: v.object({ if: v.string() }) }),
    }),
    Bun.YAML.parse(
      readFileSync(
        path.join(import.meta.dir, "../.github/workflows/release-proof.yml"),
        "utf-8",
      ),
    ),
  );
  const runsFor = (event: object) =>
    evaluate(
      workflow.jobs.dispatch.if,
      contextFromNested({
        github: {
          event_name: "pull_request_target",
          ref: "refs/heads/main",
          event,
        },
      }),
    );

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
