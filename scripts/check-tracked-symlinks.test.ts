import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  readTrackedArchiveEntries,
  type TrackedArchiveEntry,
  trackedSymlinkProblems,
} from "./check-tracked-symlinks";

type GitOptions = { root: string; args: string[]; input?: string };

const git = ({ root, args, input }: GitOptions) => {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    input,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
};

const makeIndex = (entries: readonly TrackedArchiveEntry[]) => {
  const root = mkdtempSync(path.join(tmpdir(), "tracked-symlinks-"));
  git({ root, args: ["init", "--quiet"] });
  const contentOids = new Map<string, string>();
  const oidFor = (content: string) => {
    const existing = contentOids.get(content);
    if (existing !== undefined) {
      return existing;
    }
    const oid = git({
      root,
      args: ["hash-object", "-w", "--stdin"],
      input: content,
    });
    contentOids.set(content, oid);
    return oid;
  };
  const ordinaryBlob = oidFor("fixture file contents\n");
  const indexInfo = entries
    .map((entry) => {
      let mode: string;
      let oid: string;
      switch (entry.kind) {
        case "file": {
          mode = "100644";
          oid = ordinaryBlob;
          break;
        }
        case "gitlink": {
          mode = "160000";
          oid = "a".repeat(40);
          break;
        }
        case "symlink": {
          mode = "120000";
          oid = oidFor(entry.target);
          break;
        }
      }
      return `${mode} ${oid} 0\t${entry.path}\0`;
    })
    .join("");
  git({ root, args: ["update-index", "-z", "--index-info"], input: indexInfo });
  return root;
};

const withIndex = async (
  entries: readonly TrackedArchiveEntry[],
  run: (root: string) => Promise<void> | void,
) => {
  const root = makeIndex(entries);
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("the production .opencode alias must resolve inside the tracked archive", async () => {
  await withIndex(
    [
      {
        path: ".opencode/commands",
        kind: "symlink",
        target: "../.claude/commands",
      },
    ],
    async (root) => {
      const entries = await readTrackedArchiveEntries(root);
      expect(trackedSymlinkProblems(entries)).toEqual([
        {
          path: ".opencode/commands",
          target: "../.claude/commands",
          message: "target is missing from the tracked archive",
        },
      ]);
    },
  );
});

test("untracked targets and unstaged symlink content cannot satisfy the staged snapshot", async () => {
  await withIndex(
    [
      { path: "tracked.txt", kind: "file" },
      { path: "alias", kind: "symlink", target: "missing.txt" },
      { path: "valid-alias", kind: "symlink", target: "tracked.txt" },
    ],
    async (root) => {
      writeFileSync(path.join(root, "missing.txt"), "untracked target\n");
      symlinkSync("tracked.txt", path.join(root, "alias"));
      symlinkSync("missing.txt", path.join(root, "valid-alias"));
      const entries = await readTrackedArchiveEntries(root);
      expect(trackedSymlinkProblems(entries)).toEqual([
        {
          path: "alias",
          target: "missing.txt",
          message: "target is missing from the tracked archive",
        },
      ]);
    },
  );
});

test("relative directory aliases and chained links resolve within archive paths", () => {
  const entries: TrackedArchiveEntry[] = [
    { path: "src/file.txt", kind: "file" },
    { path: "src/deep/other.txt", kind: "file" },
    { path: "src/current", kind: "symlink", target: "../src" },
    { path: "alias-dir", kind: "symlink", target: "src" },
    { path: "alias-file", kind: "symlink", target: "alias-dir/file.txt" },
    { path: "chain", kind: "symlink", target: "alias-file" },
    { path: "src/relative", kind: "symlink", target: "deep/../file.txt" },
  ];
  expect(trackedSymlinkProblems(entries)).toEqual([]);
});

test("repeated finite aliases are valid while active recursion cycles are rejected", () => {
  const entries: TrackedArchiveEntry[] = [
    { path: "target", kind: "file" },
    { path: "shared-a", kind: "symlink", target: "target" },
    { path: "shared-b", kind: "symlink", target: "target" },
    { path: "cycle-a", kind: "symlink", target: "cycle-b" },
    { path: "cycle-b", kind: "symlink", target: "cycle-a" },
  ];
  expect(trackedSymlinkProblems(entries)).toEqual([
    {
      path: "cycle-a",
      target: "cycle-b",
      message: "target contains a symlink cycle",
    },
    {
      path: "cycle-b",
      target: "cycle-a",
      message: "target contains a symlink cycle",
    },
  ]);
});

test("a gitlink archives its directory but not its contents", () => {
  expect(
    trackedSymlinkProblems([
      { path: "vendor/submodule", kind: "gitlink" },
      { path: "directory-alias", kind: "symlink", target: "vendor/submodule" },
      { path: "parent-alias", kind: "symlink", target: "vendor/submodule/.." },
      { path: "alias", kind: "symlink", target: "vendor/submodule/file.txt" },
    ]),
  ).toEqual([
    {
      path: "alias",
      target: "vendor/submodule/file.txt",
      message: "target is missing from the tracked archive",
    },
  ]);
});

test("NUL-delimited staged paths preserve whitespace and newlines", async () => {
  const oddPath = "dir/with space\nand newline.txt";
  await withIndex(
    [
      { path: oddPath, kind: "file" },
      { path: "alias", kind: "symlink", target: oddPath },
    ],
    async (root) => {
      const entries = await readTrackedArchiveEntries(root);
      expect(entries.map((entry) => entry.path)).toContain(oddPath);
      expect(trackedSymlinkProblems(entries)).toEqual([]);
    },
  );
});

test("the complete staged inventory is streamed beyond one megabyte", async () => {
  const entries: TrackedArchiveEntry[] = Array.from(
    { length: 20_000 },
    (_, index) => ({
      path: `generated/file-${index.toString().padStart(5, "0")}.txt`,
      kind: "file",
    }),
  );
  await withIndex(entries, async (root) => {
    const actual = await readTrackedArchiveEntries(root);
    expect(actual).toHaveLength(entries.length);
    expect(actual.at(0)?.path).toBe("generated/file-00000.txt");
    expect(actual.at(-1)?.path).toBe("generated/file-19999.txt");
  });
});

test("the CI guard runs after Bun setup under the checkout trust condition", () => {
  const ci = v.parse(
    v.object({ jobs: v.record(v.string(), v.unknown()) }),
    Bun.YAML.parse(
      readFileSync(
        path.resolve(import.meta.dirname, "../.github/workflows/ci.yml"),
        "utf-8",
      ),
    ),
  );
  const planJob = v.parse(
    v.object({ steps: v.array(v.record(v.string(), v.unknown())) }),
    ci.jobs["ci-plan"],
  );
  const checkout = planJob.steps.find((step) => step["name"] === "Checkout");
  const setupBun = planJob.steps.find(
    (step) => step["name"] === "Setup Bun for planning",
  );
  const guard = planJob.steps.find(
    (step) => step["name"] === "Check tracked repository hygiene",
  );
  if (checkout === undefined || setupBun === undefined || guard === undefined) {
    expect.unreachable("Missing tracked symlink CI ownership steps");
  }
  expect(guard["run"]).toBe(
    "bun scripts/check-tracked-symlinks.ts\nbun scripts/check-tracked-cloud-reports.ts\n",
  );
  expect(guard["if"]).toBe(checkout["if"]);
  expect(planJob.steps.indexOf(guard)).toBeGreaterThan(
    planJob.steps.indexOf(setupBun),
  );

  const lefthook = readFileSync(
    path.resolve(import.meta.dirname, "../lefthook.yml"),
    "utf-8",
  );
  expect(lefthook).toContain(
    "tracked-symlinks:\n      # Match the archive's staged tree, never ignored or unstaged targets.\n      run: bun scripts/check-tracked-symlinks.ts",
  );
});

test("unmerged staged index entries fail with the inventory invariant", async () => {
  await withIndex([], async (root) => {
    const oid = git({
      root,
      args: ["hash-object", "-w", "--stdin"],
      input: "conflicting content\n",
    });
    git({
      root,
      args: ["update-index", "-z", "--index-info"],
      input: `100644 ${oid} 1\tconflict.txt\0`,
    });
    expect(await rejectionOf(readTrackedArchiveEntries(root))).toMatchObject({
      name: "TrackedSymlinkInvariantError",
      message:
        "Tracked archive inventory is malformed or has unresolved merge stages",
    });
  });
});
