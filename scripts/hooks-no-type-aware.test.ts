import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT_REFERENCE =
  /(?:^|[\s"'`(])((?:\.\/)?scripts\/[\w./-]+\.(?:[cm]?[jt]s|sh))\b/gu;
const PACKAGE_SCRIPT = /\bbun\s+run\s+([\w:.-]+)/gu;
const FORBIDDEN = [
  { pattern: /--type-aware\b/u, reason: "type-aware oxlint" },
  { pattern: /\btsgolint\b/u, reason: "tsgolint" },
  { pattern: /\btypecheck-coverage(?:\.ts)?\b/u, reason: "typecheck-coverage" },
  {
    pattern: /(?:^|[\s"'`,;|&(])(?:tsc|tsgo)(?:[\s"'`,;|&)]|$)/u,
    reason: "TypeScript compiler",
  },
  {
    pattern: /\bbun\s+run\s+(?:[\w:.-]*typecheck[\w:.-]*)\b/u,
    reason: "typecheck package script",
  },
] as const;

type Violation = { file: string; reason: string };
const packageSchema = v.object({
  scripts: v.optional(v.record(v.string(), v.string()), {}),
});

const executableText = (file: string, source: string): string => {
  if (file.endsWith(".sh")) {
    return source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
  }
  return new Bun.Transpiler({
    loader: file.endsWith("x") ? "tsx" : "ts",
  }).transformSync(source);
};

const commandStrings = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap(commandStrings);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, nested]) =>
    (key === "run" || key === "files") && typeof nested === "string"
      ? [nested]
      : commandStrings(nested),
  );
};

/** Report compiler-backed checks reachable from either repository git hook. */
export const hookTypecheckViolations = (root: string): Violation[] => {
  const manifest = v.parse(
    packageSchema,
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")),
  );
  const pending: { file: string; text: string }[] = [];
  const visitedFiles = new Set<string>();
  const visitedPackageScripts = new Set<string>();
  const violations: Violation[] = [];

  const enqueueConfig = (relative: string) => {
    if (visitedFiles.has(relative)) {
      return;
    }
    visitedFiles.add(relative);
    const config: unknown = Bun.YAML.parse(
      readFileSync(path.join(root, relative), "utf-8"),
    );
    pending.push(
      ...commandStrings(config).map((text) => ({ file: relative, text })),
    );
    if (typeof config === "object" && config !== null && "extends" in config) {
      const extended = (config as { extends?: unknown }).extends;
      for (const include of Array.isArray(extended) ? extended : [extended]) {
        if (typeof include === "string") {
          enqueueConfig(
            path.normalize(path.join(path.dirname(relative), include)),
          );
        }
      }
    }
  };

  const enqueueFile = (reference: string) => {
    const relative = reference.replace(/^\.\//u, "");
    if (visitedFiles.has(relative) || !existsSync(path.join(root, relative))) {
      return;
    }
    visitedFiles.add(relative);
    pending.push({
      file: relative,
      text: executableText(
        relative,
        readFileSync(path.join(root, relative), "utf-8"),
      ),
    });
  };

  enqueueConfig("lefthook.yml");
  while (pending.length > 0) {
    const command = pending.shift();
    if (command === undefined) {
      break;
    }
    for (const forbidden of FORBIDDEN) {
      if (forbidden.pattern.test(command.text)) {
        violations.push({ file: command.file, reason: forbidden.reason });
      }
    }
    for (const match of command.text.matchAll(SCRIPT_REFERENCE)) {
      if (match[1] !== undefined) {
        enqueueFile(match[1]);
      }
    }
    for (const match of command.text.matchAll(PACKAGE_SCRIPT)) {
      const name = match[1];
      if (name === undefined || visitedPackageScripts.has(name)) {
        continue;
      }
      visitedPackageScripts.add(name);
      const text = manifest.scripts[name];
      if (text !== undefined) {
        pending.push({ file: `package.json#${name}`, text });
      }
    }
  }
  return violations;
};

const withFixture = (
  files: Record<string, string>,
  assertion: (root: string) => void,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "hooks-no-type-aware-"));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const destination = path.join(root, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
    }
    assertion(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("git hooks cannot reach compiler-backed lint or type checks", () => {
  expect(hookTypecheckViolations(REPO_ROOT)).toEqual([]);
});

test("catches a direct type-aware hook command", () => {
  withFixture(
    {
      "package.json": "{}",
      "lefthook.yml":
        "pre-commit:\n  commands:\n    lint:\n      run: bunx oxlint --type-aware .\n",
    },
    (root) =>
      expect(hookTypecheckViolations(root)).toEqual([
        { file: "lefthook.yml", reason: "type-aware oxlint" },
      ]),
  );
});

test("catches a type-aware flag reached through a hook script", () => {
  withFixture(
    {
      "package.json": "{}",
      "lefthook.yml":
        "pre-push:\n  commands:\n    guard:\n      run: bun scripts/guard.ts\n",
      "scripts/guard.ts":
        'Bun.spawnSync(["bun", "--bun", "oxlint", "--type-aware", "."]);\n',
    },
    (root) =>
      expect(hookTypecheckViolations(root)).toEqual([
        { file: "scripts/guard.ts", reason: "type-aware oxlint" },
      ]),
  );
});
