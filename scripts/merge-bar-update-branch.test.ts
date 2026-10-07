import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseOptions } from "./merge-bar";
import {
  branchUpdateResponse,
  BranchUpdateError,
  createBranchUpdateStore,
  updatePullRequestBranch,
} from "./merge-bar-update-branch";

const HEAD = "a".repeat(40);
const REPO = "stella/stella";
const KEY = `${REPO}#123@${HEAD}`;

const errorMessage = (result: Result<unknown, BranchUpdateError>) =>
  result.match({
    ok: () => {
      throw new BranchUpdateError({ message: "Expected a rejected update" });
    },
    err: (error) => error.message,
  });

const fixture = () => {
  const receipts = new Set<string>();
  const locks = new Set<string>();
  const writes: string[] = [];
  let snapshot = {
    state: "open",
    headSha: HEAD,
    headRepository: REPO,
    baseRepository: REPO,
  };
  let response: ReturnType<typeof branchUpdateResponse> = { type: "accepted" };
  const store = {
    recorded: (key: string) => Result.ok(receipts.has(key)),
    acquire: (key: string) => {
      if (locks.has(key)) {
        return Result.err(
          new BranchUpdateError({ message: "lock already held" }),
        );
      }
      locks.add(key);
      return Result.ok({
        release: () => {
          locks.delete(key);
        },
      });
    },
    record: (key: string) => {
      receipts.add(key);
    },
  };
  const options = {
    repo: REPO,
    pullNumber: 123,
    expectedHeadSha: HEAD,
    dryRun: false,
    readPullRequest: () => snapshot,
    update: (sha: string) => {
      writes.push(sha);
      return response;
    },
    store,
  };
  return {
    receipts,
    locks,
    writes,
    options,
    snapshot: (value: typeof snapshot) => {
      snapshot = value;
    },
    response: (value: typeof response) => {
      response = value;
    },
  };
};

describe("updating a pull request from its base", () => {
  test.each([
    { headRepository: "contributor/stella", baseRepository: REPO },
    { headRepository: "stella/another-repository", baseRepository: REPO },
    { headRepository: REPO, baseRepository: "stella/another-repository" },
  ])("refuses repository mismatches before a write: %j", (repositories) => {
    const f = fixture();
    f.snapshot({ state: "open", headSha: HEAD, ...repositories });
    expect(errorMessage(updatePullRequestBranch(f.options))).toContain(
      "requested repository",
    );
    expect(f.writes).toEqual([]);
    expect(f.receipts.size).toBe(0);
    expect(f.locks.size).toBe(0);
  });

  test.each([
    { state: "closed", headSha: HEAD },
    { state: "open", headSha: "b".repeat(40) },
  ])("refuses a closed PR or moved head before issuing PUT: %j", (current) => {
    const f = fixture();
    f.snapshot({ ...current, headRepository: REPO, baseRepository: REPO });
    expect(errorMessage(updatePullRequestBranch(f.options))).toContain(
      "closed or its head moved",
    );
    expect(f.writes).toEqual([]);
    expect(f.receipts.size).toBe(0);
  });

  test("refuses a deleted head repository", () => {
    const f = fixture();
    const result = updatePullRequestBranch({
      ...f.options,
      readPullRequest: () => ({
        state: "open",
        headSha: HEAD,
        headRepository: null,
        baseRepository: REPO,
      }),
    });
    expect(errorMessage(result)).toContain("requested repository");
    expect(f.writes).toEqual([]);
  });

  test("observes a receipt committed between initial check and lock acquisition", () => {
    const f = fixture();
    let reads = 0;
    const result = updatePullRequestBranch({
      ...f.options,
      store: { ...f.options.store, recorded: () => Result.ok(++reads === 2) },
    });
    expect(result.unwrap().status).toBe("already-updated");
    expect(f.writes).toEqual([]);
    expect(f.locks.size).toBe(0);
  });

  test("pins the write and only records an accepted request, once per head", () => {
    const f = fixture();
    expect(updatePullRequestBranch(f.options).unwrap()).toEqual({
      status: "update-requested",
      key: KEY,
    });
    f.snapshot({
      state: "open",
      headSha: "b".repeat(40),
      headRepository: REPO,
      baseRepository: REPO,
    });
    expect(updatePullRequestBranch(f.options).unwrap().status).toBe(
      "already-updated",
    );
    expect(f.writes).toEqual([HEAD]);
    expect(f.receipts).toEqual(new Set([KEY]));
    expect(f.locks.size).toBe(0);
    expect(
      updatePullRequestBranch({
        ...f.options,
        expectedHeadSha: "b".repeat(40),
      }).unwrap().status,
    ).toBe("update-requested");
    expect(f.writes).toEqual([HEAD, "b".repeat(40)]);
  });

  test("dry run acquires no lock and writes no request or receipt", () => {
    const f = fixture();
    expect(
      updatePullRequestBranch({ ...f.options, dryRun: true }).unwrap(),
    ).toEqual({ status: "dry-run", key: KEY });
    expect(f.writes).toEqual([]);
    expect(f.receipts.size).toBe(0);
    expect(f.locks.size).toBe(0);
  });

  test.each([409, 422])(
    "reports HTTP %i without an accepted receipt",
    (status) => {
      const f = fixture();
      f.response(
        branchUpdateResponse(
          `HTTP/2.0 ${status} Unprocessable Entity\n\n{}`,
          1,
        ),
      );
      expect(errorMessage(updatePullRequestBranch(f.options))).toContain(
        `HTTP ${status}`,
      );
      expect(f.writes).toEqual([HEAD]);
      expect(f.receipts.size).toBe(0);
      expect(f.locks.size).toBe(0);
    },
  );

  test.each(["", "HTTP/2.0 200 OK", "HTTP/2.0 500 Internal Server Error"])(
    "retains a lock for an ambiguous response: %j",
    (output) => {
      const f = fixture();
      f.response(branchUpdateResponse(output, 1));
      expect(errorMessage(updatePullRequestBranch(f.options))).toContain(
        "outcome is unknown",
      );
      expect(f.receipts.size).toBe(0);
      expect(f.locks.has(KEY)).toBe(true);
      expect(errorMessage(updatePullRequestBranch(f.options))).toContain(
        "lock already held",
      );
      expect(f.writes).toEqual([HEAD]);
    },
  );

  test("a lost response or interrupted receipt leaves a restart unable to repeat PUT", () => {
    for (const failure of ["transport", "receipt"] as const) {
      const f = fixture();
      const options = {
        ...f.options,
        update: (sha: string) => {
          f.writes.push(sha);
          if (failure === "transport") {
            throw new BranchUpdateError({ message: "transport interrupted" });
          }
          return { type: "accepted" } as const;
        },
        store: {
          ...f.options.store,
          record: () => {
            throw new BranchUpdateError({ message: "receipt interrupted" });
          },
        },
      };
      expect(errorMessage(updatePullRequestBranch(options))).toContain(
        "interrupted",
      );
      expect(f.locks.has(KEY)).toBe(true);
      expect(f.receipts.size).toBe(0);
      expect(updatePullRequestBranch(f.options).isErr()).toBe(true);
      expect(f.writes).toEqual([HEAD]);
    }
  });

  test("a concurrent update cannot enter the same head's critical section", () => {
    const f = fixture();
    const options = {
      ...f.options,
      update: (sha: string) => {
        expect(errorMessage(updatePullRequestBranch(f.options))).toContain(
          "lock already held",
        );
        f.writes.push(sha);
        return { type: "accepted" } as const;
      },
    };
    expect(updatePullRequestBranch(options).unwrap().status).toBe(
      "update-requested",
    );
    expect(f.writes).toEqual([HEAD]);
  });
});

describe("accepted update storage", () => {
  test("receipts survive a new store instance and locks exclude concurrent instances", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "branch-update-test-"));
    try {
      const root = path.join(directory, "state");
      const first = createBranchUpdateStore(root);
      const second = createBranchUpdateStore(root);
      expect(first.recorded(KEY).unwrap()).toBe(false);
      expect(existsSync(root)).toBe(false);
      const lease = first.acquire(KEY).unwrap();
      expect(errorMessage(second.acquire(KEY))).toContain("per-head lock");
      expect(first.recorded(KEY).unwrap()).toBe(false);
      first.record(KEY);
      lease.release();
      expect(second.recorded(KEY).unwrap()).toBe(true);
      expect(readdirSync(root)).toHaveLength(1);
      const otherKey = `${REPO}#123@${"b".repeat(40)}`;
      expect(second.recorded(otherKey).unwrap()).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an ambiguous outcome lock survives constructing a new store after restart", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "branch-update-test-"));
    try {
      const f = fixture();
      const first = createBranchUpdateStore(directory);
      expect(
        updatePullRequestBranch({
          ...f.options,
          store: first,
          update: () => ({ type: "unknown", message: "lost response" }),
        }).isErr(),
      ).toBe(true);
      const second = createBranchUpdateStore(directory);
      expect(second.recorded(KEY).unwrap()).toBe(false);
      expect(
        errorMessage(updatePullRequestBranch({ ...f.options, store: second })),
      ).toContain("per-head lock");
      expect(f.writes).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a malformed receipt refuses a repeated write", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "branch-update-test-"));
    try {
      const store = createBranchUpdateStore(directory);
      store.record(KEY);
      const receipt = readdirSync(directory).at(0);
      expect(receipt).toBeDefined();
      if (receipt === undefined) {
        throw new BranchUpdateError({ message: "fixture receipt missing" });
      }
      writeFileSync(
        path.join(directory, receipt),
        JSON.stringify({ key: "different" }),
      );
      expect(errorMessage(store.recorded(KEY))).toContain(
        "Invalid branch-update receipt",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("HTTP acceptance contract", () => {
  test("exactly HTTP 202 establishes acceptance across every HTTP status", () => {
    for (let status = 100; status < 600; status += 1) {
      expect(
        branchUpdateResponse(
          `HTTP/2.0 ${status} Status\n\n{}`,
          status < 400 ? 0 : 1,
        ).type === "accepted",
      ).toBe(status === 202);
    }
    expect(branchUpdateResponse("HTTP/1.1 202 Accepted\r\n\r\n", 0).type).toBe(
      "accepted",
    );
    expect(
      branchUpdateResponse('{"message":"Updating pull request branch."}', 0)
        .type,
    ).toBe("unknown");
    expect(branchUpdateResponse("", 0).type).toBe("unknown");
  });
});

describe("branch-update CLI contract", () => {
  test("accepts an explicit repository reference and a pinned head", () => {
    expect(
      parseOptions([
        "--update-branch",
        "stella/stella#123",
        "--expected-head-sha",
        HEAD,
      ]),
    ).toEqual({
      mode: "update-branch",
      pullNumber: 123,
      repo: REPO,
      expectedHeadSha: HEAD,
      jump: false,
      dryRun: false,
    });
    expect(
      parseOptions([
        "--update-branch",
        "123",
        "--repo",
        REPO,
        "--expected-head-sha",
        HEAD,
        "--dry-run",
      ]).dryRun,
    ).toBe(true);
  });

  test.each(
    [
      ["--update-branch", "123"],
      ["--update-branch", "123", "--expected-head-sha", "short"],
      ["--update-branch", "123", "--expected-head-sha", HEAD, "--jump"],
      ["--disarm", "--update-branch", "123", "--expected-head-sha", HEAD],
      [
        "--update-branch",
        "stella/stella#123",
        "--repo",
        "stella/folio",
        "--expected-head-sha",
        HEAD,
      ],
      ["123", "--expected-head-sha", HEAD],
      ["--update-branch", "123", "--expected-head-sha"],
      ["--update-branch", "123", "--expected-head-sha", HEAD.toUpperCase()],
      ["--update-branch", "123", "--expected-head-sha", `${HEAD}a`],
      ["--update-branch", "stella/stella#123#456", "--expected-head-sha", HEAD],
    ].map((args) => ({ args })),
  )("rejects incomplete or conflicting options: %j", ({ args }) => {
    expect(() => parseOptions(args)).toThrow(
      /requires|cannot|Only one|conflicts/u,
    );
  });
});

describe("branch-update CLI against a hermetic gh executable", () => {
  test.each([
    {
      status: 202,
      headRepository: REPO,
      headSha: HEAD,
      exitCode: 0,
      expectedWrites: 1,
      expectedExit: 0,
    },
    {
      status: 422,
      headRepository: REPO,
      headSha: HEAD,
      exitCode: 1,
      expectedWrites: 1,
      expectedExit: 1,
    },
    {
      status: 409,
      headRepository: REPO,
      headSha: HEAD,
      exitCode: 1,
      expectedWrites: 1,
      expectedExit: 1,
    },
    {
      status: 202,
      headRepository: "contributor/stella",
      headSha: HEAD,
      exitCode: 0,
      expectedWrites: 0,
      expectedExit: 1,
    },
    {
      status: 202,
      headRepository: REPO,
      headSha: "b".repeat(40),
      exitCode: 0,
      expectedWrites: 0,
      expectedExit: 1,
    },
    {
      status: 200,
      headRepository: REPO,
      headSha: HEAD,
      exitCode: 0,
      expectedWrites: 1,
      expectedExit: 1,
    },
  ])(
    "pins and records only accepted same-repository requests: %j",
    (scenario) => {
      const directory = mkdtempSync(path.join(tmpdir(), "branch-update-cli-"));
      try {
        const executable = path.join(directory, "gh");
        const callsPath = path.join(directory, "calls.jsonl");
        const stateRoot = path.join(directory, "state");
        writeFileSync(
          executable,
          `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = Bun.argv.slice(2);
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + "\\n");
if (args.includes("PUT")) {
  console.log("HTTP/2.0 " + process.env.FIXTURE_STATUS + " Status\\n\\n{}");
  process.exit(Number(process.env.FIXTURE_EXIT));
}
console.log(process.env.FIXTURE_PR);
`,
        );
        chmodSync(executable, 0o755);
        const command = [
          process.execPath,
          "scripts/merge-bar.ts",
          "--update-branch",
          "stella/stella#123",
          "--expected-head-sha",
          HEAD,
        ];
        const env = {
          ...process.env,
          PATH: directory + path.delimiter + process.env["PATH"],
          NODE_ENV: "test",
          STELLA_LOCAL_DEV: "1",
          STELLA_MERGE_BAR_TEST_SKIP_FRESHNESS: "1",
          STELLA_MERGE_BAR_STATE_DIR: stateRoot,
          FIXTURE_CALLS: callsPath,
          FIXTURE_STATUS: String(scenario.status),
          FIXTURE_EXIT: String(scenario.exitCode),
          FIXTURE_PR: JSON.stringify({
            state: "open",
            head: {
              sha: scenario.headSha,
              repo: { full_name: scenario.headRepository },
            },
            base: { repo: { full_name: REPO } },
          }),
        };
        const first = Bun.spawnSync(command, {
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(first.exitCode, first.stderr.toString()).toBe(
          scenario.expectedExit,
        );
        const calls: string[][] = readFileSync(callsPath, "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const writes = calls.filter((args) => args.includes("PUT"));
        expect(writes).toHaveLength(scenario.expectedWrites);
        for (const args of writes) {
          expect(args).toContain("--include");
          expect(args).toContain("repos/stella/stella/pulls/123/update-branch");
          expect(args).toContain(`expected_head_sha=${HEAD}`);
        }
        if (scenario.status === 202 && scenario.expectedExit === 0) {
          expect(
            createBranchUpdateStore(stateRoot).recorded(KEY).unwrap(),
          ).toBe(true);
          const again = Bun.spawnSync(command, {
            env,
            stdout: "pipe",
            stderr: "pipe",
          });
          expect(again.exitCode, again.stderr.toString()).toBe(0);
          expect(again.stdout.toString()).toContain("already-updated");
          expect(
            readFileSync(callsPath, "utf-8").trim().split("\n"),
          ).toHaveLength(calls.length);
        } else if (existsSync(stateRoot)) {
          expect(
            createBranchUpdateStore(stateRoot).recorded(KEY).unwrap(),
          ).toBe(false);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
