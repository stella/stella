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

// `scripts/require-hook-deps.sh` lets a commit run its hooks once the root
// workspace is installed, so every package a hook loads must be a root
// dependency. This walks the modules each hook command loads (its scripts,
// including the `files:` command that lists its paths, the scripts they
// import, and for the lint hook oxlint.config.ts and every JS plugin the
// loaded config names) and reports each bare import the root does not
// declare, and each package executable a hook runs that no root dependency
// provides. A command that passes workspaces to require-hook-deps.sh requires
// those installed too and is not walked.

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const HOOKS = ["pre-commit", "pre-push"] as const;
const LINT_RUNNER = "scripts/precommit-lint.ts";
const LINT_CONFIG = "oxlint.config.ts";
const WORKSPACE_INSTALL = /require-hook-deps\.sh\s+[^\s&|;]/u;
const SCRIPT_FILE =
  /(?:^|[\s"'])((?:\.\/)?(?:scripts|\.oxlint-plugins)\/[\w./-]+\.(?:[cm]?[jt]s|sh))/gu;
const PACKAGE_SCRIPT = /\bbun run ([\w:.-]+)/gu;
// `bun --bun <bin>`, `bun x <bin>` and `bunx <bin>`, in shell text and as the
// leading elements of a spawned argv array.
const SHELL_PACKAGE_BIN =
  /(?:^|[\s;&|(])(?:bunx|bun\s+x|bun\s+--bun)\s+([^\s"'`;&|()]+)/gu;
const ARGV_PACKAGE_BIN =
  /["'](?:bunx|bun["']\s*,\s*["'](?:--bun|x))["']\s*,\s*["']([^"']+)["']/gu;
// A hook command or package script may start a command only with these;
// any other command word must be an executable a root dependency provides.
const RUNTIME_COMMANDS = new Set(["bash", "bun", "bunx"]);
const COMMAND_SEPARATOR = /&&|\|\||[;|]/u;
const ENV_ASSIGNMENT = /^\w+=/u;
const MODULE_FILE = /\.[cm]?[jt]sx?$/u;
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".js", "/index.ts"];

const lefthookSchema = v.record(v.string(), v.unknown());
const hookSchema = v.object({
  commands: v.record(
    v.string(),
    v.object({ run: v.string(), files: v.optional(v.string()) }),
  ),
});
const packageSchema = v.object({
  scripts: v.optional(v.record(v.string(), v.string()), {}),
  dependencies: v.optional(v.record(v.string(), v.string()), {}),
  devDependencies: v.optional(v.record(v.string(), v.string()), {}),
  optionalDependencies: v.optional(v.record(v.string(), v.string()), {}),
});
const installedPackageSchema = v.object({
  name: v.string(),
  bin: v.optional(v.union([v.string(), v.record(v.string(), v.string())])),
});
// The loaded config, not its source text: plugins also arrive through
// imported constants, `extends` presets and overrides.
const jsPluginSchema = v.union([
  v.string(),
  v.object({ name: v.string(), specifier: v.string() }),
]);
type LintConfig = {
  jsPlugins?: v.InferOutput<typeof jsPluginSchema>[] | undefined;
  extends?: LintConfig[] | undefined;
  overrides?: LintConfig[] | undefined;
};
const lintConfigSchema: v.GenericSchema<LintConfig> = v.looseObject({
  jsPlugins: v.optional(v.array(jsPluginSchema)),
  extends: v.optional(v.array(v.lazy(() => lintConfigSchema))),
  overrides: v.optional(v.array(v.lazy(() => lintConfigSchema))),
});
const lintConfigModuleSchema = v.object({ default: lintConfigSchema });

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

const isFileSpecifier = (specifier: string): boolean =>
  specifier.startsWith("./") || specifier.startsWith("../");

export type UndeclaredHookDependency = {
  kind: "import" | "executable";
  file: string;
  specifier: string;
};

/** Every executable each declared root dependency installs. */
const declaredExecutables = (
  root: string,
  declared: ReadonlySet<string>,
): Set<string> => {
  const executables = new Set<string>();
  for (const name of declared) {
    const manifestPath = path.join(root, "node_modules", name, "package.json");
    if (!existsSync(manifestPath)) {
      continue;
    }
    const { bin } = v.parse(
      installedPackageSchema,
      JSON.parse(readFileSync(manifestPath, "utf-8")),
    );
    if (typeof bin === "string") {
      executables.add(name.split("/").at(-1) ?? name);
    } else if (bin !== undefined) {
      for (const executable of Object.keys(bin)) {
        executables.add(executable);
      }
    }
  }
  return executables;
};

const lintPluginSpecifiers = (config: LintConfig): string[] => [
  ...(config.jsPlugins ?? []).map((plugin) =>
    typeof plugin === "string" ? plugin : plugin.specifier,
  ),
  ...[...(config.extends ?? []), ...(config.overrides ?? [])].flatMap(
    lintPluginSpecifiers,
  ),
];

/**
 * Every bare import a hook loads that the root package.json does not declare,
 * and every package executable a hook runs that no root dependency provides.
 */
export const undeclaredHookDependencies = async (
  root: string,
): Promise<UndeclaredHookDependency[]> => {
  const manifest = v.parse(
    packageSchema,
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")),
  );
  const declared = new Set([
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.devDependencies),
    ...Object.keys(manifest.optionalDependencies),
  ]);
  const executables = declaredExecutables(root, declared);
  const lefthook = v.parse(
    lefthookSchema,
    Bun.YAML.parse(readFileSync(path.join(root, "lefthook.yml"), "utf-8")),
  );

  const undeclared: UndeclaredHookDependency[] = [];
  const requireExecutable = (file: string, executable: string) => {
    if (!executables.has(executable)) {
      undeclared.push({ kind: "executable", file, specifier: executable });
    }
  };
  const packageBins = (file: string, text: string, pattern: RegExp) => {
    for (const [, executable] of text.matchAll(pattern)) {
      if (executable !== undefined && !executable.includes("/")) {
        requireExecutable(file, executable);
      }
    }
  };
  // A one-line hook command or package script: every command word that is
  // not a runtime or a file runs a package executable.
  const commandWords = (file: string, command: string) => {
    for (const segment of command.split(COMMAND_SEPARATOR)) {
      const word = segment
        .trim()
        .split(/\s+/u)
        .find((token) => !ENV_ASSIGNMENT.test(token));
      if (
        word !== undefined &&
        word !== "" &&
        !RUNTIME_COMMANDS.has(word) &&
        !word.includes("/")
      ) {
        requireExecutable(file, word);
      }
    }
  };

  const entries = new Set<string>();
  const expanded = new Set<string>();
  const addCommand = (file: string, command: string) => {
    packageBins(file, command, SHELL_PACKAGE_BIN);
    for (const [, script] of command.matchAll(SCRIPT_FILE)) {
      const relative = path.normalize(script ?? "");
      if (entries.has(relative)) {
        continue;
      }
      entries.add(relative);
      if (relative.endsWith(".sh")) {
        addCommand(relative, readFileSync(path.join(root, relative), "utf-8"));
      }
    }
    for (const [, name] of command.matchAll(PACKAGE_SCRIPT)) {
      const script = name === undefined ? undefined : manifest.scripts[name];
      if (script !== undefined && !expanded.has(name ?? "")) {
        expanded.add(name ?? "");
        commandWords("package.json", script);
        addCommand("package.json", script);
      }
    }
  };
  for (const hook of HOOKS) {
    const { commands } = v.parse(hookSchema, lefthook[hook]);
    for (const { run, files } of Object.values(commands)) {
      if (files !== undefined) {
        commandWords("lefthook.yml", files);
        addCommand("lefthook.yml", files);
      }
      if (!WORKSPACE_INSTALL.test(run)) {
        commandWords("lefthook.yml", run);
        addCommand("lefthook.yml", run);
      }
    }
  }
  if (entries.has(LINT_RUNNER)) {
    entries.add(LINT_CONFIG);
    const { default: config } = v.parse(
      lintConfigModuleSchema,
      await import(path.join(root, LINT_CONFIG)),
    );
    for (const plugin of lintPluginSpecifiers(config)) {
      if (isFileSpecifier(plugin)) {
        entries.add(path.normalize(plugin));
      } else if (!declared.has(packageName(plugin))) {
        undeclared.push({
          kind: "import",
          file: LINT_CONFIG,
          specifier: plugin,
        });
      }
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
  const seen = new Set<string>();
  const queue = [...entries].map((entry) => path.join(root, entry));
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file) || !MODULE_FILE.test(file)) {
      continue;
    }
    seen.add(file);
    // scanImports rejects an executable script's leading shebang line.
    const source = readFileSync(file, "utf-8").replace(/^#![^\n]*/u, "");
    packageBins(repoRelativePath(root, file), source, ARGV_PACKAGE_BIN);
    for (const { path: specifier } of transpilerFor(file).scanImports(source)) {
      if (isFileSpecifier(specifier)) {
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
        undeclared.push({
          kind: "import",
          file: repoRelativePath(root, file),
          specifier,
        });
      }
    }
  }
  const key = ({ kind, file, specifier }: UndeclaredHookDependency) =>
    `${kind}:${file}:${specifier}`;
  // One finding per file and name, however often the file repeats it.
  const unique = new Map(undeclared.map((entry) => [key(entry), entry]));
  return [...unique.values()].toSorted(
    (left, right) =>
      Number(key(left) > key(right)) - Number(key(left) < key(right)),
  );
};

const withFixture = async (
  files: Record<string, string>,
  check: (root: string) => Promise<void>,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "hook-dependencies-"));
  try {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
    await check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const lefthookFixture = (commands: Record<string, string>) =>
  [
    "pre-commit:",
    "  commands:",
    ...Object.entries(commands).flatMap(([name, run]) => [
      `    ${name}:`,
      `      run: ${run}`,
    ]),
    "pre-push:",
    "  commands: {}",
  ].join("\n");

test("every package the git hooks load is a root dependency", async () => {
  expect(await undeclaredHookDependencies(REPO_ROOT)).toEqual([]);
});

test("reports a bare import a lint plugin reaches through a relative module", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({
        scripts: { "check:x": "bun scripts/check-x.ts" },
        devDependencies: { "declared-pkg": "1.0.0" },
      }),
      "lefthook.yml": [
        "pre-commit:",
        "  commands:",
        "    lint:",
        "      run: bun scripts/precommit-lint.ts {staged_files}",
        "    sync:",
        "      run: bash scripts/require-hook-deps.sh apps/web && bun scripts/sync.ts",
        "pre-push:",
        "  commands:",
        "    check:",
        "      run: bun run check:x",
      ].join("\n"),
      "scripts/precommit-lint.ts": 'import "declared-pkg";\n',
      "scripts/check-x.ts":
        '#!/usr/bin/env bun\nimport "node:fs";\nimport "bun";\n',
      "scripts/sync.ts": 'import "workspace-only";\n',
      [LINT_CONFIG]:
        'export default { jsPlugins: ["./.oxlint-plugins/rule.ts"] };\n',
      ".oxlint-plugins/rule.ts": 'import "../packages/leaf/src/leaf.ts";\n',
      // An arrow generic parses as TypeScript, not as an element.
      "packages/leaf/src/leaf.ts":
        'import "@scope/undeclared/sub";\nimport "declared-pkg/deep";\nexport const pick = <const T>(value: T): T => value;\n',
    },
    async (root) => {
      expect(await undeclaredHookDependencies(root)).toEqual([
        {
          kind: "import",
          file: "packages/leaf/src/leaf.ts",
          specifier: "@scope/undeclared/sub",
        },
      ]);
    },
  );
});

test("walks every JS plugin the loaded lint config names, however it is written", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({
        devDependencies: { "declared-plugin": "1.0.0" },
      }),
      "lefthook.yml": lefthookFixture({
        lint: "bun scripts/precommit-lint.ts {staged_files}",
      }),
      "scripts/precommit-lint.ts": "",
      "scripts/preset.mjs":
        'export default { overrides: [{ files: ["*.ts"], jsPlugins: ["./plugins/override.mjs"] }] };\n',
      "scripts/plugins.ts":
        'export const PLUGINS = [{ name: "spread", specifier: "./plugins/spread.mjs" }];\n',
      [LINT_CONFIG]: [
        'import preset from "./scripts/preset.mjs";',
        'import { PLUGINS } from "./scripts/plugins.ts";',
        "export default {",
        "  extends: [preset],",
        "  jsPlugins: [",
        '    { name: "object", specifier: "./plugins/object.mjs" },',
        "    ...PLUGINS,",
        '    "declared-plugin/rules",',
        '    "undeclared-plugin",',
        "  ],",
        "};",
      ].join("\n"),
      "plugins/object.mjs": 'import "object-dep";\n',
      "plugins/spread.mjs": 'import "spread-dep";\n',
      "plugins/override.mjs": 'import "override-dep";\n',
    },
    async (root) => {
      expect(await undeclaredHookDependencies(root)).toEqual([
        { kind: "import", file: LINT_CONFIG, specifier: "undeclared-plugin" },
        { kind: "import", file: "plugins/object.mjs", specifier: "object-dep" },
        {
          kind: "import",
          file: "plugins/override.mjs",
          specifier: "override-dep",
        },
        { kind: "import", file: "plugins/spread.mjs", specifier: "spread-dep" },
      ]);
    },
  );
});

test("reports a package executable a hook runs that no root dependency provides", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({
        scripts: {
          "check:x": "turbo run check",
          "check:y": "NODE_ENV=test declared-tool --check && bun scripts/y.ts",
        },
        devDependencies: { "declared-pkg": "1.0.0", "@scope/single": "1.0.0" },
      }),
      "node_modules/declared-pkg/package.json": JSON.stringify({
        name: "declared-pkg",
        bin: { "declared-tool": "bin/tool.js" },
      }),
      "node_modules/@scope/single/package.json": JSON.stringify({
        name: "@scope/single",
        bin: "bin/single.js",
      }),
      "lefthook.yml": lefthookFixture({
        format: "bun --bun undeclared-formatter --staged",
        builtin: "bun fmt --staged",
        scoped: "bunx single",
        script: "bash scripts/run.sh",
        x: "bun run check:x",
        y: "bun run check:y",
      }),
      "scripts/run.sh": "set -e\nbun x missing-tool\nbun x declared-tool\n",
      "scripts/y.ts": [
        'Bun.spawnSync(["bun", "--bun", "spawned-tool", "-c", "x"]);',
        'Bun.spawnSync(["bunx", "declared-tool"]);',
        'Bun.spawnSync(["git", "status"]);',
      ].join("\n"),
    },
    async (root) => {
      expect(await undeclaredHookDependencies(root)).toEqual([
        {
          kind: "executable",
          file: "lefthook.yml",
          specifier: "undeclared-formatter",
        },
        { kind: "executable", file: "package.json", specifier: "turbo" },
        {
          kind: "executable",
          file: "scripts/run.sh",
          specifier: "missing-tool",
        },
        { kind: "executable", file: "scripts/y.ts", specifier: "spawned-tool" },
      ]);
    },
  );
});
