import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
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
} from "./bundle-startup-build";
import { coldLoadHops, startupPageCode } from "./bundle-startup-gates";

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
    expect(parseStartManifest("manifest.js", "export const other = 1;")).toBe(
      "manifest.js does not declare tsrStartManifest as an arrow returning an object",
    );
  });
});

describe("reading a production build", () => {
  let dir = "";
  let pageChunk = "";

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
    const routesDir = path.join(dir, "src/routes");
    write(
      "dist/server/assets/_tanstack-start-manifest_v-fixture.js",
      `export const tsrStartManifest = () => (${JSON.stringify({
        routes: {
          __root__: {
            filePath: path.join(routesDir, "__root.tsx"),
            preloads: [`/assets/${path.basename(entry.path)}`],
          },
          "/statutes": {
            filePath: path.join(routesDir, "statutes.tsx"),
            preloads: [],
          },
          "/cases": {
            filePath: path.join(routesDir, "cases.tsx"),
            preloads: [],
          },
        },
      })});\n`,
    );
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
});
