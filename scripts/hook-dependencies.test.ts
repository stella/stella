import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";

// A fresh checkout commits after `scripts/ensure-hook-deps.sh` installs only
// the root workspace, so every package a hook loads must be a root
// dependency. This walks the modules each hook command loads (its scripts,
// the scripts they import, and for the lint hook oxlint.config.ts and every
// JS plugin it names) and reports each bare import the root does not declare.
// A command that passes workspaces to ensure-hook-deps.sh installs those
// itself and is not walked.

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const HOOKS = ["pre-commit", "pre-push"] as const;
const LINT_RUNNER = "scripts/precommit-lint.ts";
const LINT_CONFIG = "oxlint.config.ts";
const WORKSPACE_INSTALL = /ensure-hook-deps\.sh\s+[^\s&|;]/u;
const SCRIPT_FILE =
  /(?:^|[\s"'])((?:\.\/)?(?:scripts|\.oxlint-plugins)\/[\w./-]+\.(?:[cm]?[jt]s|sh))/gu;
const PACKAGE_SCRIPT = /\bbun run ([\w:.-]+)/gu;
const JS_PLUGIN = /"\.\/(\.oxlint-plugins\/[\w./-]+\.ts)"/gu;
const MODULE_FILE = /\.[cm]?[jt]sx?$/u;
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".js", "/index.ts"];

const lefthookSchema = v.record(v.string(), v.unknown());
const hookSchema = v.object({
  commands: v.record(v.string(), v.object({ run: v.string() })),
});
const packageSchema = v.object({
  scripts: v.optional(v.record(v.string(), v.string()), {}),
  dependencies: v.optional(v.record(v.string(), v.string()), {}),
  devDependencies: v.optional(v.record(v.string(), v.string()), {}),
  optionalDependencies: v.optional(v.record(v.string(), v.string()), {}),
});

// Each file parses with its own extension's syntax: under the JSX loaders a
// TypeScript generic such as `<const T>` reads as an element.
const transpilers = {
  js: new Bun.Transpiler({ loader: "js" }),
  jsx: new Bun.Transpiler({ loader: "jsx" }),
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};
const transpilerFor = (file: string): Bun.Transpiler => {
  const extension = path.extname(file);
  if (extension === ".tsx") {
    return transpilers.tsx;
  }
  if (extension === ".jsx") {
    return transpilers.jsx;
  }
  return /^\.[cm]?ts$/u.test(extension) ? transpilers.ts : transpilers.js;
};
const builtins = new Set(builtinModules);

const packageName = (specifier: string): string =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

const isRuntimeModule = (specifier: string): boolean =>
  specifier.startsWith("node:") ||
  specifier === "bun" ||
  specifier.startsWith("bun:") ||
  builtins.has(specifier);

export type UndeclaredImport = { file: string; specifier: string };

/** Every bare import a hook loads that the root package.json does not declare. */
export const undeclaredHookImports = (root: string): UndeclaredImport[] => {
  const manifest = v.parse(
    packageSchema,
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")),
  );
  const declared = new Set([
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.devDependencies),
    ...Object.keys(manifest.optionalDependencies),
  ]);
  const lefthook = v.parse(
    lefthookSchema,
    Bun.YAML.parse(readFileSync(path.join(root, "lefthook.yml"), "utf-8")),
  );

  const entries = new Set<string>();
  const expanded = new Set<string>();
  const addCommand = (command: string) => {
    for (const [, file] of command.matchAll(SCRIPT_FILE)) {
      const relative = path.normalize(file ?? "");
      if (entries.has(relative)) {
        continue;
      }
      entries.add(relative);
      if (relative.endsWith(".sh")) {
        addCommand(readFileSync(path.join(root, relative), "utf-8"));
      }
    }
    for (const [, name] of command.matchAll(PACKAGE_SCRIPT)) {
      const script = name === undefined ? undefined : manifest.scripts[name];
      if (script !== undefined && !expanded.has(name ?? "")) {
        expanded.add(name ?? "");
        addCommand(script);
      }
    }
  };
  for (const hook of HOOKS) {
    const { commands } = v.parse(hookSchema, lefthook[hook]);
    for (const { run } of Object.values(commands)) {
      if (!WORKSPACE_INSTALL.test(run)) {
        addCommand(run);
      }
    }
  }
  if (entries.has(LINT_RUNNER)) {
    entries.add(LINT_CONFIG);
    const config = readFileSync(path.join(root, LINT_CONFIG), "utf-8");
    for (const [, plugin] of config.matchAll(JS_PLUGIN)) {
      entries.add(path.normalize(plugin ?? ""));
    }
  }

  const resolveFile = (base: string): string => {
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = `${base}${suffix}`;
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    }
    throw new Error(`a hook imports ${base}, which does not exist`);
  };
  const undeclared: UndeclaredImport[] = [];
  const seen = new Set<string>();
  const queue = [...entries].map((entry) => path.join(root, entry));
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file) || !MODULE_FILE.test(file)) {
      continue;
    }
    seen.add(file);
    // scanImports rejects an executable script's leading shebang line.
    const source = readFileSync(file, "utf-8").replace(/^#![^\n]*/u, "");
    for (const { path: specifier } of transpilerFor(file).scanImports(source)) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        queue.push(resolveFile(path.resolve(path.dirname(file), specifier)));
      } else if (specifier.startsWith("@/api/")) {
        queue.push(
          resolveFile(
            path.join(root, "apps/api/src", specifier.slice("@/api/".length)),
          ),
        );
      } else if (
        !isRuntimeModule(specifier) &&
        !declared.has(packageName(specifier))
      ) {
        undeclared.push({ file: repoRelativePath(root, file), specifier });
      }
    }
  }
  const key = ({ file, specifier }: UndeclaredImport) => `${file}:${specifier}`;
  return undeclared.toSorted(
    (left, right) =>
      Number(key(left) > key(right)) - Number(key(left) < key(right)),
  );
};

test("every package the git hooks load is a root dependency", () => {
  expect(undeclaredHookImports(REPO_ROOT)).toEqual([]);
});

test("reports a bare import a lint plugin reaches through a relative module", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hook-dependencies-"));
  try {
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    };
    write(
      "package.json",
      JSON.stringify({
        scripts: { "check:x": "bun scripts/check-x.ts" },
        devDependencies: { "declared-pkg": "1.0.0" },
      }),
    );
    write(
      "lefthook.yml",
      [
        "pre-commit:",
        "  commands:",
        "    lint:",
        "      run: bun scripts/precommit-lint.ts {staged_files}",
        "    sync:",
        "      run: bash scripts/ensure-hook-deps.sh apps/web && bun scripts/sync.ts",
        "pre-push:",
        "  commands:",
        "    check:",
        "      run: bun run check:x",
      ].join("\n"),
    );
    write("scripts/precommit-lint.ts", 'import "declared-pkg";\n');
    write(
      "scripts/check-x.ts",
      '#!/usr/bin/env bun\nimport "node:fs";\nimport "bun";\n',
    );
    write("scripts/sync.ts", 'import "workspace-only";\n');
    write(
      LINT_CONFIG,
      'export default { jsPlugins: ["./.oxlint-plugins/rule.ts"] };\n',
    );
    write(
      ".oxlint-plugins/rule.ts",
      'import "../packages/leaf/src/leaf.ts";\n',
    );
    write(
      "packages/leaf/src/leaf.ts",
      // An arrow generic parses as TypeScript, not as an element.
      'import "@scope/undeclared/sub";\nimport "declared-pkg/deep";\nexport const pick = <const T>(value: T): T => value;\n',
    );
    expect(undeclaredHookImports(root)).toEqual([
      {
        file: "packages/leaf/src/leaf.ts",
        specifier: "@scope/undeclared/sub",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
