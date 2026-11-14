import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseSource, walk } from "../packages/scripts/src/syntax-tree.ts";

// node:child_process' synchronous calls keep at most `maxBuffer` bytes of a
// child's output (1 MiB by default) and fail with ENOBUFS past it. A tracked
// file list, a diff or a log grows past that with the repository, so every
// call states its own limit.
const SYNC_CALLS = new Set(["execFileSync", "execSync", "spawnSync"]);
const CHILD_PROCESS = /^(?:node:)?child_process$/u;
const root = path.resolve(import.meta.dir, "..");

const callsWithoutMaxBuffer = (file: string, text: string) => {
  const source = parseSource(file, text);
  const named = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of source.program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      !CHILD_PROCESS.test(statement.source.value)
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      const { local: binding } = specifier;
      if (specifier.type !== "ImportSpecifier") {
        // A namespace or default import.
        namespaces.add(binding.name);
        continue;
      }
      const imported =
        specifier.imported.type === "Identifier"
          ? specifier.imported.name
          : specifier.imported.value;
      if (SYNC_CALLS.has(imported)) {
        named.add(binding.name);
      }
    }
  }
  const lines: number[] = [];
  walk(source.program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const { callee } = node;
    const isSyncCall =
      callee.type === "Identifier"
        ? named.has(callee.name)
        : callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.object.type === "Identifier" &&
          namespaces.has(callee.object.name) &&
          callee.property.type === "Identifier" &&
          SYNC_CALLS.has(callee.property.name);
    const states = node.arguments.some(
      (argument) =>
        argument.type === "ObjectExpression" &&
        argument.properties.some(
          (property) =>
            property.type === "Property" &&
            !property.computed &&
            property.key.type === "Identifier" &&
            property.key.name === "maxBuffer",
        ),
    );
    if (isSyncCall && !states) {
      lines.push(source.locate(node.start).line);
    }
  });
  return lines;
};

test("every synchronous child process call states its output limit", () => {
  const listed = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "-z",
      "--",
      "*.ts",
      "*.tsx",
      "*.mts",
      "*.cts",
      "*.mjs",
      "*.js",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  expect(listed.exitCode).toBe(0);
  const missing = listed.stdout
    .toString()
    .split("\0")
    .filter((file) => file !== "")
    .flatMap((file) => {
      const text = readFileSync(path.join(root, file), "utf-8");
      return text.includes("child_process")
        ? callsWithoutMaxBuffer(file, text).map((line) => `${file}:${line}`)
        : [];
    });
  expect(missing).toEqual([]);
});

test("a call without its own limit is found, one with it is not", () => {
  const source = [
    'import { execFileSync, spawnSync as run } from "node:child_process";',
    'import * as child from "child_process";',
    'execFileSync("git", ["ls-files"]);',
    'run("git", ["status", "--porcelain"], { cwd: "." });',
    'child.execSync("ls");',
    'execFileSync("git", ["ls-files"], { maxBuffer: 2 ** 30 });',
    'Bun.spawnSync(["git", "ls-files"]);',
  ].join("\n");
  expect(callsWithoutMaxBuffer("fixture.ts", source)).toEqual([3, 4, 5]);
});
