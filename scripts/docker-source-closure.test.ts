import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  commandEntries,
  checkDockerSource,
  copySource,
  dockerInstructions,
  dockerPruneScopes,
  inDockerContext,
  sourceClosureProblems,
  type SourceTree,
} from "./docker-source-closure";

const root = mkdtempSync(path.join(tmpdir(), "docker-source-fixtures-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (file: string, source: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), source);
  return file;
};
const tree = (files: readonly string[]): SourceTree =>
  new Map(files.map((file) => [`/app/${file}`, file]));

describe("Docker source closure", () => {
  test("checks the sandbox install and cache commands without hiding source runners", () => {
    const source = readFileSync(
      new URL(
        "../packages/agent-engine/docker/sandbox.Dockerfile",
        import.meta.url,
      ),
      "utf-8",
    );
    expect(checkDockerSource(root, source, new Map(), new Map())).toEqual([]);
    expect(
      checkDockerSource(
        root,
        `${source}\nRUN bun absent.ts`,
        new Map(),
        new Map(),
      ),
    ).toEqual(["Entry is unavailable: /workspace/absent.ts"]);
    for (const command of [
      "npm cache clean",
      "npm cache clean --force extra",
      "npm cache clean --force --prefix scripts",
      "npm cache verify",
      'npm "cache clean --force"',
    ]) {
      expect(() => commandEntries(root, new Map(), command, "/app")).toThrow(
        "Unsupported source runner: npm",
      );
    }
  });
  test("keeps commands after comment lines in a continued instruction", () => {
    for (const newline of ["\n", "\r\n"]) {
      expect(
        dockerInstructions(
          ["RUN bun first.ts \\", "  # comment", "  && bun second.ts"].join(
            newline,
          ),
        ),
      ).toEqual(["RUN bun first.ts    && bun second.ts"]);
    }
  });

  test("copies multiple source contents into one destination", () => {
    const entry = put("multi-copy/apps/entry.ts", 'import "./dependency";');
    const dependency = put(
      "multi-copy/packages/dependency.ts",
      "export const value = 1;",
    );
    const asset = put("multi-copy/data.json", "{}");
    const context: SourceTree = new Map([
      ["/apps/entry.ts", entry],
      ["/packages/dependency.ts", dependency],
      ["/data.json", asset],
    ]);
    const dockerfile =
      "FROM bun AS builder\nWORKDIR /app\nCOPY apps packages data.json ./\nRUN bun entry.ts";
    expect(checkDockerSource(root, dockerfile, context, new Map())).toEqual([]);
    expect(() =>
      checkDockerSource(
        root,
        dockerfile.replace("./", "destination"),
        context,
        new Map(),
      ),
    ).toThrow("Multiple COPY sources require a directory destination");
    expect(
      checkDockerSource(
        root,
        dockerfile.replace("bun entry.ts", "bun apps/entry.ts"),
        context,
        new Map(),
      ),
    ).toEqual(["Entry is unavailable: /app/apps/entry.ts"]);
  });

  test("checks builds following installs in the same instruction", () => {
    const entry = put("after-install/entry.ts", 'import "./missing";');
    const context: SourceTree = new Map([["/entry.ts", entry]]);
    for (const install of [
      "bun install --frozen-lockfile",
      "bun i",
      "bun add example",
    ]) {
      const source = `FROM bun AS builder\nWORKDIR /app\nCOPY . .\nRUN ${install} && bun entry.ts`;
      expect(checkDockerSource(root, source, context, new Map())).toEqual([
        `${entry} imports ./missing, unavailable in Docker stage`,
      ]);
    }
  });

  test("runs after source hydration in the installed light job with a fixed total budget", () => {
    const workflow = v.parse(
      v.object({
        jobs: v.object({
          "ci-checks-rest": v.object({
            steps: v.array(
              v.object({
                name: v.optional(v.string()),
                run: v.optional(v.string()),
                if: v.optional(v.string()),
                "timeout-minutes": v.optional(v.number()),
              }),
            ),
          }),
        }),
      }),
      Bun.YAML.parse(
        readFileSync(
          new URL("../.github/workflows/ci.yml", import.meta.url),
          "utf-8",
        ),
      ),
    );
    const steps = workflow.jobs["ci-checks-rest"].steps;
    const restore = steps.findIndex((step) =>
      step.run?.includes("ci-generated-sources.ts restore"),
    );
    const guard = steps.findIndex(
      (step) => step.name === "Check Docker source closure",
    );
    expect(restore).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(restore);
    expect(steps[guard]?.if).toContain("steps.install.outcome == 'success'");
    expect(steps[guard]?.if).toContain("package_checks_required == 'true'");
    expect(steps[guard]?.["timeout-minutes"]).toBe(1);
    expect(steps[guard]?.run).toBe(
      "timeout 30s bash -c 'bun test scripts/docker-source-closure.test.ts && bun scripts/docker-source-closure.ts'",
    );
  });

  test("rejects the omitted root helper even when it exists in the checkout", () => {
    const helper = "packages/scripts/src/prepared-generated-sources.ts";
    const actual = readFileSync(
      new URL(`../${helper}`, import.meta.url),
      "utf-8",
    );
    put(
      helper,
      actual.replace(
        '"./generated-files"',
        '"../../../scripts/generated-files"',
      ),
    );
    put("scripts/generated-files.ts", "export const CI_GENERATED_FILES = [];");
    const available = tree([helper]);
    expect(sourceClosureProblems(root, available, [`/app/${helper}`])).toEqual([
      `${helper} imports ../../../scripts/generated-files, unavailable in Docker stage`,
    ]);
    available.set(
      "/app/scripts/generated-files.ts",
      "scripts/generated-files.ts",
    );
    expect(sourceClosureProblems(root, available, [`/app/${helper}`])).toEqual(
      [],
    );
  });

  test("follows transitive and dynamic literal imports with cycles", () => {
    const files = [
      put("cycle/a.ts", 'import "./b"; import("./dynamic");'),
      put("cycle/b.ts", 'export * from "./a"; import "./missing.json";'),
      put("cycle/dynamic.ts", 'import "./b";'),
    ];
    expect(
      sourceClosureProblems(root, tree(files), ["/app/cycle/a.ts"]),
    ).toEqual([
      "cycle/b.ts imports ./missing.json, unavailable in Docker stage",
    ]);
  });

  test("removing any discovered source leaf makes the closure fail", () => {
    const leaves = Array.from({ length: 8 }, (_, index) =>
      put(`enumerated/leaf-${index}.ts`, "export const value = 1;"),
    );
    const entry = put(
      "enumerated/entry.ts",
      leaves.map((_, index) => `export * from "./leaf-${index}";`).join("\n"),
    );
    const sources = tree([entry, ...leaves]);
    expect(
      sourceClosureProblems(root, sources, ["/app/enumerated/entry.ts"]),
    ).toEqual([]);
    for (const leaf of leaves) {
      const missing = new Map(sources);
      missing.delete(`/app/${leaf}`);
      expect(
        sourceClosureProblems(root, missing, ["/app/enumerated/entry.ts"]),
      ).toHaveLength(1);
    }
  });

  test("type-only imports do not enter a runtime closure", () => {
    const file = put(
      "types.ts",
      'import type { A } from "./absent"; import { type B } from "./absent"; export type { C } from "./absent";',
    );
    expect(
      sourceClosureProblems(root, tree([file]), ["/app/types.ts"]),
    ).toEqual([]);
  });

  test("declarations cannot satisfy a runtime source import", () => {
    const config = put(
      "apps/declarations/tsconfig.json",
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
    );
    const declaration = put(
      "apps/declarations/src/declared.d.ts",
      "export declare const value: number;",
    );
    for (const [index, specifier] of [
      "./declared",
      "./declared.js",
      "@/declared",
    ].entries()) {
      const entry = put(
        `apps/declarations/src/entry-${index}.ts`,
        `import "${specifier}";`,
      );
      expect(
        sourceClosureProblems(root, tree([config, declaration, entry]), [
          `/app/${entry}`,
        ]),
      ).toEqual([`${entry} imports ${specifier}, unavailable in Docker stage`]);
    }
  });

  test("resolves aliases using only stage sources", () => {
    const files = [
      put(
        "apps/example/tsconfig.json",
        JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      ),
      put("apps/example/src/a.ts", 'import "@/b";'),
      put("apps/example/src/b.ts", "export const b = 1;"),
    ];
    expect(
      sourceClosureProblems(root, tree(files), ["/app/apps/example/src/a.ts"]),
    ).toEqual([]);
    expect(
      sourceClosureProblems(root, tree(files.slice(0, 2)), [
        "/app/apps/example/src/a.ts",
      ]),
    ).toHaveLength(1);
  });

  test("retains the declaration directory of inherited aliases", () => {
    const files = [
      put(
        "apps/inherited/tsconfig.json",
        JSON.stringify({
          compilerOptions: { paths: { "@/app/*": ["./src/*"] } },
        }),
      ),
      put(
        "apps/inherited/scripts/tsconfig.json",
        JSON.stringify({ extends: "../tsconfig.json" }),
      ),
      put("apps/inherited/scripts/entry.ts", 'import "@/app/value";'),
      put("apps/inherited/src/value.ts", "export const value = 1;"),
    ];
    expect(
      sourceClosureProblems(root, tree(files), [
        "/app/apps/inherited/scripts/entry.ts",
      ]),
    ).toEqual([]);
  });

  test("checks Vite worker sources and imported assets", () => {
    const files = [
      put(
        "worker-entry.ts",
        'import "./worker?worker&url"; import "./data.txt?raw";',
      ),
      put("worker.ts", 'import "./missing";'),
      put("data.txt", "asset"),
    ];
    expect(
      sourceClosureProblems(root, tree(files), ["/app/worker-entry.ts"]),
    ).toEqual(["worker.ts imports ./missing, unavailable in Docker stage"]);
  });

  test("resolves a workspace export without checkout symlinks", () => {
    const files = [
      put(
        "packages/example/package.json",
        JSON.stringify({
          name: "@stll/example",
          exports: { ".": "./src/index.ts" },
        }),
      ),
      put("packages/example/src/index.ts", 'export * from "./absent";'),
      put("workspace-entry.ts", 'import "@stll/example";'),
    ];
    expect(
      sourceClosureProblems(root, tree(files), ["/app/workspace-entry.ts"]),
    ).toEqual([
      "packages/example/src/index.ts imports ./absent, unavailable in Docker stage",
    ]);
  });

  test("applies dockerignore to ancestors, recursive globs and ordered exclusions", () => {
    const ignore = "node_modules\n**/dist\n*.md\n!README.md\n**/*.test.ts\n";
    for (const file of [
      "node_modules/x/a.ts",
      "apps/a/dist/index.js",
      "NOTES.md",
      "apps/a/src/a.test.ts",
    ]) {
      expect(inDockerContext(file, ignore)).toBe(false);
    }
    for (const file of [
      "README.md",
      "apps/a/README.md",
      "apps/a/src/index.ts",
    ]) {
      expect(inDockerContext(file, ignore)).toBe(true);
    }
  });

  test("copies directory contents and files into their stage destination", () => {
    const source = tree(["a/index.ts", "a/sub/data.json"]);
    const destination: SourceTree = new Map();
    copySource(source, destination, "/app/a/", "/app/copied/");
    expect([...destination.keys()]).toEqual([
      "/app/copied/index.ts",
      "/app/copied/sub/data.json",
    ]);
    copySource(source, destination, "/app/a/index.ts", "/app/direct/");
    expect(destination.get("/app/direct/index.ts")).toBe("a/index.ts");
    expect(() =>
      copySource(source, destination, "/app/absent", "/app/"),
    ).toThrow("unavailable");
  });

  test("checks a consumer after its actual pruned COPY, not the full context", () => {
    const entry = put("stage-entry.ts", 'import "./root-helper";');
    const helper = put("root-helper.ts", "export const value = 1;");
    const context: SourceTree = new Map([
      ["/stage-entry.ts", entry],
      ["/root-helper.ts", helper],
    ]);
    const pruned = tree([entry]);
    const dockerfile =
      "FROM bun AS pruner\nWORKDIR /app\nCOPY . .\nRUN turbo prune @stll/example --docker\nFROM bun AS builder\nWORKDIR /app\nCOPY --from=pruner /app/out/full/ .\nRUN bun stage-entry.ts";
    expect(checkDockerSource(root, dockerfile, context, pruned)).toEqual([
      "stage-entry.ts imports ./root-helper, unavailable in Docker stage",
    ]);
    pruned.set("/app/root-helper.ts", helper);
    expect(checkDockerSource(root, dockerfile, context, pruned)).toEqual([]);
  });

  test("derives actual prune scopes and rejects unrecognized forms", () => {
    const source = readFileSync(
      new URL("../apps/api/Dockerfile", import.meta.url),
      "utf-8",
    );
    expect(dockerPruneScopes(source)).toEqual([
      ["@stll/api", "@stll/collab", "@stll/legal-atlas-runner"],
    ]);
    expect(dockerInstructions("# comment\nRUN bun build \\\n a.ts")).toEqual([
      "RUN bun build   a.ts",
    ]);
    expect(() => dockerPruneScopes("RUN turbo prune $SCOPE --docker")).toThrow(
      "Unsupported",
    );
    expect(() => dockerInstructions("RUN <<EOF\nx\nEOF")).toThrow(
      "Unsupported",
    );
    expect(dockerPruneScopes("run turbo prune @stll/example --docker")).toEqual(
      [["@stll/example"]],
    );
  });

  test("expands the named build script and nested generator", () => {
    const files = [
      put(
        "apps/commands/package.json",
        JSON.stringify({
          name: "@stll/commands",
          scripts: {
            build:
              "bun run generate && bun build --target=bun --outfile=dist/app.js src/index.ts",
            generate: "bun scripts/generate.ts",
          },
        }),
      ),
    ];
    expect(
      commandEntries(
        root,
        tree(files),
        "bun --filter @stll/commands build",
        "/app",
      ),
    ).toEqual([
      "/app/apps/commands/scripts/generate.ts",
      "/app/apps/commands/src/index.ts",
    ]);
    expect(
      commandEntries(
        root,
        tree(files),
        "cd apps/commands && bun src/main.ts",
        "/app",
      ),
    ).toEqual(["/app/apps/commands/src/main.ts"]);
    expect(() =>
      commandEntries(root, tree(files), "bun $ENTRY", "/app"),
    ).toThrow("Unsupported");
    expect(() =>
      commandEntries(
        root,
        tree(files),
        "bun --cwd=elsewhere src/main.ts",
        "/app",
      ),
    ).toThrow("Unsupported Bun flag");
    expect(
      commandEntries(
        root,
        tree(files),
        "bun --filter @stll/commands build && bun root.ts",
        "/app",
      ).at(-1),
    ).toBe("/app/root.ts");
    expect(
      commandEntries(
        root,
        tree(files),
        "(cd apps/commands && bun src/main.ts) && bun root.ts",
        "/app",
      ),
    ).toEqual(["/app/apps/commands/src/main.ts", "/app/root.ts"]);
  });
});
