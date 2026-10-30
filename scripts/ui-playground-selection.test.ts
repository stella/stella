import { expect, spyOn, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CI_GENERATED_OUTPUTS } from "../packages/scripts/src/generated-files";
import {
  readPlaygroundInventory,
  replaySelection,
  selectGeometrySpecs,
  specVisualNames,
  staticImportClosure,
} from "./ui-playground-selection";

const ROOT = path.resolve(import.meta.dirname, "..");

const createSelectionFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "ui-playground-selection-"));
  const write = (file: string, source: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  };
  const spec = "apps/web/e2e/ui-playground/fixture.geometry.spec.ts";
  write("tsconfig.json", "{}\n");
  write("apps/web/tsconfig.json", "{}\n");
  write(
    "apps/web/src/routes/dev/-visual-metadata.ts",
    "export const visualRegistry = {\n  fixture: {},\n} as const;\n",
  );
  write(
    "apps/web/src/routes/dev/-visual-registry.tsx",
    'export const visualRegistry = {\n  fixture: {\n    loader: () => import("./fixture"),\n  },\n} as const;\n',
  );
  write(spec, 'const url = "/dev?visual=fixture";\n');
  for (const entry of [
    "apps/web/src/boot-prefetch-entry.ts",
    "apps/web/src/client.tsx",
    "apps/web/src/router.tsx",
    "apps/web/src/routes/__root.tsx",
    "apps/web/src/routes/dev.tsx",
  ]) {
    write(entry, "export {};\n");
  }
  return { root, spec, write };
};

const createModuleReferenceFixture = () => {
  const fixture = createSelectionFixture();
  fixture.write(
    "apps/web/src/routes/dev/-visual-metadata.ts",
    `export const visualRegistry = {
  fixture: {},
  other: {},
} as const;`,
  );
  fixture.write(
    "apps/web/src/routes/dev/-visual-registry.tsx",
    `const visualLoaders = {
  fixture: {
    loader: () => import("./fixture"),
  },
  other: {
    loader: () => import("./other"),
  },
} as const;`,
  );
  fixture.write("apps/web/src/routes/dev/other.ts", "export {};\n");
  fixture.write(
    "apps/web/e2e/ui-playground/other.geometry.spec.ts",
    'const url = "/dev?visual=other";\n',
  );
  return fixture;
};

test.each([
  'new Worker(new URL("./workers/worker.ts", import.meta.url));',
  'new URL("workers/worker.ts", import.meta.url);',
  "new URL(`./workers/worker.ts`, import.meta.url);",
  String.raw`new URL("./workers/wo\u0072ker.ts", import.meta.url);`,
  'import.meta.glob("./workers/*.ts");',
  'import.meta.glob(["./workers/*.ts", "!./workers/*.test.ts"]);',
  'import.meta.glob("./workers/*.ts", { eager: true });',
  'import.meta.glob("./*.ts", { base: "./workers" });',
  ...["worker", "url", "raw"].flatMap((query) => [
    `import worker from "./workers/worker.ts?${query}"; export { worker };`,
    `import(\`./workers/worker.ts?${query}\`);`,
  ]),
])(
  "literal module references select the owning geometry spec: %s",
  (source) => {
    const { root, write } = createModuleReferenceFixture();
    try {
      write("apps/web/src/routes/dev/fixture.ts", source);
      write(
        "apps/web/src/routes/dev/workers/worker.ts",
        'export default "worker";',
      );
      expect(
        selectGeometrySpecs(
          ["apps/web/src/routes/dev/workers/worker.ts"],
          root,
        ),
      ).toEqual(["apps/web/e2e/ui-playground/fixture.geometry.spec.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each([
  "new URL(workerPath, import.meta.url);",
  `new URL(\`./workers/\${workerName}.ts\`, import.meta.url);`,
  "import.meta.glob(workerPattern);",
  'import.meta.glob("./workers/*.ts", options);',
  "import.meta.resolve(workerPath);",
  ...["worker", "url", "raw"].map(
    (query) => `import(\`./workers/\${workerName}.ts?${query}\`);`,
  ),
])(
  "computed module references leave the import closure incomplete: %s",
  (source) => {
    const { root, write } = createModuleReferenceFixture();
    try {
      write("apps/web/src/routes/dev/fixture.ts", source);
      expect(selectGeometrySpecs(["apps/web/src/unrelated.ts"], root)).toEqual([
        "apps/web/e2e/ui-playground/fixture.geometry.spec.ts",
        "apps/web/e2e/ui-playground/other.geometry.spec.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("glob references include removed matches and preserve exclusions", () => {
  const { root, write } = createModuleReferenceFixture();
  try {
    write(
      "apps/web/src/routes/dev/fixture.ts",
      'import.meta.glob(["./workers/*.ts", "!./workers/*.test.ts"]);',
    );
    write("apps/web/src/routes/dev/workers/kept.ts", "export {};\n");
    expect(
      selectGeometrySpecs(["apps/web/src/routes/dev/workers/removed.ts"], root),
    ).toEqual(["apps/web/e2e/ui-playground/fixture.geometry.spec.ts"]);
    expect(
      selectGeometrySpecs(
        ["apps/web/src/routes/dev/workers/ignored.test.ts"],
        root,
      ),
    ).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every geometry spec opens registered visuals with loader modules", () => {
  const inventory = readPlaygroundInventory(ROOT);
  expect(inventory.specs.length).toBeGreaterThan(0);
  expect(inventory.complete).toBe(true);
  for (const spec of inventory.specs) {
    const visuals = inventory.visualsBySpec.get(spec);
    expect(visuals?.size, spec).toBeGreaterThan(0);
    for (const visual of visuals ?? []) {
      expect(
        inventory.registeredVisuals.has(visual),
        `${spec}: ${visual}`,
      ).toBe(true);
      expect(inventory.loaderByVisual.has(visual), `${spec}: ${visual}`).toBe(
        true,
      );
    }
  }
});

test("nested metadata fields stay out of the visual census and every loader module selects its spec", () => {
  const { root, spec, write } = createSelectionFixture();
  try {
    write(
      "apps/web/src/routes/dev/-visual-metadata.ts",
      `export const visualRegistry = {
  fixture: {
    label: "Fixture",
    layout: "plain",
  },
} as const;
`,
    );
    write(
      "apps/web/src/routes/dev/-visual-registry.tsx",
      `const visualLoaders = {
  fixture: {
    load: async () => {
      return await Promise.all([
        import("./fixture"),
        import("./fixture-data"),
      ]);
    },
  },
} as const;
`,
    );
    write("apps/web/src/routes/dev/fixture.ts", "export {};\n");
    write("apps/web/src/routes/dev/fixture-data.ts", "export {};\n");
    const inventory = readPlaygroundInventory(root);
    expect(inventory.complete).toBe(true);
    expect([...inventory.registeredVisuals]).toEqual(["fixture"]);
    for (const file of ["fixture.ts", "fixture-data.ts"]) {
      expect(
        selectGeometrySpecs([`apps/web/src/routes/dev/${file}`], root),
      ).toEqual([spec]);
    }
    expect(selectGeometrySpecs(["README.md"], root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selects loader, transitive, spec, and shared harness changes", () => {
  const inventory = readPlaygroundInventory(ROOT);
  const pageCrop = "apps/web/e2e/ui-playground/page-crop.geometry.spec.ts";
  const registry = "apps/web/e2e/ui-playground/registry.geometry.spec.ts";
  expect(
    selectGeometrySpecs(
      ["apps/web/src/routes/dev/-components/page-crop-playground.tsx"],
      ROOT,
    ),
  ).toEqual([pageCrop, registry]);
  expect(
    selectGeometrySpecs(
      ["apps/web/src/components/pdf/page-organizer-crop.logic.ts"],
      ROOT,
    ),
  ).toEqual([pageCrop, registry]);
  expect(selectGeometrySpecs(["apps/api/src/index.ts"], ROOT)).toEqual([]);
  expect(selectGeometrySpecs([pageCrop], ROOT)).toEqual([pageCrop]);
  expect(
    selectGeometrySpecs(
      ["apps/web/e2e/playwright.ui-playground.config.ts"],
      ROOT,
    ),
  ).toEqual(inventory.specs);
  expect(
    selectGeometrySpecs(["apps/web/e2e/ui-playground/README.md"], ROOT),
  ).toEqual([]);
});

test("the planner reads NUL-delimited changed paths from a file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ui-playground-paths-"));
  try {
    const changedPaths = path.join(root, "changed-paths");
    const spec = "apps/web/e2e/ui-playground/page-crop.geometry.spec.ts";
    writeFileSync(changedPaths, `${spec}\0`);
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "scripts/ui-playground-selection.ts",
        "package.json",
      ],
      cwd: ROOT,
      env: { ...process.env, UI_PLAYGROUND_CHANGED_PATHS: changedPaths },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual([spec]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  "tsconfig.json",
  "apps/web/tsconfig.json",
  "config/web-base.json",
  "packages/compiler/base.json",
  "vite.config.ts",
  "apps/web/postcss.config.cjs",
  "apps/web/tailwind.config.ts",
  "apps/web/other.config.json",
  "apps/web/.browserslistrc",
  "apps/web/config/other.ts",
  "packages/theme/config/other.json",
  "packages/theme/config/other.ts",
])(
  "build and unclassified configuration changes select every spec: %s",
  (changed) => {
    const { root, write } = createSelectionFixture();
    try {
      write("apps/web/src/routes/dev/fixture.ts", "export {};\n");
      write(
        "apps/web/e2e/ui-playground/other.geometry.spec.ts",
        'const url = "/dev?visual=fixture";\n',
      );
      write(
        "apps/web/tsconfig.json",
        '{ // web config\n "extends": ["../../config/web-base"] }',
      );
      write(
        "config/web-base.json",
        '{ "extends": "@stll/compiler/base.json" }',
      );
      write(
        "packages/compiler/package.json",
        JSON.stringify({
          name: "@stll/compiler",
          exports: { "./base.json": "./base.json" },
        }),
      );
      write("packages/compiler/base.json", "{}");
      expect(selectGeometrySpecs([changed], root)).toEqual([
        "apps/web/e2e/ui-playground/fixture.geometry.spec.ts",
        "apps/web/e2e/ui-playground/other.geometry.spec.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each([
  "README.md",
  "docs/guide.md",
  "apps/web/README.md",
  "apps/web/e2e/ui-playground/README.md",
  "packages/theme/README.md",
])("documentation changes select no geometry specs: %s", (changed) => {
  const { root, write } = createSelectionFixture();
  try {
    write("apps/web/src/routes/dev/fixture.ts", "export {};\n");
    expect(selectGeometrySpecs([changed], root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  "{ invalid",
  "[]",
  '{ "extends": 42 }',
  '{ "extends": "./missing" }',
])("an unresolved compiler configuration selects every spec: %s", (config) => {
  const { root, spec, write } = createSelectionFixture();
  try {
    write("apps/web/src/routes/dev/fixture.ts", "export {};\n");
    write(
      "apps/web/e2e/ui-playground/other.geometry.spec.ts",
      'const url = "/dev?visual=fixture";\n',
    );
    write("apps/web/tsconfig.json", config);
    expect(selectGeometrySpecs([spec], root)).toEqual([
      "apps/web/e2e/ui-playground/fixture.geometry.spec.ts",
      "apps/web/e2e/ui-playground/other.geometry.spec.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a removed compiler base remains a shared build input", () => {
  const { root, write } = createSelectionFixture();
  try {
    write("apps/web/src/routes/dev/fixture.ts", "export {};\n");
    write(
      "apps/web/e2e/ui-playground/other.geometry.spec.ts",
      'const url = "/dev?visual=fixture";\n',
    );
    write(
      "apps/web/tsconfig.json",
      '{ "extends": "../../config/removed.json" }',
    );
    expect(selectGeometrySpecs(["config/removed.json"], root)).toEqual([
      "apps/web/e2e/ui-playground/fixture.geometry.spec.ts",
      "apps/web/e2e/ui-playground/other.geometry.spec.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared module text is parsed once and changed text is traced again", () => {
  const { root, write } = createSelectionFixture();
  const transform = spyOn(Bun.Transpiler.prototype, "transformSync");
  try {
    const directory = "apps/web/src/routes/dev";
    const shared =
      'import "./before"; export const parsingMarker = "shared-parse-fixture";';
    write(
      `${directory}/first.ts`,
      'import "./shared"; export const entry = "first-parse-fixture";',
    );
    write(
      `${directory}/second.ts`,
      'import "./shared"; export const entry = "second-parse-fixture";',
    );
    write(`${directory}/shared.ts`, shared);
    write(
      `${directory}/before.ts`,
      'export const value = "before-parse-fixture";',
    );
    write(
      `${directory}/after.ts`,
      'export const value = "after-parse-fixture";',
    );
    expect(staticImportClosure(`${directory}/first.ts`, root).complete).toBe(
      true,
    );
    expect(
      staticImportClosure(`${directory}/second.ts`, root).files.has(
        `${directory}/before.ts`,
      ),
    ).toBe(true);
    expect(
      transform.mock.calls.filter(([source]) => source === shared),
    ).toHaveLength(1);
    write(
      `${directory}/shared.ts`,
      'import "./after"; export const parsingMarker = "shared-parse-fixture";',
    );
    const changed = staticImportClosure(`${directory}/first.ts`, root);
    expect(changed.files.has(`${directory}/after.ts`)).toBe(true);
    expect(changed.files.has(`${directory}/before.ts`)).toBe(false);
  } finally {
    transform.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an incomplete visual mapping fails closed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ui-playground-selection-"));
  try {
    const routeDirectory = "apps/web/src/routes/dev";
    const specDirectory = "apps/web/e2e/ui-playground";
    mkdirSync(path.join(root, routeDirectory), { recursive: true });
    cpSync(path.join(ROOT, specDirectory), path.join(root, specDirectory), {
      recursive: true,
    });
    for (const file of ["-visual-metadata.ts", "-visual-registry.tsx"]) {
      cpSync(
        path.join(ROOT, routeDirectory, file),
        path.join(root, routeDirectory, file),
      );
    }
    const registry = path.join(
      root,
      "apps/web/src/routes/dev/-visual-registry.tsx",
    );
    const source = readFileSync(registry, "utf-8");
    const mutated = source.replace(
      '  "page-crop": {',
      '  "page-crop-removed": {',
    );
    expect(mutated).not.toBe(source);
    writeFileSync(registry, mutated);
    const inventory = readPlaygroundInventory(root);
    expect(inventory.complete).toBe(false);
    expect(selectGeometrySpecs(["apps/api/src/index.ts"], root)).toEqual(
      inventory.specs,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay summarizes how many change sets select specs", () => {
  const harness = "apps/web/src/routes/dev/-visual-metadata.ts";
  const summary = replaySelection([[harness], ["README.md"]]);
  expect(summary.runs).toBe(2);
  expect(summary.selecting).toBe(1);
  expect(summary.meanSpecs).toBeGreaterThan(0);
});

test("unresolved internal imports fail the closure closed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ui-playground-imports-"));
  const write = (file: string, source: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  };
  try {
    write("apps/web/src/relative.ts", 'import "./missing";');
    write("apps/web/src/alias.ts", 'import "@/missing";');
    write("apps/web/src/conditional.ts", 'import "@stll/conditional";');
    write(
      "packages/different-directory/package.json",
      JSON.stringify({
        name: "@stll/renamed",
        exports: { ".": "./src/index.ts" },
      }),
    );
    write(
      "packages/different-directory/src/index.ts",
      "export const ok = true;",
    );
    write(
      "packages/conditional/package.json",
      JSON.stringify({
        name: "@stll/conditional",
        exports: { ".": { browser: "./src/index.ts" } },
      }),
    );
    expect(staticImportClosure("apps/web/src/relative.ts", root).complete).toBe(
      false,
    );
    expect(staticImportClosure("apps/web/src/alias.ts", root).complete).toBe(
      false,
    );
    expect(
      staticImportClosure("apps/web/src/conditional.ts", root).complete,
    ).toBe(false);
    write("apps/web/src/renamed.ts", 'import "@stll/renamed";');
    expect(staticImportClosure("apps/web/src/renamed.ts", root)).toMatchObject({
      complete: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resource queries and hashes resolve to their underlying module", () => {
  const fixture = createSelectionFixture();
  try {
    fixture.write(
      "apps/web/src/routes/dev/-visual-metadata.ts",
      "export const visualRegistry = {\n  fixture: {},\n  other: {},\n} as const;\n",
    );
    fixture.write(
      "apps/web/src/routes/dev/-visual-registry.tsx",
      'export const visualRegistry = {\n  fixture: {\n    loader: () => import("./fixture"),\n  },\n  other: {\n    loader: () => import("./other"),\n  },\n} as const;\n',
    );
    fixture.write(
      "apps/web/e2e/ui-playground/other.geometry.spec.ts",
      'const url = "/dev?visual=other";\n',
    );
    fixture.write("apps/web/src/routes/dev/other.ts", "export {};\n");
    fixture.write(
      "apps/web/src/routes/dev/fixture.ts",
      'import worker from "./worker?worker&url#asset";\nexport { worker };\n',
    );
    fixture.write(
      "apps/web/src/routes/dev/worker.ts",
      'export default "worker";\n',
    );
    expect(
      selectGeometrySpecs(["apps/web/src/routes/dev/worker.ts"], fixture.root),
    ).toEqual([fixture.spec]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an unresolved loader import selects every spec", () => {
  const fixture = createSelectionFixture();
  const secondSpec =
    "apps/web/e2e/ui-playground/second-fixture.geometry.spec.ts";
  try {
    fixture.write(secondSpec, 'const url = "/dev?visual=fixture";\n');
    fixture.write(
      "apps/web/src/routes/dev/fixture.ts",
      'import "./missing-internal-module";\n',
    );
    expect(
      selectGeometrySpecs(["apps/web/src/unrelated.ts"], fixture.root),
    ).toEqual([fixture.spec, secondSpec]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a missing workspace package selects the affected spec", () => {
  const { root, spec, write } = createSelectionFixture();
  try {
    write(
      "apps/web/src/routes/dev/fixture.ts",
      'import "@stll/missing-package";\n',
    );
    expect(selectGeometrySpecs(["apps/web/src/unrelated.ts"], root)).toEqual([
      spec,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  { version: "0.4.1", complete: true },
  { version: "catalog:", complete: true },
  { version: "workspace:*", complete: false },
  { version: "file:../../missing", complete: false },
])(
  "dependency tracing is independent of installed packages: $version",
  ({ version, complete }) => {
    const { root, write } = createSelectionFixture();
    try {
      write(
        "packages/fixture/package.json",
        JSON.stringify({ name: "@stll/fixture" }),
      );
      write(
        "apps/web/package.json",
        JSON.stringify({ dependencies: { "@stll/remote": version } }),
      );
      const entry = "apps/web/src/routes/dev/fixture.ts";
      write(entry, 'import "@stll/remote";\n');
      expect(staticImportClosure(entry, root).complete).toBe(complete);
      write(
        "node_modules/@stll/remote/package.json",
        JSON.stringify({ name: "@stll/remote" }),
      );
      expect(staticImportClosure(entry, root).complete).toBe(complete);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a browser export change selects the importing spec", () => {
  const { root, spec, write } = createSelectionFixture();
  try {
    write(
      "apps/web/src/routes/dev/fixture.ts",
      'import "@stll/fixture-package";\n',
    );
    write(
      "packages/fixture/package.json",
      JSON.stringify({
        name: "@stll/fixture-package",
        exports: {
          ".": {
            browser: "./src/browser.ts",
            import: "./src/import.ts",
          },
        },
      }),
    );
    write(
      "packages/fixture/src/browser.ts",
      "export const target = 'browser';",
    );
    write("packages/fixture/src/import.ts", "export const target = 'import';");
    expect(
      selectGeometrySpecs(["packages/fixture/src/browser.ts"], root),
    ).toEqual([spec]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a string root export resolves to its entry, never the src/index guess", () => {
  const { root, spec, write } = createSelectionFixture();
  try {
    write(
      "apps/web/src/routes/dev/fixture.ts",
      'import "@stll/fixture-package";\n',
    );
    write(
      "packages/fixture/package.json",
      JSON.stringify({
        name: "@stll/fixture-package",
        exports: "./src/browser.ts",
      }),
    );
    write("packages/fixture/src/browser.ts", "export const target = 1;");
    write("packages/fixture/src/index.ts", "export const target = 2;");
    expect(
      selectGeometrySpecs(["packages/fixture/src/browser.ts"], root),
    ).toEqual([spec]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a declared entry without exports fails closed instead of guessing src/index", () => {
  const { root, write } = createSelectionFixture();
  try {
    write(
      "apps/web/src/routes/dev/fixture.ts",
      'import "@stll/fixture-package";\n',
    );
    write(
      "packages/fixture/package.json",
      JSON.stringify({
        name: "@stll/fixture-package",
        browser: "./src/browser.ts",
      }),
    );
    write("packages/fixture/src/browser.ts", "export const target = 1;");
    write("packages/fixture/src/index.ts", "export const target = 2;");
    expect(
      selectGeometrySpecs(["apps/web/src/unrelated.ts"], root),
    ).not.toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an exports form the selector cannot read fails closed", () => {
  // A fresh fixture: selection caches manifests per repository root.
  const { root, write } = createSelectionFixture();
  try {
    write(
      "apps/web/src/routes/dev/fixture.ts",
      'import "@stll/fixture-package";\n',
    );
    write(
      "packages/fixture/package.json",
      JSON.stringify({
        name: "@stll/fixture-package",
        exports: ["./src/browser.ts"],
      }),
    );
    write("packages/fixture/src/browser.ts", "export const target = 1;");
    expect(
      selectGeometrySpecs(["apps/web/src/unrelated.ts"], root),
    ).not.toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an exported stylesheet outside src selects the importing spec", () => {
  const { root, spec, write } = createSelectionFixture();
  try {
    write(
      "apps/web/src/routes/dev/fixture.ts",
      'import "@stll/fixture-theme/theme.css";\n',
    );
    write(
      "packages/theme/package.json",
      JSON.stringify({
        name: "@stll/fixture-theme",
        exports: { "./theme.css": "./styles/theme.css" },
      }),
    );
    write(
      "packages/theme/styles/theme.css",
      ":root { --bg: url('./background.svg'); }\n",
    );
    write("packages/theme/styles/background.svg", "<svg />\n");
    write("packages/theme/README.md", "# Theme\n");
    for (const file of [
      "packages/theme/styles/theme.css",
      "packages/theme/styles/background.svg",
    ]) {
      expect(selectGeometrySpecs([file], root), file).toEqual([spec]);
    }
    expect(selectGeometrySpecs(["packages/theme/README.md"], root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare and unquoted CSS imports resolve against the stylesheet", () => {
  const { root, spec, write } = createSelectionFixture();
  try {
    write("apps/web/src/routes/dev/fixture.ts", 'import "./a.css";\n');
    write(
      "apps/web/src/routes/dev/a.css",
      '@import "tailwindcss";\n@import "tokens.css";\n@import url(layout.css);\n@import "theme.css?dark";\n',
    );
    write("apps/web/src/routes/dev/tokens.css", ":root {}\n");
    write("apps/web/src/routes/dev/layout.css", ".page {}\n");
    write("apps/web/src/routes/dev/theme.css", ":root {}\n");
    // A declared dependency, so `@import "tailwindcss"` reads as external.
    write(
      "apps/web/package.json",
      JSON.stringify({ name: "web", devDependencies: { tailwindcss: "1" } }),
    );
    for (const file of [
      "apps/web/src/routes/dev/tokens.css",
      "apps/web/src/routes/dev/layout.css",
      // A resource query names the same stylesheet.
      "apps/web/src/routes/dev/theme.css",
    ]) {
      expect(selectGeometrySpecs([file], root), file).toEqual([spec]);
    }
    expect(selectGeometrySpecs(["apps/web/src/unrelated.ts"], root)).toEqual(
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bare stylesheet import that is gone and no dependency fails closed", () => {
  // A fresh fixture: selection caches closures per repository root.
  const { root, write } = createSelectionFixture();
  try {
    write("apps/web/src/routes/dev/fixture.ts", 'import "./a.css";\n');
    write("apps/web/src/routes/dev/a.css", '@import "tokens.css";\n');
    write(
      "apps/web/package.json",
      JSON.stringify({ name: "web", devDependencies: { tailwindcss: "1" } }),
    );
    expect(
      selectGeometrySpecs(["apps/web/src/unrelated.ts"], root),
    ).not.toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a transitive CSS import change selects the importing spec", () => {
  const { root, spec, write } = createSelectionFixture();
  try {
    write("apps/web/src/routes/dev/fixture.ts", 'import "./a.css";\n');
    write("apps/web/src/routes/dev/a.css", '@import "./b.css";\n');
    write("apps/web/src/routes/dev/b.css", ".fixture {}\n");
    expect(
      selectGeometrySpecs(["apps/web/src/routes/dev/b.css"], root),
    ).toEqual([spec]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("render inputs outside source select every geometry spec", () => {
  const all = readPlaygroundInventory(ROOT).specs;
  for (const file of [
    "bun.lock",
    "patches/example.patch",
    "apps/web/vite.config.ts",
    "apps/web/tailwind.config.js",
    "apps/web/postcss.config.mjs",
    "apps/web/index.html",
    "apps/web/public/icon.svg",
    "packages/ui/package.json",
  ]) {
    expect(selectGeometrySpecs([file], ROOT), file).toEqual(all);
  }
});

test("app shell and route-tree changes select every spec without following unrelated routes", () => {
  const fixture = createSelectionFixture();
  try {
    fixture.write("apps/web/src/routes/dev/fixture.tsx", "export {};\n");
    fixture.write(
      "apps/web/src/routes/__root.tsx",
      'import "@/styles/app.css";\nimport "@/providers";\n',
    );
    fixture.write("apps/web/src/styles/app.css", '@import "./tokens.css";\n');
    fixture.write("apps/web/src/styles/tokens.css", ":root {}\n");
    fixture.write("apps/web/src/providers.tsx", "export {};\n");
    fixture.write(
      "apps/web/src/router.tsx",
      'import { routeTree } from "@/routeTree.gen";\nexport { routeTree };\n',
    );
    fixture.write(
      "apps/web/src/routeTree.gen.ts",
      'import "./routes/other";\nexport const routeTree = {};\n',
    );
    fixture.write("apps/web/src/routes/other.tsx", "export {};\n");

    for (const file of [
      "apps/web/src/styles/tokens.css",
      "apps/web/src/providers.tsx",
      "apps/web/src/routes/__root.tsx",
      "apps/web/src/routeTree.gen.ts",
    ]) {
      expect(selectGeometrySpecs([file], fixture.root), file).toEqual([
        fixture.spec,
      ]);
    }
    expect(
      selectGeometrySpecs(["apps/web/src/routes/other.tsx"], fixture.root),
    ).toEqual([]);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test.each(CI_GENERATED_OUTPUTS.routeTree)(
  "generated route outputs remain boundaries before generation: %s",
  (output) => {
    const fixture = createSelectionFixture();
    try {
      fixture.write("apps/web/src/routes/dev/fixture.ts", "export {};\n");
      fixture.write(
        "apps/web/e2e/ui-playground/other.geometry.spec.ts",
        'const url = "/dev?visual=fixture";\n',
      );
      const imported = output
        .replace("apps/web/src/", "@/")
        .replace(/\.ts$/u, "");
      fixture.write("apps/web/src/router.tsx", `import "${imported}";\n`);
      expect(selectGeometrySpecs([fixture.spec], fixture.root)).toEqual([
        "apps/web/e2e/ui-playground/fixture.geometry.spec.ts",
      ]);
      expect(selectGeometrySpecs([output], fixture.root)).toEqual([
        "apps/web/e2e/ui-playground/fixture.geometry.spec.ts",
        "apps/web/e2e/ui-playground/other.geometry.spec.ts",
      ]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  },
);

test("a missing app shell entry selects every spec", () => {
  const fixture = createSelectionFixture();
  try {
    fixture.write("apps/web/src/routes/dev/fixture.tsx", "export {};\n");
    rmSync(path.join(fixture.root, "apps/web/src/client.tsx"));
    expect(
      selectGeometrySpecs(["apps/web/src/unrelated.ts"], fixture.root),
    ).toEqual([fixture.spec]);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("the web and root manifests select every spec", () => {
  const fixture = createSelectionFixture();
  try {
    fixture.write("apps/web/src/routes/dev/fixture.tsx", "export {};\n");
    for (const file of ["apps/web/package.json", "package.json"]) {
      expect(selectGeometrySpecs([file], fixture.root), file).toEqual([
        fixture.spec,
      ]);
    }
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("an untraced asset change selects every spec", () => {
  const fixture = createSelectionFixture();
  try {
    fixture.write(
      "apps/web/src/routes/dev/fixture.tsx",
      'import "./fixture.css";\nexport {};\n',
    );
    fixture.write(
      "apps/web/src/routes/dev/fixture.css",
      ".page { background-image: url('./background.svg'); }\n",
    );
    fixture.write("apps/web/src/routes/dev/background.svg", "<svg />\n");
    for (const file of [
      "apps/web/src/routes/dev/background.svg",
      "packages/ui/src/fonts/inter.woff2",
    ]) {
      expect(selectGeometrySpecs([file], fixture.root), file).toEqual([
        fixture.spec,
      ]);
    }
    expect(
      selectGeometrySpecs(["apps/web/src/unrelated.ts"], fixture.root),
    ).toEqual([]);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("a computed dynamic import selects every spec", () => {
  const fixture = createSelectionFixture();
  try {
    fixture.write(
      "apps/web/src/routes/dev/fixture.tsx",
      [
        '// import("./commented") is not code',
        'export type Lazy = typeof import("./types");',
        "export const load = (variant: string) =>",
        `  import(\`./variants/\${variant}.tsx\`);`,
        "",
      ].join("\n"),
    );
    fixture.write("apps/web/src/routes/dev/variants/wide.tsx", "export {};\n");
    expect(
      selectGeometrySpecs(
        ["apps/web/src/routes/dev/variants/wide.tsx"],
        fixture.root,
      ),
    ).toEqual([fixture.spec]);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("literal dynamic imports, comments and type imports keep the closure exact", () => {
  const fixture = createSelectionFixture();
  try {
    fixture.write(
      "apps/web/src/routes/dev/fixture.tsx",
      [
        `// import(\`./variants/\${name}.tsx\`) in a comment`,
        'export type Lazy = typeof import("./types");',
        'export const load = () => import("./variants/wide");',
        "",
      ].join("\n"),
    );
    fixture.write("apps/web/src/routes/dev/types.ts", "export {};\n");
    fixture.write("apps/web/src/routes/dev/variants/wide.tsx", "export {};\n");
    expect(
      selectGeometrySpecs(
        ["apps/web/src/routes/dev/variants/wide.tsx"],
        fixture.root,
      ),
    ).toEqual([fixture.spec]);
    expect(
      selectGeometrySpecs(["apps/web/src/unrelated.ts"], fixture.root),
    ).toEqual([]);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("a visual URL with other query parameters still names its visual", () => {
  const { root, spec, write } = createSelectionFixture();
  try {
    write(
      "apps/web/src/routes/dev/-visual-metadata.ts",
      "export const visualRegistry = {\n  fixture: {},\n  other: {},\n} as const;\n",
    );
    write(
      "apps/web/src/routes/dev/-visual-registry.tsx",
      'export const visualRegistry = {\n  fixture: {\n    loader: () => import("./fixture"),\n  },\n  other: {\n    loader: () => import("./other"),\n  },\n} as const;\n',
    );
    write(
      spec,
      'const a = "/dev?visual=fixture";\nconst b = "/dev?theme=dark&visual=other&density=compact";\n',
    );
    write("apps/web/src/routes/dev/fixture.tsx", "export {};\n");
    write("apps/web/src/routes/dev/other.tsx", "export {};\n");
    expect(
      selectGeometrySpecs(["apps/web/src/routes/dev/other.tsx"], root),
    ).toEqual([spec]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file the transpiler cannot parse leaves the closure incomplete", () => {
  const { root, write } = createSelectionFixture();
  try {
    write("apps/web/src/routes/dev/fixture.ts", "const view = <div>;\n");
    expect(
      staticImportClosure("apps/web/src/routes/dev/fixture.ts", root).complete,
    ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a JSX transform warning keeps the closure exact", () => {
  const fixture = createSelectionFixture();
  try {
    fixture.write(
      "apps/web/src/routes/dev/fixture.tsx",
      [
        'import { Cell } from "./cell";',
        "const props = { title: 'a' };",
        'export const View = () => <Cell {...props} key="a" />;',
        "",
      ].join("\n"),
    );
    fixture.write(
      "apps/web/src/routes/dev/cell.tsx",
      "export const Cell = () => null;\n",
    );
    expect(
      staticImportClosure("apps/web/src/routes/dev/fixture.tsx", fixture.root),
    ).toMatchObject({ complete: true });
    expect(
      selectGeometrySpecs(["apps/web/src/routes/dev/cell.tsx"], fixture.root),
    ).toEqual([fixture.spec]);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("a computed visual URL leaves the spec incomplete beside a literal one", () => {
  const registered = new Set(["a", "b"]);
  // Spec source text: `$` and `{` are split so the fixture stays a plain string.
  const interpolated = (name: string) => ["$", `{${name}}`].join("");
  for (const computed of [
    `const url = \`/dev?visual=${interpolated("name")}\`;`,
    `const url = \`/dev?theme=${interpolated("theme")}&visual=${interpolated("name")}\`;`,
    'const url = "/dev?visual=" + name;',
    // A literal name that is concatenated on is only a prefix.
    'const url = "/dev?visual=a" + suffix;',
  ]) {
    expect(
      specVisualNames(
        `const fixed = "/dev?visual=a";\n${computed}\n`,
        registered,
      ),
      computed,
    ).toEqual({ names: new Set(["a"]), complete: false });
  }
  expect(
    specVisualNames(
      'const a = "/dev?visual=a";\nconst b = "/dev?theme=dark&visual=b#top";\n',
      registered,
    ),
  ).toEqual({ names: new Set(["a", "b"]), complete: true });
});
