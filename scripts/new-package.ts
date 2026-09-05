#!/usr/bin/env bun

// Package scaffolder.
//
//   bun run new-package <name> --description "<one line>"
//
// Extraction has to be cheaper than duplication, or duplication wins: this
// writes the four files a workspace package needs (package.json, tsconfig.json,
// src/index.ts, README.md), registers the knip workspace, and prints the wiring
// steps. Templates track packages/chat-limits, the smallest package in the
// repo.

import { panic } from "better-result";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const KNIP_REL = "knip.json";
const USAGE = 'bun run new-package <name> --description "<one line>"';
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

type ScaffoldOptions = {
  readonly name: string;
  readonly description: string;
  readonly root: string;
};

type ParsedArgs =
  | ({ readonly status: "ok" } & ScaffoldOptions)
  | { readonly status: "error"; readonly message: string };

const FLAGS = ["--description", "--root"] as const;

type Flag = (typeof FLAGS)[number];

export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  let name: string | null = null;
  let description: string | null = null;
  let root = REPO_ROOT;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const flag: Flag | undefined = FLAGS.find(
      (candidate) => arg === candidate || arg.startsWith(`${candidate}=`),
    );
    if (flag !== undefined) {
      const inline = arg.startsWith(`${flag}=`);
      const value = inline ? arg.slice(flag.length + 1) : argv[i + 1];
      if (value === undefined) {
        return { status: "error", message: `${flag} needs a value` };
      }
      if (!inline) {
        i += 1;
      }
      switch (flag) {
        case "--description":
          description = value;
          break;
        case "--root":
          root = value;
          break;
        default: {
          flag satisfies never;
          panic(`unhandled flag ${String(flag)}`);
        }
      }
      continue;
    }
    if (arg.startsWith("-")) {
      return { status: "error", message: `unknown flag ${arg}` };
    }
    if (name !== null) {
      return { status: "error", message: `unexpected argument ${arg}` };
    }
    name = arg;
  }

  if (name === null || name.length === 0) {
    return { status: "error", message: `package name is required: ${USAGE}` };
  }
  if (description === null || description.trim().length === 0) {
    return {
      status: "error",
      message: `--description is required and must not be empty: ${USAGE}`,
    };
  }

  return { status: "ok", name, description: description.trim(), root };
};

// --- Templates ---------------------------------------------------------------

const packageJsonTemplate = ({
  name,
  description,
}: Omit<ScaffoldOptions, "root">): string =>
  `${JSON.stringify(
    {
      name: `@stll/${name}`,
      version: "0.0.0",
      description,
      private: true,
      license: "Apache-2.0",
      type: "module",
      sideEffects: false,
      exports: { ".": "./src/index.ts" },
      scripts: {
        clean: "git clean -xdf .cache .turbo node_modules",
        test: "bun test src",
        typecheck: "bun ../../packages/scripts/src/tsc-native.ts --noEmit",
        lint: `cd ../.. && bun --bun oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error --deny-warnings --type-aware packages/${name}`,
        "lint:fix": `cd ../.. && bun --bun oxlint -c oxlint.config.ts --type-aware --fix packages/${name}`,
        format: "bun ../../scripts/run-oxfmt.ts .",
      },
      devDependencies: {
        "@stll/typescript-config": "workspace:*",
        "bun-types": "catalog:",
      },
    },
    null,
    2,
  )}\n`;

const TSCONFIG_TEMPLATE = `${JSON.stringify(
  {
    extends: "@stll/typescript-config/base.json",
    compilerOptions: {
      lib: ["ESNext"],
      module: "ESNext",
      types: ["bun-types"],
    },
    include: ["."],
    exclude: ["node_modules"],
  },
  null,
  2,
)}\n`;

const INDEX_TEMPLATE =
  "// Entry point; the change that extracts the shared code fills it in.\nexport {};\n";

const sentence = (description: string): string => {
  const trimmed = description.trim().replace(/[.]$/u, "");
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
};

const readmeTemplate = ({
  name,
  description,
}: Omit<ScaffoldOptions, "root">): string =>
  [
    `# @stll/${name}`,
    "",
    `${sentence(description)}.`,
    "",
    "## What lives here",
    "",
    `${sentence(description)}, and the tests that pin its behaviour.`,
    "",
    "## What does not",
    "",
    "Anything outside that concern: app-specific wiring, one-off helpers, and",
    "code another package already owns.",
    "",
    "## License",
    "",
    "Apache-2.0",
    "",
  ].join("\n");

// --- knip registration -------------------------------------------------------
// knip.json carries comments, so it is edited as text: JSON.parse/stringify
// would silently drop them.

const WORKSPACE_KEY = /^ {4}"(?<key>[^"]+)":\s*\{/u;
const WORKSPACE_END = /^ {4}\},?$/u;
const PACKAGE_PREFIX = "packages/";

type KnipInsertion =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "unsupported"; readonly message: string };

const insertKnipWorkspace = (source: string, name: string): KnipInsertion => {
  const key = `${PACKAGE_PREFIX}${name}`;
  const block = [
    `    "${key}": {`,
    '      "entry": ["src/index.ts", "src/**/*.test.ts"]',
    "    },",
  ];
  const lines = source.split("\n");

  const packageStarts = lines.flatMap((line, index) => {
    const existing = WORKSPACE_KEY.exec(line)?.groups?.["key"] ?? "";
    return existing.startsWith(PACKAGE_PREFIX)
      ? [{ index, key: existing }]
      : [];
  });
  const last = packageStarts.at(-1);
  if (last === undefined) {
    return {
      status: "unsupported",
      message: `${KNIP_REL} has no ${PACKAGE_PREFIX} workspace to sort against`,
    };
  }

  // Sorted position among the packages/* keys: before the first one that sorts
  // after the new key, otherwise after the last entry (whose closing brace may
  // need a comma, since it can be the final workspace).
  const successor = packageStarts.find((entry) => entry.key > key);
  if (successor !== undefined) {
    lines.splice(successor.index, 0, ...block);
    return { status: "ok", text: lines.join("\n") };
  }

  const endLine = lines.find(
    (line, index) => index > last.index && WORKSPACE_END.test(line),
  );
  if (endLine === undefined) {
    return {
      status: "unsupported",
      message: `${KNIP_REL} workspace "${last.key}" is not terminated`,
    };
  }
  // The new entry inherits the last one's punctuation: it is the final
  // workspace only when the entry it follows was, and a non-package workspace
  // listed after it still needs the comma.
  const endIndex = lines.indexOf(endLine, last.index + 1);
  lines[endIndex] = "    },";
  lines.splice(
    endIndex + 1,
    0,
    ...block.slice(0, -1),
    endLine.trimEnd().endsWith(",") ? "    }," : "    }",
  );
  return { status: "ok", text: lines.join("\n") };
};

// --- Scaffolding -------------------------------------------------------------

type ScaffoldResult =
  | { readonly status: "created"; readonly files: readonly string[] }
  | { readonly status: "rejected"; readonly message: string };

export const scaffoldPackage = ({
  name,
  description,
  root,
}: ScaffoldOptions): ScaffoldResult => {
  if (!KEBAB_CASE.test(name)) {
    return {
      status: "rejected",
      message: `package name ${JSON.stringify(name)} must be kebab-case (a-z, 0-9, single hyphens)`,
    };
  }

  const rel = `${PACKAGE_PREFIX}${name}`;
  const dir = path.join(root, rel);
  if (existsSync(dir)) {
    return { status: "rejected", message: `${rel} already exists` };
  }

  const knipPath = path.join(root, KNIP_REL);
  if (!existsSync(knipPath)) {
    return {
      status: "rejected",
      message: `${KNIP_REL} not found under ${root}`,
    };
  }

  // Compute the knip edit before touching the filesystem: an unsupported
  // layout must leave no half-scaffolded package behind.
  const insertion = insertKnipWorkspace(readFileSync(knipPath, "utf-8"), name);
  if (insertion.status === "unsupported") {
    return { status: "rejected", message: insertion.message };
  }

  const files = [
    {
      rel: `${rel}/package.json`,
      content: packageJsonTemplate({ name, description }),
    },
    { rel: `${rel}/tsconfig.json`, content: TSCONFIG_TEMPLATE },
    { rel: `${rel}/src/index.ts`, content: INDEX_TEMPLATE },
    { rel: `${rel}/README.md`, content: readmeTemplate({ name, description }) },
  ];

  mkdirSync(path.join(dir, "src"), { recursive: true });
  for (const file of files) {
    writeFileSync(path.join(root, file.rel), file.content);
  }
  writeFileSync(knipPath, insertion.text);

  return {
    status: "created",
    files: [...files.map((file) => file.rel), KNIP_REL],
  };
};

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.status === "error") {
    console.error(`new-package: ${parsed.message}`);
    process.exit(1);
  }
  const result = scaffoldPackage(parsed);
  if (result.status === "rejected") {
    console.error(`new-package: ${result.message}`);
    process.exit(1);
  }
  for (const file of result.files) {
    console.log(`  ${file}`);
  }
  console.log(
    [
      "",
      "Next:",
      "  1. bun install",
      `  2. add "@stll/${parsed.name}": "workspace:*" to every consuming package.json`,
      `  3. move the code into packages/${parsed.name}/src and export it from src/index.ts`,
      "  4. bun run lint:ws",
    ].join("\n"),
  );
}
