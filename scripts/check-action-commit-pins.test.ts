import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  changedActionPins,
  verifyActionPins,
} from "./check-action-commit-pins";

const sha = "1e69f48acb82d1966a394da916b4c1698aa569d6";
const tagObjectSha = "43d14bc2b83dec42d39ecae14e916627a18bb661";
const changes = [
  {
    before: `steps:\n  - uses: unchanged/action@${sha}\n`,
    after: `steps:
  - uses: owner/action@${sha}
  - uses: 'OWNER/ACTION/subpath@${sha}' # v1
  - uses: unchanged/action@${sha}
  - uses: ./local/action
  - uses: docker://image@sha256:${sha}
  - run: |
      uses: fake/action@${sha}
# uses: comment/action@${sha}
`,
  },
];
const commit = { sha, tree: { sha: "c".repeat(40) }, parents: [] };

test("changed action pins deduplicate repository objects and exclude unchanged and local uses", () => {
  expect(changedActionPins(changes).unwrap()).toEqual([
    { repository: "owner/action", sha },
  ]);
});

test("changed action pins accept commit objects using one authenticated bounded Git Database request", async () => {
  const calls: string[] = [];
  const result = await verifyActionPins({
    changes,
    token: "fixture-token",
    request: async (url, options) => {
      calls.push(url);
      expect(options.headers).toMatchObject({
        Authorization: "Bearer fixture-token",
      });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.redirect).toBe("error");
      return Response.json(commit);
    },
  });
  expect(result.isOk()).toBe(true);
  expect(calls).toEqual([
    `https://api.github.com/repos/owner/action/git/commits/${sha}`,
  ]);
});

test("an annotated tag SHA is refused without peeling it to a commit", async () => {
  const calls: string[] = [];
  const result = await verifyActionPins({
    changes: [
      {
        before: "",
        after: `steps: [{uses: actions/attest-build-provenance@${tagObjectSha}}]`,
      },
    ],
    token: "fixture-token",
    request: async (url) => {
      calls.push(url);
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  });
  expect(result.isErr()).toBe(true);
  expect(calls).toEqual([
    `https://api.github.com/repos/actions/attest-build-provenance/git/commits/${tagObjectSha}`,
  ]);
});

for (const [name, response] of [
  [
    "annotated tag object",
    Response.json({ sha, object: { type: "commit", sha: "b".repeat(40) } }),
  ],
  [
    "tag SHA refused by commit endpoint",
    Response.json({ message: "Not Found" }, { status: 404 }),
  ],
  ["rate limit", Response.json({}, { status: 403 })],
  ["server failure", Response.json({}, { status: 503 })],
  ["malformed response", new Response("bad json")],
  ["different commit", Response.json({ ...commit, sha: "b".repeat(40) })],
] satisfies [string, Response][]) {
  test(`changed action pins fail closed for ${name}`, async () => {
    const result = await verifyActionPins({
      changes,
      token: "fixture-token",
      request: async () =>
        new Response(await response.text(), { status: response.status }),
    });
    expect(result.isErr()).toBe(true);
  });
}

test("changed action pins fail closed on network failure and missing authentication", async () => {
  const failed = await verifyActionPins({
    changes,
    token: "fixture-token",
    request: async () => {
      throw new TypeError("network failed");
    },
  });
  expect(failed.isErr()).toBe(true);
  const missing = await verifyActionPins({
    changes,
    token: undefined,
    request: async () => {
      throw new TypeError("must not request");
    },
  });
  expect(missing.isErr()).toBe(true);
  expect(
    (await verifyActionPins({ changes: [], token: undefined })).isOk(),
  ).toBe(true);
});

test("changed action pins parse flow mappings, quoted keys and multiline YAML scalars", () => {
  expect(
    changedActionPins([
      {
        before: "",
        after: `jobs:\n  check:\n    steps: [{"uses": "owner/action@${sha}"}]\n  reusable:\n    uses: >-\n      owner/workflows/.github/workflows/test.yml@${sha}\n`,
      },
    ]).unwrap(),
  ).toEqual([
    { repository: "owner/action", sha },
    { repository: "owner/workflows", sha },
  ]);
});

test("changed action pins ignore reordered existing uses and reject changed mutable remote references", async () => {
  expect(
    changedActionPins([
      {
        before: `steps: [{uses: "owner/action@${sha}"}]`,
        after: `steps:\n  - name: moved\n    uses: owner/action@${sha}\n`,
      },
    ]).unwrap(),
  ).toEqual([]);
  const result = await verifyActionPins({
    changes: [{ before: "", after: "steps: [{uses: owner/action@v1}]" }],
    token: "fixture",
  });
  expect(result.isErr()).toBe(true);
});

test("changed action pins inspect canonical check fragments and return typed failures", () => {
  expect(
    changedActionPins([
      { before: "", after: `checks:\n  - uses: owner/action@${sha}\n` },
    ]).unwrap(),
  ).toEqual([{ repository: "owner/action", sha }]);
  expect(
    changedActionPins([
      { before: "", after: "checks: [{uses: owner/action@v1}]" },
    ]).isErr(),
  ).toBe(true);
  expect(changedActionPins([{ before: "", after: "checks: [" }]).isErr()).toBe(
    true,
  );
});

test("changed action pins validate edited renamed workflow files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "action-pin-rename-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    git("init", "-q");
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    const oldFile = path.join(root, ".github/workflows/old.yml");
    const newFile = path.join(root, ".github/workflows/new.yml");
    const prefix =
      "name: fixture\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n";
    writeFileSync(oldFile, `${prefix}      - uses: owner/action@${sha}\n`);
    git("add", "--", ".github/workflows/old.yml");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    const base = git("rev-parse", "HEAD");
    renameSync(oldFile, newFile);
    writeFileSync(newFile, `${prefix}      - uses: owner/action@v1\n`);
    git(
      "add",
      "-A",
      "--",
      ".github/workflows/old.yml",
      ".github/workflows/new.yml",
    );
    expect(git("diff", "--name-status", "--find-renames=1%", base)).toContain(
      "R",
    );
    const checked = Bun.spawnSync(
      ["bun", path.join(import.meta.dir, "check-action-commit-pins.ts"), base],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(checked.exitCode).toBe(1);
    expect(checked.stderr.toString()).toContain(
      "Changed remote action must use a full commit SHA",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
