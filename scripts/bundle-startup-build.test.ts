import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  componentDeclarationLines,
  parseStartManifest,
  readStartupGraph,
  resolveModuleImports,
  staticSpecifiers,
} from "./bundle-startup-build";
import { coldLoadHops, startupPageCode } from "./bundle-startup-gates";

describe("module imports", () => {
  test("type-only imports load nothing, re-exports and side effects do", () => {
    const source = [
      'import type { Row } from "./-rows";',
      'import { type Cell, cellOf } from "./-cells";',
      'import "./-styles.css";',
      'export { pagerOf } from "@/components/pager";',
      'export type { Pager } from "@/components/pager-types";',
    ].join("\n");

    expect(staticSpecifiers("src/routes/-x.page.tsx", source)).toEqual([
      "./-cells",
      "./-styles.css",
      "@/components/pager",
    ]);
  });

  test("specifiers resolve to the build's module ids, packages left out", () => {
    const imports = resolveModuleImports(
      new Map([
        [
          "src/routes/cases.tsx?tsr-split=component",
          ["./-cases.page", "@stll/ui/button"],
        ],
        ["src/routes/-cases.page.tsx", ["@/lib/loader", "./cases"]],
      ]),
      [
        "src/routes/cases.tsx?tsr-split=component",
        "src/routes/cases.tsx",
        "src/routes/-cases.page.tsx",
        "src/lib/loader/index.ts",
      ],
    );

    expect(imports.get("src/routes/cases.tsx?tsr-split=component")).toEqual([
      "src/routes/-cases.page.tsx",
    ]);
    expect(imports.get("src/routes/-cases.page.tsx")).toEqual([
      "src/lib/loader/index.ts",
      "src/routes/cases.tsx",
    ]);
  });
});

describe("route component declarations", () => {
  // The shape that keeps a page in the route file: the eager pending view
  // renders the same local page the component does.
  const sharedPage = [
    'import { createFileRoute } from "@tanstack/react-router";',
    'import { fetchStatutes } from "./-statutes-query";',
    "",
    "const pageSize = () => 20;",
    "",
    'export const Route = createFileRoute("/statutes")({',
    "  loader: () => fetchStatutes(pageSize()),",
    '  component: () => <StatutesPage state="loaded" />,',
    '  pendingComponent: () => <StatutesPage state="pending" />,',
    "});",
    "",
    "function StatutesPage({ state }: { state: string }) {",
    "  return <StatutesList state={state} size={pageSize()} />;",
    "}",
    "",
    "const StatutesList = ({ state, size }: { state: string; size: number }) => (",
    "  <ul data-state={state}>{size}</ul>",
    ");",
    "",
  ].join("\n");

  test("covers what only the component reaches, not the route or its data", () => {
    // StatutesPage (lines 11-13) and StatutesList (15-17), 0-based; not
    // pageSize, which the loader reaches too, and not the Route itself.
    expect(
      componentDeclarationLines("src/routes/statutes.tsx", sharedPage),
    ).toEqual([
      [11, 13],
      [15, 17],
    ]);
  });

  test("an exported page the component names directly is covered", () => {
    const source = [
      'import { createFileRoute } from "@tanstack/react-router";',
      'export const Route = createFileRoute("/invoice")({ component: InvoicePage });',
      "export function InvoicePage() {",
      "  return null;",
      "}",
    ].join("\n");

    expect(componentDeclarationLines("src/routes/invoice.tsx", source)).toEqual(
      [[2, 4]],
    );
  });

  test("a key or member spelled like a page is not a reference to it", () => {
    // The loader returns `{ InvoicePage: true }` and reads `meta.InvoicePage`;
    // neither reaches the local function, so it stays component-only.
    const source = [
      'import { createFileRoute } from "@tanstack/react-router";',
      'export const Route = createFileRoute("/invoice")({',
      "  loader: ({ meta }) => ({ InvoicePage: meta.InvoicePage }),",
      "  component: () => <InvoicePage />,",
      "  pendingComponent: () => <InvoicePage />,",
      "});",
      "function InvoicePage() {",
      "  return null;",
      "}",
    ].join("\n");
    const shorthand = source.replace(
      "({ InvoicePage: meta.InvoicePage })",
      "({ InvoicePage })",
    );

    expect(shorthand).not.toBe(source);
    expect(componentDeclarationLines("src/routes/invoice.tsx", source)).toEqual(
      [[6, 8]],
    );
    // Shorthand `{ InvoicePage }` does read the binding: it is route data.
    expect(
      componentDeclarationLines("src/routes/invoice.tsx", shorthand),
    ).toEqual([]);
  });

  test("declarators sharing a statement are measured apart", () => {
    const source = [
      'import { createFileRoute } from "@tanstack/react-router";',
      'import { fetchData } from "./-data";',
      'export const Route = createFileRoute("/two")({',
      "  loader: () => load(),",
      "  component: () => <Page />,",
      "  pendingComponent: () => <Page />,",
      "});",
      "const load = () => fetchData(),",
      "  Page = () => <main />;",
    ].join("\n");

    // Only `Page` (line 8); `load` on line 7 belongs to the loader.
    expect(componentDeclarationLines("src/routes/two.tsx", source)).toEqual([
      [8, 8],
    ]);
  });

  test("an imported component and a route without one cover nothing", () => {
    const imported = [
      'import { createFileRoute } from "@tanstack/react-router";',
      'import { ContactsPage } from "./-contacts.page";',
      'export const Route = createFileRoute("/contacts")({ component: ContactsPage });',
    ].join("\n");
    const layout = [
      'import { createFileRoute, redirect } from "@tanstack/react-router";',
      "const target = () => '/home';",
      'export const Route = createFileRoute("/old")({ beforeLoad: () => { throw redirect({ to: target() }); } });',
    ].join("\n");

    expect(
      componentDeclarationLines("src/routes/contacts.tsx", imported),
    ).toEqual([]);
    expect(componentDeclarationLines("src/routes/old.tsx", layout)).toEqual([]);
    expect(
      componentDeclarationLines(
        "src/routes/-helper.tsx",
        "export const a = 1;",
      ),
    ).toEqual([]);
  });
});

// A real build: a route file whose pending view keeps its page eager, and a
// route that loads its page with a hand-written import(). The manifest module
// has the Start plugin's shape.
describe("reading the Start manifest as data", () => {
  // The shape the Start plugin writes into the server build, minified.
  const minified = [
    "// \\0tanstack-start-manifest:v",
    "var tsrStartManifest = () => ({ routes: {",
    "\t__root__: {",
    '\t\tfilePath: "/build/apps/web/src/routes/__root.tsx",',
    '\t\tchildren: ["/", "/law"],',
    '\t\tcss: ["/assets/vendor-tanstack-Bv1_VIvA.css"],',
    '\t\tpreloads: ["/assets/index-B8Lw9Urb.js", `/assets/vendor-react-DFHnd9ca.js`],',
    '\t\tscripts: [{ attrs: { type: "module", async: !0, src: "/assets/index-B8Lw9Urb.js" } }]',
    "\t},",
    '\t"/": { filePath: "/build/apps/web/src/routes/index.tsx", children: void 0, preloads: ["/assets/routes-C9t_oDei.js"] }',
    "} });",
    "export { tsrStartManifest };",
  ].join("\n");

  test("reads the routes and their preloads without running the module", () => {
    expect(parseStartManifest("manifest.js", minified)).toEqual({
      routes: {
        __root__: {
          filePath: "/build/apps/web/src/routes/__root.tsx",
          preloads: [
            "/assets/index-B8Lw9Urb.js",
            "/assets/vendor-react-DFHnd9ca.js",
          ],
        },
        "/": {
          filePath: "/build/apps/web/src/routes/index.tsx",
          preloads: ["/assets/routes-C9t_oDei.js"],
        },
      },
    });
  });

  test("refuses a manifest that computes a value", () => {
    const computed = minified.replace(
      '"/assets/routes-C9t_oDei.js"',
      "routeChunk()",
    );
    const referenced = minified.replace(
      '"/assets/routes-C9t_oDei.js"',
      "chunk",
    );

    expect(computed).not.toBe(minified);
    expect(parseStartManifest("manifest.js", computed)).toBe(
      "manifest.js: the manifest is not plain data (CallExpression)",
    );
    expect(parseStartManifest("manifest.js", referenced)).toBe(
      "manifest.js: the manifest is not plain data (Identifier chunk)",
    );
    const discarded = minified.replace(
      "children: void 0",
      "children: void load()",
    );
    expect(discarded).not.toBe(minified);
    expect(parseStartManifest("manifest.js", discarded)).toBe(
      "manifest.js: the manifest is not plain data (CallExpression)",
    );
    expect(parseStartManifest("manifest.js", "export const other = 1;")).toBe(
      "manifest.js does not declare tsrStartManifest as an arrow returning an object",
    );
  });
});

describe("reading a production build", () => {
  let dir = "";
  let pageChunk = "";
  let entryChunk = "";
  let routesDir = "";
  const manifestFile =
    "dist/server/assets/_tanstack-start-manifest_v-fixture.js";

  const manifestText = (rootPreloads: readonly string[]): string =>
    `export const tsrStartManifest = () => (${JSON.stringify({
      routes: {
        __root__: {
          filePath: path.join(routesDir, "__root.tsx"),
          preloads: rootPreloads.map((file) => `/assets/${file}`),
        },
        "/statutes": {
          filePath: path.join(routesDir, "statutes.tsx"),
          preloads: [],
        },
        "/cases": { filePath: path.join(routesDir, "cases.tsx"), preloads: [] },
      },
    })});\n`;

  /** The fixture build, copied and damaged by `damage`, then read. */
  const readDamaged = (damage: (dist: string) => void) => {
    const copy = mkdtempSync(path.join(tmpdir(), "bundle-startup-damaged-"));
    try {
      cpSync(path.join(dir, "dist"), path.join(copy, "dist"), {
        recursive: true,
      });
      damage(path.join(copy, "dist"));
      return readStartupGraph(path.join(copy, "dist"));
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  };
  const entryMap = (dist: string) =>
    path.join(dist, "client/assets", `${entryChunk}.map`);

  beforeAll(async () => {
    // The real path: the bundler writes map sources relative to the real
    // output directory, as Vite does, and macOS links the temporary one.
    dir = realpathSync(
      mkdtempSync(path.join(tmpdir(), "bundle-startup-build-")),
    );
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    };
    write(
      "src/router.ts",
      "export const createFileRoute = (id: string) => (options: object) => ({ id, options });\n",
    );
    write(
      "src/routes/statutes.tsx",
      [
        'import { createFileRoute } from "../router";',
        `const loadStatutes = () => "${"L".repeat(400)}";`,
        'export const Route = createFileRoute("/statutes")({',
        "  loader: () => loadStatutes(),",
        "  component: () => StatutesPage(1),",
        "  pendingComponent: () => StatutesPage(0),",
        "});",
        `function StatutesPage(state: number) { return state + "${"P".repeat(400)}"; }`,
        "",
      ].join("\n"),
    );
    write(
      "src/routes/cases.tsx",
      [
        'import { createFileRoute } from "../router";',
        'export const Route = createFileRoute("/cases")({',
        '  component: () => import("./cases/-cases-page"),',
        "});",
        "",
      ].join("\n"),
    );
    write(
      "src/routes/cases/-cases-page.tsx",
      `export const CasesPage = () => "${"C".repeat(3000)}";\n`,
    );
    write(
      "src/entry.ts",
      [
        'export { Route as statutes } from "./routes/statutes";',
        'export { Route as cases } from "./routes/cases";',
        "",
      ].join("\n"),
    );
    const assets = path.join(dir, "dist/client/assets");
    const build = await Bun.build({
      entrypoints: [path.join(dir, "src/entry.ts")],
      outdir: assets,
      splitting: true,
      minify: true,
      sourcemap: "external",
      naming: { entry: "index-[hash].[ext]", chunk: "[name]-[hash].[ext]" },
    });
    const outputs = build.outputs.filter((o) => o.path.endsWith(".js"));
    const entry = outputs.find((o) => o.kind === "entry-point");
    const page = outputs.find((o) => o.path.includes("-cases-page-"));
    if (entry === undefined || page === undefined) {
      throw new Error("the fixture build did not split the cases page");
    }
    pageChunk = path.basename(page.path);
    entryChunk = path.basename(entry.path);
    routesDir = path.join(dir, "src/routes");
    write(manifestFile, manifestText([entryChunk]));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("finds the page code the startup carries and the page loaded late", () => {
    const read = readStartupGraph(path.join(dir, "dist"));
    if (!read.ok) {
      throw new Error(read.error);
    }

    const offenders = startupPageCode(read.graph);
    expect(offenders.map(({ kind, module }) => ({ kind, module }))).toEqual([
      { kind: "route-component", module: "src/routes/statutes.tsx" },
    ]);
    // The page's 400-byte payload is counted, the loader's is not.
    expect(offenders[0]?.bytes).toBeGreaterThanOrEqual(400);
    expect(offenders[0]?.bytes).toBeLessThan(800);

    expect(coldLoadHops(read.graph)).toEqual([
      {
        route: "/cases",
        chunk: pageChunk,
        module: "src/routes/cases/-cases-page.tsx",
        bytes: expect.any(Number),
      },
    ]);
  });

  test("a build without a Start manifest is refused, not passed", () => {
    const read = readStartupGraph(path.join(dir, "src"));

    expect(read).toEqual({
      ok: false,
      error: expect.stringContaining("Build the web app first"),
    });
  });

  test("a page an ancestor route preloads is no hop", () => {
    // The root is every route's ancestor; its preloads are linked on /cases.
    const read = readDamaged((dist) => {
      writeFileSync(
        path.join(dist, "..", manifestFile),
        manifestText([entryChunk, pageChunk]),
      );
    });
    if (!read.ok) {
      throw new Error(read.error);
    }

    expect(coldLoadHops(read.graph)).toEqual([]);
  });

  test("a build whose startup graph cannot be read is refused, by cause", () => {
    expect(
      readDamaged((dist) => {
        writeFileSync(path.join(dist, "..", manifestFile), manifestText([]));
      }),
    ).toEqual({
      ok: false,
      error: expect.stringContaining("route preloads nothing"),
    });
    expect(
      readDamaged((dist) => {
        rmSync(entryMap(dist));
      }),
    ).toEqual({
      ok: false,
      error: `${entryChunk} is an initial chunk without a sourcemap; rebuild the web app with hidden sourcemaps.`,
    });
    expect(
      readDamaged((dist) => {
        const text = readFileSync(entryMap(dist), "utf-8");
        writeFileSync(entryMap(dist), text.slice(0, text.length / 2));
      }),
    ).toEqual({
      ok: false,
      error: expect.stringContaining(`${entryChunk}.map is not valid JSON`),
    });
    expect(
      readDamaged((dist) => {
        const map = JSON.parse(readFileSync(entryMap(dist), "utf-8"));
        map.sourcesContent = map.sourcesContent.map(() => null);
        writeFileSync(entryMap(dist), JSON.stringify(map));
      }),
    ).toEqual({
      ok: false,
      error: expect.stringContaining("has no source text for src/routes/"),
    });
  });
});
