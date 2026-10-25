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

import { listApiTestPaths } from "../apps/api/scripts/api-test-plan";
import {
  analyzeModule,
  API_ALL_RULES,
  API_SHARD_SECONDS,
  buildImportGraph,
  selectApiTestImpact,
} from "./api-test-impact";
import { API_TEST_SHARD_IDS } from "./api-test-shard-plan";
import { workflowJobSteps } from "./workflow-steps";

const withRepository = (
  run: (root: string, write: (file: string, text: string) => void) => void,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "api-impact-"));
  const write = (file: string, text: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  try {
    write(
      "turbo.json",
      JSON.stringify({
        tasks: { "@stll/api#test": { inputs: ["$TURBO_DEFAULT$"] } },
      }),
    );
    write("apps/api/package.json", JSON.stringify({ name: "@stll/api" }));
    write("apps/web/x.tsx", "export const x = true;");
    write("apps/landing/y.astro", "<main />");
    write("apps/api/src/tests/setup-env.ts", 'import "./preload-helper";');
    write("apps/api/src/tests/preload-helper.ts", "export const setup = true;");
    write(
      "apps/api/src/handler.ts",
      'export { value } from "@stll/example/feature";',
    );
    write("apps/api/src/handler.test.ts", 'import "./handler";');
    write("apps/api/src/unrelated.test.ts", "export const test = true;");
    write(
      "packages/example/package.json",
      JSON.stringify({
        name: "@stll/example",
        exports: { "./*": { import: "./src/*.ts" } },
      }),
    );
    write("packages/example/src/feature.ts", "export const value = true;");
    run(root, write);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("runtime imports select a handler test, a changed test itself and workspace package importers", () => {
  withRepository((root) => {
    for (const changed of [
      "apps/api/src/handler.ts",
      "apps/api/src/handler.test.ts",
      "packages/example/src/feature.ts",
    ]) {
      expect(
        selectApiTestImpact({ root, changed: [changed] }),
        changed,
      ).toEqual({
        mode: "selected",
        files: ["src/handler.test.ts"],
        shards: 1,
      });
    }
    expect(
      selectApiTestImpact({ root, changed: ["apps/web/src/screen.tsx"] }),
    ).toEqual({ mode: "none", files: [], shards: 0 });
    expect(selectApiTestImpact({ root, changed: [] }).mode).toBe("none");
  });
});

const ruleCases = {
  manifest: "packages/example/package.json",
  lockfile: "bun.lock",
  typescript: "packages/example/tsconfig.build.json",
  bun: "apps/api/bunfig.toml",
  npm: ".npmrc",
  turbo: "turbo.json",
  patches: "patches/example.patch",
  github: ".github/workflows/ci.yml",
  migrations: "apps/api/drizzle/next/migration.sql",
  database: "apps/api/src/db/schema/table.ts",
  runner: "apps/api/scripts/run-tests.ts",
  selector: "scripts/api-test-impact.ts",
  environment: "apps/api/.env.example",
  postgres: "docker/postgres/init.sql",
  data: "packages/example/fixtures/example.html",
} satisfies Record<keyof typeof API_ALL_RULES, string>;

test("every full-suite rule widens a readable graph", () => {
  expect(Object.keys(ruleCases).toSorted()).toEqual(
    Object.keys(API_ALL_RULES).toSorted(),
  );
  withRepository((root, write) => {
    expect(selectApiTestImpact({ root, changed: [] }).mode).toBe("none");
    for (const name of Object.keys(API_ALL_RULES)) {
      const rule = Reflect.get(API_ALL_RULES, name);
      const file: string = Reflect.get(ruleCases, name);
      expect(rule.test(file), name).toBe(true);
      if (file.endsWith(".ts")) {
        write(file, "export const value = true;");
      }
      expect(selectApiTestImpact({ root, changed: [file] }), name).toEqual({
        mode: "all",
        files: [],
        shards: API_TEST_SHARD_IDS.length,
      });
    }
    for (const file of [
      "apps/api/src/fixtures/data.json",
      "apps/api/rules.yar",
      "scripts/test-scope.ts",
      "scripts/test-shards.ts",
      "scripts/ci-api-test-plan.ts",
    ]) {
      if (file.endsWith(".ts")) {
        write(file, "export const value = true;");
      }
      expect(selectApiTestImpact({ root, changed: [file] }).mode, file).toBe(
        "all",
      );
    }
  });
});

test("only GitHub readers used to execute API tests widen the suite", () => {
  const githubRule = API_ALL_RULES.github;
  for (const file of [
    ".github/workflows/ci.yml",
    ".github/actions/ci-install/action.yml",
    ".github/actions/ci-install/install.ts",
  ]) {
    expect(githubRule.test(file), file).toBe(true);
  }
  for (const file of [
    ".github/workflows/pr-lint.yml",
    ".github/ci-event-policy.json",
    ".github/ci-checks/ci-checks-policy.yml",
    ".github/CODEOWNERS",
    ".github/ISSUE_TEMPLATE/bug.yml",
  ]) {
    expect(githubRule.test(file), file).toBe(false);
  }
});

test("every local action used by API-running jobs is an API suite reader", () => {
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf-8",
    ),
  );
  const localActions = ["ci-tests", "postgres-service-suites"]
    .flatMap((job) => workflowJobSteps(workflow, job))
    .map((step) => step["uses"])
    .filter(
      (uses): uses is string =>
        typeof uses === "string" &&
        (uses.startsWith("./.github/actions/") ||
          uses.startsWith("$/.github/actions/")),
    )
    .map((uses) => uses.replace(/^(?:\$|\.)\//u, ""));

  expect(localActions.length).toBeGreaterThan(0);
  expect(
    localActions.filter((action) => !API_ALL_RULES.github.test(action)),
  ).toEqual([]);
});

test("preload dependencies always widen, while erased type imports do not select runtime tests", () => {
  withRepository((root, write) => {
    expect(
      selectApiTestImpact({
        root,
        changed: ["apps/api/src/tests/preload-helper.ts"],
      }).mode,
    ).toBe("all");
    write("apps/api/src/erased.ts", "export type Shape = string;");
    write(
      "apps/api/src/type.test.ts",
      'import type { Shape } from "./erased"; const value: Shape = "ok";',
    );
    expect(
      selectApiTestImpact({ root, changed: ["apps/api/src/erased.ts"] }).mode,
    ).toBe("none");
  });
});

test("readers widen another app only when their paths can reach it", () => {
  withRepository((root, write) => {
    write(
      "apps/api/src/web-reader.ts",
      'import { readFileSync } from "node:fs"; export const data = readFileSync("apps/web/x.tsx");',
    );
    write("apps/api/src/web-reader.test.ts", 'import "./web-reader";');
    write(
      "apps/api/src/root-reader.ts",
      'import { readdirSync } from "node:fs"; export const files = readdirSync(process.cwd());',
    );
    write("apps/api/src/root-reader.test.ts", 'import "./root-reader";');
    write(
      "apps/api/src/api-reader.ts",
      'import { readFileSync } from "node:fs"; export const data = readFileSync("apps/api/rules.yar");',
    );
    write("apps/api/src/api-reader.test.ts", 'import "./api-reader";');
    write("apps/api/src/z.ts", "export const z = true;");
    write("packages/p/q.ts", "export const q = true;");
    expect(
      selectApiTestImpact({ root, changed: ["apps/web/x.tsx"] }).files,
    ).toEqual(["src/root-reader.test.ts", "src/web-reader.test.ts"]);
    expect(
      selectApiTestImpact({ root, changed: ["apps/landing/y.astro"] }).files,
    ).toEqual(["src/root-reader.test.ts"]);
    for (const changed of ["apps/api/src/z.ts", "packages/p/q.ts"]) {
      expect(selectApiTestImpact({ root, changed: [changed] }).files).toEqual([
        "src/api-reader.test.ts",
        "src/root-reader.test.ts",
        "src/web-reader.test.ts",
      ]);
    }
  });
});

test("another app is selected from text anywhere in a reader closure", () => {
  withRepository((root, write) => {
    write("apps/api/src/path.ts", 'export const target = "apps/web/x.tsx";');
    write(
      "apps/api/src/computed-reader.ts",
      'import { readFileSync } from "node:fs"; export const read = (target: string) => readFileSync(target);',
    );
    write(
      "apps/api/src/computed-reader.test.ts",
      'import "./path"; import "./computed-reader";',
    );
    expect(
      selectApiTestImpact({ root, changed: ["apps/web/x.tsx"] }).files,
    ).toEqual(["src/computed-reader.test.ts"]);
  });
});

test("a root helper in another module and segment-built app paths reach another app", () => {
  withRepository((root, write) => {
    write("apps/api/src/root.ts", "export const root = process.cwd();");
    write(
      "apps/api/src/root-joined-reader.ts",
      'import path from "node:path"; import { readFileSync } from "node:fs"; import { root } from "./root"; export const read = () => readFileSync(path.join(root, "x.tsx"));',
    );
    write(
      "apps/api/src/root-joined-reader.test.ts",
      'import "./root-joined-reader";',
    );
    write(
      "apps/api/src/segment-reader.test.ts",
      'import path from "node:path"; import { readFileSync } from "node:fs"; readFileSync(path.join("apps", "web", "x.tsx"));',
    );
    expect(
      selectApiTestImpact({ root, changed: ["apps/web/x.tsx"] }).files,
    ).toEqual(["src/root-joined-reader.test.ts", "src/segment-reader.test.ts"]);
  });
});

test("a quoted app directory reaches that app", () => {
  withRepository((root, write) => {
    write(
      "apps/api/src/web-dir-scanner.test.ts",
      'import { readdirSync } from "node:fs"; readdirSync("apps/web");',
    );
    expect(
      selectApiTestImpact({ root, changed: ["apps/web/x.tsx"] }).files,
    ).toEqual(["src/web-dir-scanner.test.ts"]);
  });
});

test("caller-only readers do not reach another app", () => {
  withRepository((root, write) => {
    write(
      "apps/api/src/computed-reader.test.ts",
      'import { readFileSync } from "node:fs"; export const read = (target: string) => readFileSync(target);',
    );
    expect(
      selectApiTestImpact({ root, changed: ["apps/web/x.tsx"] }).mode,
    ).toBe("none");
  });
});

test("wildcard globs, repository climbs and analysis failures reach another app", () => {
  withRepository((root, write) => {
    const cases = {
      star: 'new Bun.Glob("apps/*/src/**/*.ts").scanSync();',
      brace: 'new Bun.Glob("apps/{web,api}/src/**/*.ts").scanSync();',
      starstar: 'new Bun.Glob("apps/**").scanSync();',
      starsuffix: 'new Bun.Glob("apps/web*/src/**/*.ts").scanSync();',
      slashclimb:
        'import path from "node:path"; import { readFileSync } from "node:fs"; readFileSync(path.join(import.meta.dir, "../", "../", "web", "x.tsx"));',
      template:
        // The fixture source holds a template literal; `$` and `{` are joined
        // so this file's own string is not mistaken for one.
        'import { readdirSync } from "node:fs"; const name = process.argv[2]; readdirSync(`apps/' +
        "$" +
        "{name}/src`);",
      nested:
        'import path from "node:path"; import { readFileSync } from "node:fs"; readFileSync(path.join(path.dirname(import.meta.path), "sub", "..", "..", "..", "web", "x.tsx"));',
      appsdir: 'import { readdirSync } from "node:fs"; readdirSync("apps/");',
      root: 'import path from "node:path"; import { readFileSync } from "node:fs"; readFileSync(path.join(import.meta.dir, "..", "..", ".."));',
      failed:
        'import "./missing"; import { readFileSync } from "node:fs"; readFileSync(target);',
    };
    for (const [name, source] of Object.entries(cases)) {
      write(`apps/api/src/${name}.test.ts`, source);
    }
    expect(
      selectApiTestImpact({ root, changed: ["apps/web/x.tsx"] }).files,
    ).toEqual([
      "src/appsdir.test.ts",
      "src/brace.test.ts",
      "src/failed.test.ts",
      "src/nested.test.ts",
      "src/root.test.ts",
      "src/slashclimb.test.ts",
      "src/star.test.ts",
      "src/starstar.test.ts",
      "src/starsuffix.test.ts",
      "src/template.test.ts",
    ]);
  });
});

test("relative import specifiers alone do not reach every app", () => {
  withRepository((root, write) => {
    write("lib/x.ts", "export const x = true;");
    write(
      "apps/api/src/import-reader.test.ts",
      'import "../../../lib/x"; import { readFileSync } from "node:fs"; readFileSync(target);',
    );
    expect(
      selectApiTestImpact({ root, changed: ["apps/web/x.tsx"] }).mode,
    ).toBe("none");
  });
});

test("parse errors, unresolved changed imports, deleted modules and selector exceptions fail closed", () => {
  withRepository((root, write) => {
    for (const text of ["export const = ;", 'import "./missing";']) {
      write("apps/api/src/handler.ts", text);
      expect(
        selectApiTestImpact({ root, changed: ["apps/api/src/handler.ts"] })
          .mode,
      ).toBe("all");
    }
    expect(
      selectApiTestImpact({ root, changed: ["apps/api/src/deleted.ts"] }).mode,
    ).toBe("all");
    expect(
      selectApiTestImpact({ root, changed: ["apps/api/src/handler.test.ts"] })
        .mode,
    ).toBe("selected");
  });
  expect(
    selectApiTestImpact({
      root: "/missing-repository",
      changed: ["apps/api/src/handler.ts"],
    }).mode,
  ).toBe("all");
});

test("an executable script with a shebang keeps a failure-strict plan selective", () => {
  withRepository((root, write) => {
    write(
      "apps/api/scripts/tool.ts",
      '#!/usr/bin/env bun\nimport { value } from "../src/handler";\nexport const tool = value;',
    );
    write("apps/api/scripts/tool.test.ts", 'import "./tool";');
    const plan = selectApiTestImpact({
      root,
      changed: ["apps/api/src/handler.ts"],
      graphFailurePolicy: "all",
    });
    expect(plan.mode).toBe("selected");
    expect(plan.files.toSorted()).toEqual([
      "scripts/tool.test.ts",
      "src/handler.test.ts",
    ]);
  });
});

test("prose about globs or directory reads does not make a module a scanner", () => {
  withRepository((root, write) => {
    write(
      "apps/api/src/handler.ts",
      '/** Glob matching every index; never readdir here. */\n// import(name) in prose\nexport const value = "ok";',
    );
    const plan = selectApiTestImpact({
      root,
      changed: ["packages/example/src/feature.ts"],
    });
    expect(plan.mode).toBe("none");
    write(
      "apps/api/src/handler.ts",
      'export const files = [...new Bun.Glob("*.json").scanSync()];',
    );
    expect(
      selectApiTestImpact({
        root,
        changed: ["packages/example/src/feature.ts"],
      }).files,
    ).toEqual(["src/handler.test.ts"]);
  });
});

test("every tracked API and workspace module is scannable by the import graph", () => {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "-z", "apps/api", "packages"],
    {
      cwd: path.resolve(import.meta.dir, ".."),
    },
  );
  expect(listed.exitCode).toBe(0);
  const modules = listed.stdout
    .toString()
    .split("\0")
    .filter(
      (file) =>
        /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file) && !file.endsWith(".d.ts"),
    );
  expect(modules.length).toBeGreaterThan(1000);
  const unscannable = modules.filter((file) => {
    try {
      analyzeModule(
        file,
        readFileSync(path.resolve(import.meta.dir, "..", file), "utf-8"),
      );
      return false;
    } catch {
      return true;
    }
  });
  expect(unscannable).toEqual([]);
}, 30_000);

test("computed loader calls are found through comments and escapes, literal ones are not", () => {
  const computed = (source: string) =>
    analyzeModule("module.ts", source).computedImports;
  expect(computed('export const load = () => import("./literal");')).toBe(
    false,
  );
  expect(computed('const loaded = require("./literal");')).toBe(false);
  expect(computed('import { value } from "./static";')).toBe(false);
  expect(computed("const load = (name) => import(name);")).toBe(true);
  expect(computed("const load = (name) => import /* x */ (name);")).toBe(true);
  expect(computed("const load = (name) => require // x\n(name);")).toBe(true);
  expect(computed("const load = (name) => \\u0072equire(name);")).toBe(true);
});

test("duration budgeting uses selected work only and never creates an empty shard", () => {
  withRepository((root, write) => {
    const durationPath = path.join(root, "duration-cache.json");
    for (const seconds of [
      0,
      API_SHARD_SECONDS,
      API_SHARD_SECONDS + 1,
      API_SHARD_SECONDS * 10,
    ]) {
      write("apps/api/src/second.test.ts", 'import "./handler";');
      write(
        "duration-cache.json",
        JSON.stringify({
          "src/handler.test.ts": { seconds, source: "measured" },
          "src/second.test.ts": { seconds: 0, source: "measured" },
          "src/unrelated.test.ts": { seconds: 10_000, source: "measured" },
        }),
      );
      expect(
        selectApiTestImpact({
          root,
          changed: ["apps/api/src/handler.ts"],
          durationPath,
        }).shards,
      ).toBe(seconds > API_SHARD_SECONDS ? 2 : 1);
    }
    for (let index = 0; index < 5; index++) {
      write(`apps/api/src/new-${index}.test.ts`, 'import "./handler";');
    }
    expect(
      selectApiTestImpact({
        root,
        changed: ["apps/api/src/handler.ts"],
        durationPath,
      }).shards,
    ).toBe(API_TEST_SHARD_IDS.length);
    write(
      "duration-cache.json",
      JSON.stringify({
        "src/handler.test.ts": { seconds: -1, source: "measured" },
      }),
    );
    expect(
      selectApiTestImpact({
        root,
        changed: ["apps/api/src/handler.ts"],
        durationPath: path.join(root, "duration-cache.json"),
      }).mode,
    ).toBe("selected");
  });
});

test("computed template imports and require calls retain their test importers", () => {
  withRepository((root, write) => {
    write(
      "apps/api/src/loader.ts",
      `export const load = (name: string) => import(\`./\${name}.ts\`);`,
    );
    write("apps/api/src/loader.test.ts", 'import "./loader";');
    write(
      "apps/api/src/require.test.ts",
      'const file = "./handler"; require(file);',
    );
    expect(
      selectApiTestImpact({ root, changed: ["apps/web/src/screen.tsx"] }).mode,
    ).toBe("none");
  });
});

// timeout: Two walks over the real repository graph; the limit only catches a hang.
// Their cost grows with the graph, the number of tests and the runner's load,
// so it is not a performance budget (the scan test above uses the same limit).
// Measured p95 is 18.6 s; this test must build the complete repository import graph.
test("the repository graph reaches real handler tests and workspace consumers", () => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "apps/api"], {
    cwd: path.resolve(import.meta.dir, ".."),
  });
  expect(listed.exitCode).toBe(0);
  const apiTestCount = listed.stdout
    .toString()
    .split("\0")
    .filter((file) => /\.test\.[cm]?[jt]sx?$/u.test(file)).length;
  expect(apiTestCount).toBeGreaterThan(100);
  const handler = selectApiTestImpact({
    changed: ["apps/api/src/handlers/case-law/provisions/response.ts"],
  });
  expect(handler.mode).toBe("selected");
  expect(handler.files).toContain(
    "src/handlers/case-law/provisions/response.test.ts",
  );
  const pkg = selectApiTestImpact({
    changed: ["packages/collation/src/index.ts"],
  });
  expect(pkg.mode).toBe("selected");
  expect(pkg.files).toContain("src/handlers/api-keys/list.db.test.ts");
  // A selector that returns every test must not pass as "selected".
  expect(handler.files.length).toBeLessThan(apiTestCount);
  expect(pkg.files.length).toBeLessThan(apiTestCount);
}, 40_000);

test("a real web change selects only tests with a web-reaching reader", () => {
  const repositoryRoot = path.resolve(import.meta.dir, "..");
  const selection = selectApiTestImpact({
    changed: ["apps/web/src/components/globe.tsx"],
  });
  expect(selection.mode).toBe("selected");
  // A share of the suite, not a count: the suite grows, and CI's tree also
  // holds generated modules. Before this rule a web change selected about
  // 41% of the API tests; a quarter is a generous ceiling over today's 14%.
  const suite = listApiTestPaths(path.join(repositoryRoot, "apps/api"));
  expect(selection.files.length).toBeLessThan(suite.length / 4);

  const tests = selection.files.map((file) => `apps/api/${file}`);
  const graph = buildImportGraph(repositoryRoot, tests);
  for (const testPath of tests) {
    expect(
      [...graph.closure(testPath)].some((file) => {
        const reach = graph.reaches.get(file);
        return reach === "all" || reach?.has("web") === true;
      }),
      testPath,
    ).toBe(true);
  }
}, 30_000);

test("selection is a deterministic union through cycles, duplicates and reordered changes", () => {
  withRepository((root, write) => {
    write(
      "packages/example/src/feature.ts",
      'import "./cycle"; export const value = true;',
    );
    write("packages/example/src/cycle.ts", 'import "./feature";');
    const paths = [
      "apps/api/src/handler.ts",
      "apps/api/src/unrelated.test.ts",
      "packages/example/src/cycle.ts",
    ];
    const subsets: string[][] = [[]];
    for (const file of paths) {
      for (const subset of [...subsets]) {
        subsets.push([...subset, file]);
      }
    }
    for (const changed of subsets) {
      const result = selectApiTestImpact({ root, changed });
      const expected = [
        ...(changed.some((file) => file !== "apps/api/src/unrelated.test.ts")
          ? ["src/handler.test.ts"]
          : []),
        ...(changed.includes("apps/api/src/unrelated.test.ts")
          ? ["src/unrelated.test.ts"]
          : []),
      ];
      expect(result.files).toEqual(expected);
      expect(result.mode).toBe(expected.length === 0 ? "none" : "selected");
      expect(
        selectApiTestImpact({
          root,
          changed: [...changed.toReversed(), ...changed],
        }),
      ).toEqual(result);
    }
  });
});

test("workspace fallback honors conditional export declaration order", () => {
  withRepository((root, write) => {
    write("packages/example/src/alternate.ts", "export const value = false;");
    write(
      "packages/example/package.json",
      JSON.stringify({
        name: "@stll/example",
        exports: {
          "./feature": {
            import: "./src/feature.ts",
            bun: "./src/alternate.ts",
          },
        },
      }),
    );
    expect(
      selectApiTestImpact({
        root,
        changed: ["packages/example/src/feature.ts"],
      }).files,
    ).toEqual(["src/handler.test.ts"]);
    expect(
      selectApiTestImpact({
        root,
        changed: ["packages/example/src/alternate.ts"],
      }).mode,
    ).toBe("none");
  });
});

test("every declared external API test input widens a readable graph", () => {
  const repositoryRoot = path.resolve(import.meta.dir, "..");
  const turbo = v.parse(
    v.object({
      tasks: v.object({
        "@stll/api#test": v.object({ inputs: v.array(v.string()) }),
      }),
    }),
    Bun.JSONC.parse(
      readFileSync(path.join(repositoryRoot, "turbo.json"), "utf-8"),
    ),
  );
  const inputs: string[] = turbo.tasks["@stll/api#test"].inputs;
  expect(inputs.length).toBeGreaterThan(1);
  withRepository((root, write) => {
    expect(selectApiTestImpact({ root, changed: [] }).mode).toBe("none");
    write(
      "turbo.json",
      JSON.stringify({ tasks: { "@stll/api#test": { inputs } } }),
    );
    for (const input of inputs) {
      if (input === "$TURBO_DEFAULT$" || input.startsWith("!")) {
        continue;
      }
      const pattern = input.startsWith("$TURBO_ROOT$/")
        ? path.posix.normalize(input.slice("$TURBO_ROOT$/".length))
        : path.posix.join("apps/api", input);
      if (pattern === "apps/api" || pattern.startsWith("apps/api/")) {
        continue;
      }
      const files = [
        ...new Bun.Glob(pattern).scanSync({
          cwd: repositoryRoot,
          onlyFiles: true,
        }),
      ];
      expect(files.length, input).toBeGreaterThan(0);
      for (const file of files) {
        expect(
          selectApiTestImpact({ root, changed: [file] }).mode,
          `${input}: ${file}`,
        ).toBe("all");
      }
    }
  });
});

test("new external Turbo inputs widen without a selector rule and invalid metadata fails closed", () => {
  withRepository((root, write) => {
    const changed = [
      "notes/new-root-input.ts",
      "shared/new-root-input.ts",
      "root-shared/new-root-input.ts",
    ];
    for (const file of changed) {
      expect(selectApiTestImpact({ root, changed: [file] }).mode).toBe("none");
    }
    write(
      "turbo.json",
      JSON.stringify({
        tasks: {
          "@stll/api#test": {
            inputs: [
              "$TURBO_DEFAULT$",
              "$TURBO_ROOT$/notes/**",
              "../../shared/**",
              "$TURBO_ROOT$/apps/api/../../root-shared/**",
            ],
          },
        },
      }),
    );
    for (const file of changed) {
      expect(selectApiTestImpact({ root, changed: [file] }).mode).toBe("all");
    }
    for (const metadata of [
      "invalid",
      "{}",
      '{"tasks":{"@stll/api#test":{"inputs":[42]}}}',
    ]) {
      write("turbo.json", metadata);
      expect(
        selectApiTestImpact({ root, changed: ["notes/unrelated.ts"] }).mode,
      ).toBe("all");
    }
  });
});
