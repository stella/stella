#!/usr/bin/env bun
import { panic } from "better-result";
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type ParserOutputs = Record<string, Record<string, unknown>>;
export type OutputDifference = { field: string; base: unknown; head: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isParserOutputs = (value: unknown): value is ParserOutputs =>
  isObject(value) && Object.values(value).every(isObject);

const isFixtureInput = (file: string) =>
  file.startsWith("apps/api/src/") &&
  (file.includes("/__fixtures__/") ||
    /(?:test-fixture|\.fixtures\.)/u.test(file) ||
    file === "apps/api/src/tests/helpers/case-law-enrolled-fixtures.ts" ||
    file ===
      "apps/api/src/handlers/case-law/ingestion/adapters/courtlistener/test-records.ts" ||
    file ===
      "apps/api/src/handlers/case-law/ingestion/adapters/courtlistener/conformance-fixture.ts");

type FirstDifferenceOptions = { base: unknown; head: unknown; field?: string };
/** Sorted object keys make the first reported difference reproducible. */
export const firstDifference = ({
  base,
  head,
  field = "$",
}: FirstDifferenceOptions): OutputDifference | undefined => {
  if (Object.is(base, head)) {
    return undefined;
  }
  if (Array.isArray(base) && Array.isArray(head)) {
    if (base.length !== head.length) {
      return { field: `${field}.length`, base: base.length, head: head.length };
    }
    for (let index = 0; index < base.length; index++) {
      const difference = firstDifference({
        base: base[index],
        head: head[index],
        field: `${field}[${index}]`,
      });
      if (difference) {
        return difference;
      }
    }
    return undefined;
  }
  if (isObject(base) && isObject(head)) {
    for (const key of [
      ...new Set([...Object.keys(base), ...Object.keys(head)]),
    ].toSorted()) {
      const childField = /^[a-zA-Z_$][\w$]*$/u.test(key)
        ? `${field}.${key}`
        : `${field}[${JSON.stringify(key)}]`;
      if (Object.hasOwn(base, key) !== Object.hasOwn(head, key)) {
        return { field: childField, base: base[key], head: head[key] };
      }
      const difference = firstDifference({
        base: base[key],
        head: head[key],
        field: childField,
      });
      if (difference) {
        return difference;
      }
    }
    return undefined;
  }
  return { field, base, head };
};

type CompareParserOutputsOptions = { base: ParserOutputs; head: ParserOutputs };
export const compareParserOutputs = ({
  base,
  head,
}: CompareParserOutputsOptions) =>
  [...new Set([...Object.keys(base), ...Object.keys(head)])]
    .toSorted()
    .map((adapter) => {
      const before = base[adapter];
      const after = head[adapter];
      if (
        !before ||
        !after ||
        Object.keys(before).length === 0 ||
        Object.keys(after).length === 0
      ) {
        return panic(`Missing fixture coverage for ${adapter}`);
      }
      for (const fixture of [
        ...new Set([...Object.keys(before), ...Object.keys(after)]),
      ].toSorted()) {
        const difference = firstDifference({
          base: before[fixture],
          head: after[fixture],
        });
        if (difference) {
          return {
            adapter,
            status: "different",
            fixture,
            ...difference,
          } as const;
        }
      }
      return { adapter, status: "identical" } as const;
    });

const command = async (cwd: string, args: string[]) => {
  const child = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      TZ: "UTC",
      LANG: "C.UTF-8",
      GIT_NO_LAZY_FETCH: "1",
      // Logger imports validate configuration; these endpoints are never used.
      NODE_ENV: "test",
      STELLA_LOCAL_DEV: "1",
      DATABASE_URL: "postgres://parser:parser@127.0.0.1:1/parser",
      S3_ENDPOINT: "http://127.0.0.1:1",
      S3_BUCKET: "parser-fixtures",
      S3_REGION: "fixture",
    },
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) {
    return panic(`${args[0]} failed (${status}): ${stderr}`);
  }
  return stdout;
};

/** Reuse installed external packages, but resolve workspace packages in this tree. */
type LinkDependenciesOptions = { source: string; target: string };
const linkDependencies = async ({
  source,
  target,
}: LinkDependenciesOptions) => {
  const installed = path.join(source, "node_modules");
  if (!(await Bun.file(path.join(source, "package.json")).exists())) {
    return;
  }
  const entries = await readdir(installed, { withFileTypes: true }).catch(
    () => [],
  );
  if (entries.length === 0) {
    return;
  }
  await mkdir(path.join(target, "node_modules"), { recursive: true });
  for (const entry of entries) {
    if (entry.name === "@stll") {
      continue;
    }
    await symlink(
      path.join(installed, entry.name),
      path.join(target, "node_modules", entry.name),
    );
  }
  await mkdir(path.join(target, "node_modules/@stll"), { recursive: true });
  const workspaceNames = new Set<string>();
  for (const workspace of ["packages", "apps"]) {
    for (const entry of await readdir(path.join(target, workspace), {
      withFileTypes: true,
    }).catch(() => [])) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = path.join(target, workspace, entry.name);
      const file = Bun.file(path.join(directory, "package.json"));
      if (!(await file.exists())) {
        continue;
      }
      const manifest: unknown = await file.json();
      if (
        isObject(manifest) &&
        typeof manifest["name"] === "string" &&
        manifest["name"].startsWith("@stll/")
      ) {
        workspaceNames.add(manifest["name"].slice("@stll/".length));
        await symlink(
          directory,
          path.join(target, "node_modules", manifest["name"]),
        );
      }
    }
  }
  for (const entry of await readdir(path.join(installed, "@stll"), {
    withFileTypes: true,
  })) {
    if (!workspaceNames.has(entry.name)) {
      await symlink(
        path.join(installed, "@stll", entry.name),
        path.join(target, "node_modules/@stll", entry.name),
      );
    }
  }
};

type CompareCheckoutsOptions = {
  root: string;
  base: string;
  head?: string;
  /** A fixture harness, shared byte-for-byte by both runtimes. */
  runner?: string;
};

export const compareCheckouts = async ({
  root,
  base,
  head,
  runner = "scripts/parser-output-fixtures.ts",
}: CompareCheckoutsOptions) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "parser-output-diff-"));
  const trees: string[] = [];
  type CheckoutOptions = { ref: string; name: string };
  const checkout = async ({ ref, name }: CheckoutOptions) => {
    const directory = path.join(temporary, name);
    const commit = await command(root, [
      "git",
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ]);
    await command(root, [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "worktree",
      "add",
      "--detach",
      directory,
      commit.trim(),
    ]);
    trees.push(directory);
    await linkDependencies({ source: root, target: directory });
    return directory;
  };
  try {
    const harness = path.join(temporary, "harness");
    await mkdir(harness);
    await cp(path.join(root, runner), path.join(harness, "harness.ts"));
    if (runner === "scripts/parser-output-fixtures.ts") {
      for (const name of new Bun.Glob("parser-output-*-fixtures.ts").scanSync(
        path.join(root, "scripts"),
      )) {
        await cp(path.join(root, "scripts", name), path.join(harness, name));
      }
    }
    const after = await checkout({ ref: head ?? "HEAD", name: "head" });
    if (head === undefined) {
      const patch = path.join(temporary, "working-tree.patch");
      await Bun.write(
        patch,
        await command(root, ["git", "diff", "--binary", "HEAD", "--"]),
      );
      await command(after, ["git", "apply", "--allow-empty", patch]);
      const untracked = (
        await command(root, [
          "git",
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ])
      )
        .split("\0")
        .filter(Boolean);
      for (const file of untracked) {
        if (file.split("/").includes("node_modules")) {
          continue;
        }
        await mkdir(path.dirname(path.join(after, file)), { recursive: true });
        await cp(path.join(root, file), path.join(after, file));
      }
    }
    // Fixture imports resolve relative to their module as well as fixtureRoot.
    // Overlay only test inputs, never parser/normalization implementation.
    const candidates = (
      await command(after, [
        "git",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
      ])
    )
      .split("\n")
      .filter(isFixtureInput);
    const inputs = new Set<string>();
    for (const file of candidates) {
      if (await Bun.file(path.join(after, file)).exists()) {
        inputs.add(file);
      }
    }
    const worker = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const forbiddenNetwork = () => { throw new Error("Network forbidden in parser-output-diff"); };
globalThis.fetch = forbiddenNetwork;
for (const name of ["node:http", "node:https"]) {
  const module = require(name);
  module.request = forbiddenNetwork;
  module.get = forbiddenNetwork;
}
const net = require("node:net");
net.connect = forbiddenNetwork;
net.createConnection = forbiddenNetwork;
net.Socket.prototype.connect = forbiddenNetwork;
require("node:tls").connect = forbiddenNetwork;
require("node:dgram").Socket.prototype.send = forbiddenNetwork;
Bun.connect = forbiddenNetwork;
Bun.listen = forbiddenNetwork;
Bun.SQL = class { constructor() { throw new Error("Database forbidden in parser-output-diff"); } };
const RealDate = Date;
let parsing = false;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0 && parsing) throw new Error("Clock forbidden in parser-output-diff");
    if (args.length === 0) super(0);
    else super(...args);
  }
  static now() {
    if (parsing) throw new Error("Clock forbidden in parser-output-diff");
    return 0;
  }
};
Math.random = () => { throw new Error("Randomness forbidden in parser-output-diff"); };
const { collectParserOutputs } = await import("./harness.ts");
parsing = true;
const result = await collectParserOutputs(process.argv[2]);
await Bun.write(process.argv[3], JSON.stringify(result));
`;
    type EvaluateOptions = { tree: string; name: string };
    const evaluate = async ({
      tree,
      name,
    }: EvaluateOptions): Promise<ParserOutputs> => {
      const directory = path.join(tree, ".parser-output-diff");
      await cp(harness, directory, { recursive: true });
      try {
        await Bun.write(path.join(directory, "worker.ts"), worker);
        const output = path.join(temporary, `${name}.json`);
        await command(tree, [
          process.execPath,
          "--no-env-file",
          "--tsconfig-override",
          path.join(tree, "tsconfig.scripts.json"),
          path.join(directory, "worker.ts"),
          after,
          output,
        ]);
        const parsed: unknown = await Bun.file(output).json();
        if (!isParserOutputs(parsed)) {
          return panic("Invalid parser fixture output envelope");
        }
        return parsed;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    };
    const headOutput = await evaluate({ tree: after, name: "head" });
    const before = await checkout({ ref: base, name: "base" });
    const lockfile = "bun.lock";
    const headLock = Bun.file(path.join(after, lockfile));
    for (const tree of [before, root]) {
      const installedLock = Bun.file(path.join(tree, lockfile));
      if (
        (await installedLock.exists()) !== (await headLock.exists()) ||
        ((await installedLock.exists()) &&
          (await installedLock.text()) !== (await headLock.text()))
      ) {
        return panic(
          "Dependency lockfiles differ; cannot prove output parity with shared installed dependencies",
        );
      }
    }
    const oldInputs = (await command(before, ["git", "ls-files", "-z"]))
      .split("\0")
      .filter(isFixtureInput);
    for (const file of oldInputs) {
      if (!inputs.has(file)) {
        await rm(path.join(before, file), { force: true });
      }
    }
    for (const file of inputs) {
      await mkdir(path.dirname(path.join(before, file)), { recursive: true });
      await cp(path.join(after, file), path.join(before, file));
    }
    const baseOutput = await evaluate({ tree: before, name: "base" });
    if (
      Object.keys(baseOutput).length === 0 ||
      Object.keys(headOutput).length === 0
    ) {
      return panic("No adapters exercised");
    }
    return compareParserOutputs({ base: baseOutput, head: headOutput });
  } finally {
    for (const tree of trees.toReversed()) {
      await command(root, ["git", "worktree", "remove", "--force", tree]);
    }
    await rm(temporary, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (
      args.some(
        (arg, index) =>
          index % 2 === 0 &&
          arg !== "--base" &&
          arg !== "--head" &&
          arg !== "--output",
      ) ||
      args.length % 2 !== 0
    ) {
      panic(
        "Usage: bun scripts/parser-output-diff.ts [--base origin/main] [--head ref] [--output report.jsonl]",
      );
    }
    const options = new Map(
      Array.from({ length: args.length / 2 }, (_, index) => [
        args[index * 2],
        args[index * 2 + 1],
      ]),
    );
    const results = await compareCheckouts({
      root: process.cwd(),
      base: options.get("--base") ?? "origin/main",
      head: options.get("--head"),
    });
    const rows = results.map((result) =>
      JSON.stringify(result, (_key, value: unknown) =>
        value === undefined ? "<absent>" : value,
      ),
    );
    const output = options.get("--output");
    if (output !== undefined) {
      await Bun.write(output, `${rows.join("\n")}\n`);
      for (const result of results) {
        console.log(
          `${result.adapter}: ${result.status}${result.status === "different" ? ` (${result.fixture} ${result.field})` : ""}`,
        );
      }
    } else {
      for (const row of rows) {
        console.log(row);
      }
    }
    process.exitCode = results.some(({ status }) => status === "different")
      ? 1
      : 0;
  } catch (error) {
    console.error(`parser-output-diff: ${String(error)}`);
    process.exitCode = 2;
  }
}
