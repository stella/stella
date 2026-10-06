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
  API_ALL_RULES,
  API_SHARD_SECONDS,
  selectApiTestImpact,
} from "./api-test-impact";

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
    write("apps/api/src/tests/setup-env.ts", 'import "./preload-helper";');
    write("apps/api/src/tests/preload-helper.ts", "export const setup = true;");
    write(
      "apps/api/src/handler.ts",
      'export { value } from "@stll/example/feature";',
    );
    write("apps/api/src/handler.test.ts", 'import "./handler";');
    write("apps/api/src/unrelated.test.ts", "export const test = true;");
    write(
      "apps/api/scripts/test-durations.json",
      JSON.stringify({
        "src/handler.test.ts": { seconds: 2, source: "measured" },
        "src/unrelated.test.ts": { seconds: 3, source: "estimated" },
      }),
    );
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
  github: ".github/actions/test/action.yml",
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
        shards: 4,
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

test("a planted source-text reader and transitive directory scanner run on every application change", () => {
  withRepository((root, write) => {
    write(
      "apps/api/src/text.test.ts",
      'import { readFileSync } from "node:fs"; readFileSync("apps/web/src/screen.tsx");',
    );
    write(
      "apps/api/src/list.ts",
      'import { readdirSync } from "node:fs"; export const files = readdirSync("apps");',
    );
    write("apps/api/src/list.test.ts", 'import "./list";');
    write(
      "apps/api/src/data-reader.ts",
      'import { readFileSync } from "node:fs"; export const data = readFileSync("rules.yar");',
    );
    write("apps/api/src/data.test.ts", 'import "./data-reader";');
    for (const changed of [
      "apps/web/src/screen.tsx",
      "apps/desktop/src/feature.ts",
      "packages/example/src/feature.ts",
    ]) {
      const selection = selectApiTestImpact({ root, changed: [changed] });
      expect(selection.mode).toBe("selected");
      expect(selection.files).toContain("src/text.test.ts");
      expect(selection.files).toContain("src/list.test.ts");
      expect(selection.files).not.toContain("src/data.test.ts");
    }
    expect(selectApiTestImpact({ root, changed: ["docs/guide.md"] }).mode).toBe(
      "none",
    );
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
    write("apps/api/scripts/test-durations.json", "broken json");
    expect(
      selectApiTestImpact({ root, changed: ["apps/api/src/handler.test.ts"] })
        .mode,
    ).toBe("all");
  });
  expect(
    selectApiTestImpact({
      root: "/missing-repository",
      changed: ["apps/api/src/handler.ts"],
    }).mode,
  ).toBe("all");
});

test("duration budgeting uses selected work only and never creates an empty shard", () => {
  withRepository((root, write) => {
    for (const seconds of [
      0,
      API_SHARD_SECONDS,
      API_SHARD_SECONDS + 1,
      API_SHARD_SECONDS * 10,
    ]) {
      write("apps/api/src/second.test.ts", 'import "./handler";');
      write(
        "apps/api/scripts/test-durations.json",
        JSON.stringify({
          "src/handler.test.ts": { seconds, source: "measured" },
          "src/second.test.ts": { seconds: 0, source: "measured" },
          "src/unrelated.test.ts": { seconds: 10_000, source: "measured" },
        }),
      );
      expect(
        selectApiTestImpact({ root, changed: ["apps/api/src/handler.ts"] })
          .shards,
      ).toBe(seconds > API_SHARD_SECONDS ? 2 : 1);
    }
    for (let index = 0; index < 5; index++) {
      write(`apps/api/src/new-${index}.test.ts`, 'import "./handler";');
    }
    expect(
      selectApiTestImpact({ root, changed: ["apps/api/src/handler.ts"] })
        .shards,
    ).toBe(4);
    write(
      "apps/api/scripts/test-durations.json",
      JSON.stringify({
        "src/handler.test.ts": { seconds: -1, source: "measured" },
      }),
    );
    expect(
      selectApiTestImpact({ root, changed: ["apps/api/src/handler.ts"] }).mode,
    ).toBe("all");
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
      selectApiTestImpact({ root, changed: ["apps/web/src/screen.tsx"] }).files,
    ).toEqual(["src/loader.test.ts", "src/require.test.ts"]);
  });
});

test("the repository graph reaches real handler tests and workspace consumers", () => {
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
});

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
