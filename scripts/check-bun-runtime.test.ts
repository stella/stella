import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  dockerCmdRuntime,
  type Launch,
  launches,
  packageExecutables,
  scanRepository,
} from "./check-bun-runtime";

const ROOT = path.resolve(import.meta.dir, "..");
const PACKAGE_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  ".": ["build", "generate", "knip"],
  "apps/web": ["dev", "vite"],
};
const EXECUTABLES = new Set(["vite", "playwright", "tsdown", "knip"]);
const context = {
  executables: EXECUTABLES,
  onPath: EXECUTABLES,
  scriptsIn: (directory: string) => new Set(PACKAGE_SCRIPTS[directory]),
  directory: ".",
};

const node = (program: string): Launch => ({ program, runs: "node" });
const bun = (program: string): Launch => ({ program, runs: "bun" });
const cases: [string, Launch[]][] = [
  ["vite dev", [node("vite")]],
  ["bun --bun vite dev", [bun("vite")]],
  ["bun -b vite dev", [bun("vite")]],
  ["bun run --bun vite build", [bun("vite")]],
  ["bun run vite build", [node("vite")]],
  ["bun vite build", [node("vite")]],
  ["bunx playwright test", [node("playwright")]],
  ["bunx --bun playwright test", [bun("playwright")]],
  ["bun x tsdown", [node("tsdown")]],
  ["bun x --bun tsdown", [bun("tsdown")]],
  ["node scripts/build.mjs", [node("node")]],
  ["npx tsdown", [node("npx")]],
  ['cd ../.. && FORCE=1 exec vite build --mode "$MODE"', [node("vite")]],
  [
    '([ -n "$TURBO_HASH" ] || bun run generate) && bun --bun vite dev',
    [bun("vite")],
  ],
  ['echo "$(vite --version)"', [node("vite")]],
  ["bun run build", []],
  ["bun run knip", []],
  ["bun --bun knip", [{ program: "knip", runs: "script" }]],
  ["bunx --bun knip", [bun("knip")]],
  ["bun --filter @stll/web vite", []],
  ["bunx --no-install --bun vite --version", [bun("vite")]],
  ["bunx --no-install vite --version", [node("vite")]],
  ["bunx -p vite --bun vite", [bun("vite")]],
  ["bun --cwd apps/api vite --version", [node("vite")]],
  ["bun --cwd=apps/api --bun vite", [bun("vite")]],
  ["bun run --cwd apps/web vite", []],
  ["bun --cwd apps/web --bun vite", [{ program: "vite", runs: "script" }]],
  ['bun --cwd "$PACKAGE" vite', []],
  ["cd apps/web && bun run vite", []],
  ["cd apps/api && bun vite", [node("vite")]],
  ["(cd apps/web && bun run vite) && bun vite", [node("vite")]],
  ["bun --preload ./setup.ts scripts/run.ts", []],
  ["bun test src", []],
  ["cargo build && git status", []],
];

for (const [command, expected] of cases) {
  test(command, () => {
    expect(launches(command, context)).toEqual(expected);
  });
}

const writeRepo = (files: Record<string, string>): string => {
  const root = mkdtempSync(path.join(tmpdir(), "bun-runtime-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
};

const manifest = (scripts: Record<string, string>, extra = {}) =>
  `${JSON.stringify({ name: "fixture", ...extra, scripts }, null, 2)}\n`;

const LOCKFILE = `{ "packages": { "vite": ["vite@8.0.0", "", { "bin": { "vite": "bin/vite.js" } }, "sha512-"] } }\n`;

const scan = (
  files: Record<string, string>,
  exceptions: Readonly<Record<string, string>> = {},
) => {
  const root = writeRepo({
    "bun.lock": LOCKFILE,
    "package.json": manifest({}),
    "apps/.keep": "",
    "packages/.keep": "",
    ...files,
  });
  try {
    return scanRepository(root, { exceptions, files: Object.keys(files) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const located = (result: ReturnType<typeof scan>) =>
  result.findings.map(
    ({ file, line, where, program, runs }) =>
      `${file}:${line} ${where} ${program} ${runs}`,
  );

test("finds package scripts that start executables on Node, with their lines", () => {
  const root = writeRepo({
    "bun.lock": LOCKFILE,
    "package.json": manifest({ build: "turbo build" }),
    "apps/web/package.json": manifest({
      dev: "bun --bun vite dev",
      build: "vite build",
      cli: "own-cli --help",
    }),
    "packages/tool/package.json": manifest(
      { start: "own-cli" },
      { bin: { "own-cli": "src/cli.ts", "bun-cli": "src/bun-cli.ts" } },
    ),
    "packages/tool/src/cli.ts": "#!/usr/bin/env node\n",
    "packages/tool/src/bun-cli.ts": "#!/usr/bin/env bun\n",
  });
  try {
    expect([...packageExecutables(root)].toSorted()).toEqual([
      "own-cli",
      "vite",
    ]);
    expect(
      located(scanRepository(root, { exceptions: {}, files: [] })),
    ).toEqual([
      "apps/web/package.json:5 scripts.build vite node",
      "apps/web/package.json:6 scripts.cli own-cli node",
      "packages/tool/package.json:8 scripts.start own-cli node",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finds Node launches in shell scripts, naming only explicit starts", () => {
  expect(
    located(
      scan({
        "scripts/run.sh": [
          "#!/usr/bin/env bash",
          "# node in a comment",
          'cd "$ROOT"',
          "vite build",
          "node scripts/x.mjs",
          "bun --bun vite build",
          "bunx --bun tsdown",
          "./node_modules/.bin/vite --version",
          '"$PODS_ROOT/scripts/with-node.sh" bundle.mjs',
          "case $mode in vite) ;; esac",
          "/usr/bin/node scripts/y.mjs",
          "node scripts/x.mjs",
        ].join("\n"),
      }),
    ),
  ).toEqual([
    "scripts/run.sh:5 script node node",
    "scripts/run.sh:8 script vite node",
    "scripts/run.sh:9 script with-node.sh node",
    "scripts/run.sh:11 script node node",
    "scripts/run.sh:12 script node node",
  ]);
});

test("finds Node in workflow steps and setups, outside PowerShell steps", () => {
  const workflow = `name: fixture
jobs:
  check:
    runs-on: ubuntu-24.04
    steps:
      - name: Set up Node
        uses: actions/setup-node@0000000000000000000000000000000000000000
      - name: Run
        run: |
          echo "\${{ github.sha }}"
          node scripts/x.mjs
          node scripts/x.mjs --again
      - name: Run on Bun
        run: bun scripts/x.mjs && bunx --bun --no-install wxt prepare
      - name: Fetch
        run: bunx --no-install wxt prepare
  windows:
    runs-on: windows-2025
    steps:
      - name: Record versions
        run: node --version
`;
  expect(located(scan({ ".github/workflows/fixture.yml": workflow }))).toEqual([
    ".github/workflows/fixture.yml:7 job check: Set up Node setup-node node",
    ".github/workflows/fixture.yml:11 job check: Run node node",
    ".github/workflows/fixture.yml:12 job check: Run node node",
    ".github/workflows/fixture.yml:16 job check: Fetch wxt node",
  ]);
});

test("finds spawned Node commands and Playwright web servers", () => {
  // A fixture file, so this test's source spawns nothing the guard reads.
  const source = readFileSync(
    path.join(import.meta.dir, "__fixtures__/bun-runtime/spawn.ts.txt"),
    "utf-8",
  );
  const config = `export default { webServer: { command: "vite --port 4174" } };\n`;
  expect(
    located(
      scan({
        "package.json": manifest({}),
        "scripts/spawn.ts": source,
        "scripts/playwright.config.ts": config,
        "scripts/tool.mjs": "#!/usr/bin/env node\n",
      }),
    ),
  ).toEqual([
    "scripts/spawn.ts:2 spawn node node",
    "scripts/spawn.ts:3 spawn turbo node",
    "scripts/spawn.ts:5 spawn tsdown node",
    "scripts/spawn.ts:10 spawn vite node",
    "scripts/spawn.ts:11 spawn vite node",
    "scripts/spawn.ts:12 spawn npm node",
    "scripts/playwright.config.ts:1 webServer.command vite node",
    "scripts/tool.mjs:1 shebang node node",
  ]);
});

test("an exception covers one launch and fails once nothing needs it", () => {
  const files = {
    "package.json": manifest({ start: "node server.mjs" }),
  };
  expect(
    scan(files, {
      "package.json: scripts.start: node": "fails on Bun",
      "package.json: scripts.dev: node": "unused",
    }),
  ).toEqual({
    findings: [],
    unusedExceptions: ["package.json: scripts.dev: node"],
  });
});

test("the web dev server starts on the runtime the web image serves on", () => {
  const runtime = dockerCmdRuntime(
    readFileSync(path.join(ROOT, "apps/web/Dockerfile"), "utf-8"),
  );
  const { scripts } = v.parse(
    v.object({ scripts: v.record(v.string(), v.string()) }),
    JSON.parse(readFileSync(path.join(ROOT, "apps/web/package.json"), "utf-8")),
  );
  const executables = packageExecutables(ROOT);
  const dev = launches(scripts["dev"] ?? "", {
    executables,
    onPath: executables,
    scriptsIn: () => new Set(Object.keys(scripts)),
    directory: "apps/web",
  });
  expect(dev.map(({ program, runs }) => [program, runs])).toEqual([
    ["vite", runtime],
  ]);
});

test("the image runtime is read from the last exec-form CMD", () => {
  expect(
    dockerCmdRuntime(
      'FROM a AS build\nCMD ["deno", "x.js"]\nFROM b\nCMD ["bun", "dist/runtime.js"]\n',
    ),
  ).toBe("bun");
  expect(() => dockerCmdRuntime("FROM a\nCMD bun x.js\n")).toThrow(
    "Dockerfile has no exec-form CMD",
  );
});
