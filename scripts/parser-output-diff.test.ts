import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  compareCheckouts,
  compareParserOutputs,
  firstDifference,
  formatParserOutputReport,
  runWithConcurrency,
} from "./parser-output-diff";

const git = async (cwd: string, args: string[]) => {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, stderr).toBe(0);
};

test("parser workers respect their concurrency bound and preserve result order", async () => {
  let active = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  // Settles once `count` tasks are parked on their release.
  let parkedWaiter: { count: number; resolve: () => void } | undefined;
  const parked = async (count: number) => {
    if (releases.length >= count) {
      return;
    }
    const { promise, resolve } = Promise.withResolvers<undefined>();
    parkedWaiter = { count, resolve: () => resolve(undefined) };
    await promise;
  };
  const tasks = [0, 1, 2, 3].map((value) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => {
      releases.push(resolve);
      if (parkedWaiter !== undefined && releases.length >= parkedWaiter.count) {
        parkedWaiter.resolve();
        parkedWaiter = undefined;
      }
    });
    active -= 1;
    return value;
  });
  const results = runWithConcurrency(tasks, 2);
  await parked(2);
  expect(active).toBe(2);
  releases.shift()?.();
  await parked(2);
  releases.shift()?.();
  await parked(2);
  for (const release of releases.splice(0)) {
    release();
  }
  expect(await results).toEqual([0, 1, 2, 3]);
  expect(peak).toBe(2);
});

test("isolated base and working tree parse the same fixture bytes and report the exact changed field", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "parser-diff-test-"));
  try {
    await git(root, ["init", "--quiet"]);
    await Bun.write(path.join(root, "tsconfig.scripts.json"), "{}");
    await Bun.write(path.join(root, "fixture.txt"), "original fixture");
    await Bun.write(
      path.join(root, "parser.ts"),
      "export const parse = (text: string) => ({ normalized: { text: text.trim() }, warnings: [] });",
    );
    await Bun.write(
      path.join(root, "runner.ts"),
      `
import { parse } from "../parser";
export const collectParserOutputs = async (root: string) => ({
  synthetic: { "fixture.txt": parse(await Bun.file(root + "/fixture.txt").text()) },
});`,
    );
    await git(root, [
      "add",
      "--",
      "tsconfig.scripts.json",
      "fixture.txt",
      "parser.ts",
      "runner.ts",
    ]);
    await git(root, [
      "-c",
      "user.name=Parser test",
      "-c",
      "user.email=parser@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "test: seed synthetic parser",
    ]);
    // Change the head fixture to prove the base receives the head bytes, too.
    await Bun.write(path.join(root, "fixture.txt"), "shared fixture");
    await Bun.write(
      path.join(root, "parser.ts"),
      "/* no-op source change */ export const parse = (text: string) => ({ normalized: { text: text.trim() }, warnings: [] });",
    );
    expect(
      await compareCheckouts({ root, base: "HEAD", runner: "runner.ts" }),
    ).toEqual([{ adapter: "synthetic", status: "identical" }]);
    const runnerPath = path.join(root, "runner.ts");
    const originalRunner = await Bun.file(runnerPath).text();
    const changedHarness =
      'throw new Error("Harness changed during comparison");';
    await Bun.write(
      runnerPath,
      `
import { parse } from "../parser";
export const collectParserOutputs = async (root: string) => {
  await Bun.write(${JSON.stringify(runnerPath)}, ${JSON.stringify(changedHarness)});
  return { synthetic: { "fixture.txt": parse(await Bun.file(root + "/fixture.txt").text()) } };
};`,
    );
    expect(
      await compareCheckouts({ root, base: "HEAD", runner: "runner.ts" }),
    ).toEqual([{ adapter: "synthetic", status: "identical" }]);
    expect(await Bun.file(runnerPath).text()).toBe(changedHarness);
    await Bun.write(runnerPath, originalRunner);
    await Bun.write(
      path.join(root, "parser.ts"),
      "export const parse = (text: string) => ({ normalized: { text: text.trim().toUpperCase() }, warnings: [] });",
    );
    expect(
      await compareCheckouts({ root, base: "HEAD", runner: "runner.ts" }),
    ).toEqual([
      {
        adapter: "synthetic",
        status: "different",
        fixture: "fixture.txt",
        field: "$.normalized.text",
        base: "shared fixture",
        head: "SHARED FIXTURE",
      },
    ]);
    await Bun.write(
      path.join(root, "parser.ts"),
      "export const parse = () => ({ text: Date.now() });",
    );
    expect(
      await rejectionOf(
        compareCheckouts({ root, base: "HEAD", runner: "runner.ts" }),
      ),
    ).toMatchObject({ message: expect.stringContaining("Clock forbidden") });
    await Bun.write(
      path.join(root, "parser.ts"),
      'export const parse = () => fetch("https://example.invalid");',
    );
    expect(
      await rejectionOf(
        compareCheckouts({ root, base: "HEAD", runner: "runner.ts" }),
      ),
    ).toMatchObject({ message: expect.stringContaining("Network forbidden") });
    const list = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
      cwd: root,
      stdout: "pipe",
    });
    expect(
      (await new Response(list.stdout).text()).match(/^worktree /gmu),
    ).toHaveLength(1);
    expect(await list.exited).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compares all fields, missing keys, ordered arrays and warnings deterministically", () => {
  expect(
    firstDifference({
      base: { z: 1, a: ["judge"] },
      head: { a: ["judge"], z: 1 },
    }),
  ).toBeUndefined();
  expect(
    firstDifference({
      base: { warnings: [] },
      head: { warnings: ["missing date"] },
    }),
  ).toEqual({ field: "$.warnings.length", base: 0, head: 1 });
  expect(
    firstDifference({
      base: { judgeKeys: ["one", "two"] },
      head: { judgeKeys: ["one", "three"] },
    }),
  ).toEqual({ field: "$.judgeKeys[1]", base: "two", head: "three" });
  expect(firstDifference({ base: {}, head: { slug: undefined } })?.field).toBe(
    "$.slug",
  );
  expect(
    firstDifference({ base: { "a.b": 1 }, head: { "a.b": 2 } })?.field,
  ).toBe('$["a.b"]');
  expect(() =>
    compareParserOutputs({ base: { adapter: {} }, head: { adapter: {} } }),
  ).toThrow("Missing fixture coverage");
});

test("JSONL reports distinguish exceptional scalar values without dropping fields", () => {
  expect(
    JSON.parse(
      formatParserOutputReport({
        values: [
          undefined,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
          -0,
          1n,
          null,
          0,
        ],
        slug: undefined,
      }),
    ),
  ).toEqual({
    values: [
      { type: "undefined" },
      { type: "number", value: "NaN" },
      { type: "number", value: "Infinity" },
      { type: "number", value: "-Infinity" },
      { type: "number", value: "-0" },
      { type: "bigint", value: "1" },
      null,
      0,
    ],
    slug: { type: "undefined" },
  });
});

test.each([
  {
    name: "undefined object properties",
    before: "{}",
    after: "{ slug: undefined }",
    field: "$.slug",
    base: undefined,
    head: undefined,
  },
  {
    name: "undefined array entries",
    before: "{ value: [undefined] }",
    after: "{ value: [null] }",
    field: "$.value[0]",
    base: undefined,
    head: null,
  },
  {
    name: "NaN",
    before: "{ value: NaN }",
    after: "{ value: null }",
    field: "$.value",
    base: Number.NaN,
    head: null,
  },
  {
    name: "positive infinity",
    before: "{ value: Infinity }",
    after: "{ value: null }",
    field: "$.value",
    base: Number.POSITIVE_INFINITY,
    head: null,
  },
  {
    name: "negative infinity",
    before: "{ value: -Infinity }",
    after: "{ value: null }",
    field: "$.value",
    base: Number.NEGATIVE_INFINITY,
    head: null,
  },
  {
    name: "negative zero",
    before: "{ value: -0 }",
    after: "{ value: 0 }",
    field: "$.value",
    base: -0,
    head: 0,
  },
  {
    name: "bigint",
    before: "{ value: 1n }",
    after: "{ value: 2n }",
    field: "$.value",
    base: 1n,
    head: 2n,
  },
])(
  "worker transport preserves $name",
  async ({ before, after, field, base, head }) => {
    const root = await mkdtemp(path.join(tmpdir(), "parser-transport-test-"));
    try {
      await git(root, ["init", "--quiet"]);
      await Bun.write(path.join(root, "tsconfig.scripts.json"), "{}");
      await Bun.write(
        path.join(root, "parser.ts"),
        `export const value = ${before};`,
      );
      await Bun.write(
        path.join(root, "runner.ts"),
        'import { value } from "../parser"; export const collectParserOutputs = async () => ({ synthetic: { fixture: value } });',
      );
      await git(root, [
        "add",
        "--",
        "tsconfig.scripts.json",
        "parser.ts",
        "runner.ts",
      ]);
      await git(root, [
        "-c",
        "user.name=Parser test",
        "-c",
        "user.email=parser@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--quiet",
        "-m",
        "test: seed transport fixture",
      ]);
      await Bun.write(
        path.join(root, "parser.ts"),
        `export const value = ${after};`,
      );
      expect(
        await compareCheckouts({ root, base: "HEAD", runner: "runner.ts" }),
      ).toEqual([
        {
          adapter: "synthetic",
          status: "different",
          fixture: "fixture",
          field,
          base,
          head,
        },
      ]);
      await Bun.write(
        path.join(root, "parser.ts"),
        `/* no-op */ export const value = ${before};`,
      );
      expect(
        await compareCheckouts({ root, base: "HEAD", runner: "runner.ts" }),
      ).toEqual([{ adapter: "synthetic", status: "identical" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("workspace imports bind to each checkout rather than the installed head symlink", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "parser-workspace-test-"));
  try {
    await git(root, ["init", "--quiet"]);
    await Bun.write(path.join(root, "package.json"), '{"name":"fixture-root"}');
    await Bun.write(
      path.join(root, "packages/example/package.json"),
      '{"name":"@stll/example","exports":"./index.ts"}',
    );
    await Bun.write(
      path.join(root, "packages/example/index.ts"),
      'export const value = "base";',
    );
    await Bun.write(path.join(root, "tsconfig.scripts.json"), "{}");
    await Bun.write(
      path.join(root, "runner.ts"),
      'import { value } from "@stll/example"; export const collectParserOutputs = async () => ({ synthetic: { fixture: { value } } });',
    );
    await mkdir(path.join(root, "node_modules/@stll"), { recursive: true });
    await symlink(
      path.join(root, "packages/example"),
      path.join(root, "node_modules/@stll/example"),
    );
    await git(root, [
      "add",
      "--",
      "package.json",
      "packages/example/package.json",
      "packages/example/index.ts",
      "tsconfig.scripts.json",
      "runner.ts",
    ]);
    await git(root, [
      "-c",
      "user.name=Parser test",
      "-c",
      "user.email=parser@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "test: seed workspace",
    ]);
    await Bun.write(
      path.join(root, "packages/example/index.ts"),
      'export const value = "head";',
    );
    expect(
      await compareCheckouts({ root, base: "HEAD", runner: "runner.ts" }),
    ).toEqual([
      {
        adapter: "synthetic",
        status: "different",
        fixture: "fixture",
        field: "$.value",
        base: "base",
        head: "head",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
