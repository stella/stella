import { expect, test } from "bun:test";

import config from "../../oxlint.config.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-module-url-pathname/no-module-url-pathname";

const lint = async (source: string, sourcePath = "scripts/module-paths.ts") =>
  await lintSingleRule("no-module-url-pathname", source, { sourcePath });

test("reports a module URL pathname that spans lines", async () => {
  expect(
    await lint(
      [
        "const fixtures = new URL(",
        '  "../fixtures",',
        "  import.meta.url,",
        ").pathname;",
      ].join("\n"),
    ),
  ).toEqual([1]);
});

test("follows stable bindings but not reassignable ones", async () => {
  const [stable, reassignable] = await Promise.all([
    lint(
      'const here = new URL(".", import.meta.url);\nconst alias = here;\nalias.pathname;',
    ),
    lint(
      'let here = new URL(".", import.meta.url);\nhere = new URL(location.href);\nhere.pathname;',
    ),
  ]);
  expect({ stable, reassignable }).toEqual({ stable: [3], reassignable: [] });
});

test("accepts fileURLToPath, import.meta directories and shadowed URL", async () => {
  const results = await Promise.all([
    lint(
      'import { fileURLToPath } from "node:url";\nfileURLToPath(new URL("../fixtures", import.meta.url));',
    ),
    lint("import.meta.dirname;\nimport.meta.dir;"),
    lint(
      'class URL { pathname = "/"; constructor(_input: string, _base?: string) {} }\nnew URL(".", import.meta.url).pathname;',
    ),
    lint('new URL("/a", location.href).pathname;'),
  ]);
  expect(results).toEqual([[], [], [], []]);
});

test("is scoped to filesystem runtimes and the Bun tests of browser bundles", async () => {
  const overrides = [
    { files: ["**/*"], rules: { [RULE]: "off" as const } },
    ...config.overrides.filter(
      (override) => override.rules !== undefined && RULE in override.rules,
    ),
  ];
  const source = 'new URL(".", import.meta.url).pathname;';
  const cases = [
    ["scripts/generate.ts", [1]],
    ["packages/cli/scripts/codegen.ts", [1]],
    ["apps/api/src/server.ts", [1]],
    ["apps/desktop/scripts/bundle.mjs", [1]],
    ["apps/web/src/lib/worker-client.ts", []],
    ["packages/ui/src/asset.ts", []],
    ["apps/web/src/i18n/census.test.ts", [1]],
    ["apps/web/src/components/view.dom.test.tsx", [1]],
    ["apps/web/src/components/card.browser.test.tsx", []],
  ] as const;
  const results = await Promise.all(
    cases.map(
      async ([sourcePath]) =>
        await lintSingleRule("no-module-url-pathname", source, {
          sourcePath,
          overrides,
          cwd: "scratch",
        }),
    ),
  );
  expect(
    Object.fromEntries(
      cases.map(([sourcePath], index) => [sourcePath, results[index]]),
    ),
  ).toEqual(
    Object.fromEntries(
      cases.map(([sourcePath, expected]) => [sourcePath, expected]),
    ),
  );
});
