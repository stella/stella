import { expect, test } from "bun:test";
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
  ).toEqual(inventory.specs);
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

test("an absent generated route tree remains an app shell boundary", () => {
  const fixture = createSelectionFixture();
  try {
    fixture.write("apps/web/src/routes/dev/fixture.tsx", "export {};\n");
    fixture.write(
      "apps/web/src/router.tsx",
      'export { routeTree } from "@/routeTree.gen";\n',
    );
    expect(
      selectGeometrySpecs(
        ["apps/web/src/routes/dev/fixture.tsx"],
        fixture.root,
      ),
    ).toEqual([fixture.spec]);
    expect(
      selectGeometrySpecs(["apps/web/src/routeTree.gen.ts"], fixture.root),
    ).toEqual([fixture.spec]);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

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
