import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript6";

import { repoRelativePath } from "@stll/portable-path";
import { rejectionOf } from "@stll/property-testing/rejection";

import { readApiTypecheckConfig } from "./api-typecheck-config";
import {
  apiDeclarationCacheInputs,
  emitApiTypecheckDeclarations,
  missingDeclarationCacheInputs,
  regenerateApiDeclarationSurface,
  writeApiDeclarationSurface,
} from "./api-typecheck-declarations";
import { nativeTypecheckProgramFiles } from "./api-typecheck-inputs";
import { readTurboTypecheckInputs } from "./turbo-typecheck-inputs";

test("declarations follow public type imports without serializing runtime-only route exports", () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "api-declaration-surface-"),
  );
  try {
    writeFileSync(
      path.join(directory, "runtime.ts"),
      "export const routes = new (class { private proof = 1; readonly count = 2; })();\n",
    );
    writeFileSync(
      path.join(directory, "types.ts"),
      "export interface View { count: number }\n",
    );
    writeFileSync(
      path.join(directory, "surface.ts"),
      "import { routes } from './runtime';\nimport type { View } from './types';\nexport const view = (): View => routes;\n",
    );
    const options: ts.CompilerOptions = {
      noCheck: true,
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      rootDir: directory,
      outDir: path.join(directory, "declarations"),
      types: [],
    };
    const program = ts.createProgram(
      [path.join(directory, "surface.ts")],
      options,
    );
    // The fixture actually reaches the serialization defect under full emit.
    expect(
      program
        .emit(undefined, () => undefined)
        .diagnostics.map(({ code }) => code),
    ).toContain(4094);
    const project = path.join(directory, "tsconfig.json");
    writeFileSync(
      project,
      JSON.stringify({ compilerOptions: options, files: ["surface.ts"] }),
    );
    const result = emitApiTypecheckDeclarations(project);
    expect(result.diagnostics).toEqual([]);
    expect(result.files.toSorted()).toEqual(
      ["surface.ts", "types.ts"]
        .map((file) => path.join(directory, file))
        .toSorted(),
    );
    expect(
      readFileSync(path.join(directory, "declarations/surface.d.ts"), "utf-8"),
    ).toContain("View");
    expect(existsSync(path.join(directory, "declarations/runtime.d.ts"))).toBe(
      false,
    );
    // A removed exported type must not survive from an earlier cached emit.
    writeFileSync(
      path.join(directory, "surface.ts"),
      "export type View = number;\n",
    );
    expect(emitApiTypecheckDeclarations(project).diagnostics).toEqual([]);
    expect(existsSync(path.join(directory, "declarations/types.d.ts"))).toBe(
      false,
    );
    writeFileSync(
      path.join(directory, "surface.ts"),
      "export { routes } from './runtime';\n",
    );
    expect(
      emitApiTypecheckDeclarations(project).diagnostics.map(({ code }) => code),
    ).toContain(4094);
    expect(existsSync(path.join(directory, "declarations/runtime.d.ts"))).toBe(
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Modules whose names say nothing are boundaries by what they build.
const BOUNDARY_CONSTRUCTION: Readonly<Record<string, string>> = {
  "handlers/example/events.ts":
    'import { routes } from "@/api/http/route"; export const route = routes({}); ',
  "handlers/example/group.ts":
    'import { mount as nest } from "@/api/http/route"; export const group = nest([]); ',
  "handlers/example/table.ts":
    'import * as http from "../../http/route"; export const table = http.routes({}); ',
  "handlers/example/serve.ts":
    'import { createHttpApp } from "@/api/http/app"; export const app = createHttpApp({ routes: [] }); ',
  "mcp/server-core.ts":
    'import { Server } from "@modelcontextprotocol/server"; export const server = new Server(); ',
};

/** A surface that reaches `module` (holding `source`) through a bridge. */
const withBridgedModule = (
  module: string,
  source: string,
  check: (paths: {
    directory: string;
    project: string;
    surface: string;
    bridge: string;
    target: string;
  }) => void,
) => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "api-declaration-boundary-"),
  );
  try {
    const sourceRoot = path.join(directory, "apps/api/src");
    const target = path.join(sourceRoot, module);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${source}export interface View { count: number }\n`);
    const bridge = path.join(sourceRoot, "bridge.ts");
    writeFileSync(
      bridge,
      `export type { View } from "./${module.replace(/\.ts$/u, "")}";\n`,
    );
    const surface = path.join(sourceRoot, "surface.ts");
    writeFileSync(surface, 'export type { View } from "./bridge";\n');
    const project = path.join(directory, "tsconfig.json");
    writeFileSync(
      project,
      JSON.stringify({
        compilerOptions: {
          noCheck: true,
          noEmit: false,
          declaration: true,
          emitDeclarationOnly: true,
          rootDir: directory,
          outDir: path.join(directory, "declarations"),
          types: [],
        },
        files: [surface],
      }),
    );
    check({ directory, project, surface, bridge, target });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test.each([
  "lib/auth.ts",
  "server.ts",
  "handlers/example/routes.ts",
  "handlers/example/run-route.ts",
  ...Object.keys(BOUNDARY_CONSTRUCTION),
])(
  "declarations reject retained runtime boundaries and report the import chain: %s",
  (module) => {
    withBridgedModule(
      module,
      BOUNDARY_CONSTRUCTION[module] ?? "",
      ({ directory, project, surface, bridge, target }) => {
        expect(() => emitApiTypecheckDeclarations(project)).toThrow(
          `Forbidden API runtime declaration dependency: ${surface} -> ${bridge} -> ${target}`,
        );
        expect(existsSync(path.join(directory, "declarations"))).toBe(false);
      },
    );
  },
);

test.each([
  [
    "a type-only import of the route module",
    'import type { RouteGroup } from "@/api/http/route"; export type Group = RouteGroup; ',
  ],
  [
    "a local function that shares a builder's name",
    "const routes = (count: number) => count; export const total = routes(1); ",
  ],
  [
    "a builder of the same name from another module",
    'import { routes } from "@/api/lib/route-names"; export const names = routes(); ',
  ],
])("declarations keep a module that builds no routes: %s", (_, source) => {
  withBridgedModule(
    "handlers/example/view.ts",
    source,
    ({ directory, project }) => {
      expect(emitApiTypecheckDeclarations(project).diagnostics).toEqual([]);
      expect(
        existsSync(
          path.join(directory, "declarations/apps/api/src/surface.d.ts"),
        ),
      ).toBe(true);
    },
  );
});

test("declaration cache inputs cover roots and transitive emitted dependencies without directory exclusions", () => {
  const root = mkdtempSync(path.join(tmpdir(), "api-declaration-inputs-"));
  const api = path.join(root, "apps/api");
  const project = path.join(api, "tsconfig.declarations.json");
  const manifest = path.join(
    api,
    "src/handlers/visual-sandbox/browser/manifest.ts",
  );
  const leaf = path.join(
    api,
    "src/handlers/visual-sandbox/browser/build/leaf.ts",
  );
  mkdirSync(path.dirname(leaf), { recursive: true });
  try {
    writeFileSync(manifest, "export type { Contract } from './build/leaf';\n");
    writeFileSync(leaf, "export type Contract = string;\n");
    writeFileSync(
      project,
      JSON.stringify({
        compilerOptions: {
          noCheck: true,
          declaration: true,
          emitDeclarationOnly: true,
          rootDir: ".",
          outDir: "declarations",
          types: [],
        },
        files: ["src/handlers/visual-sandbox/browser/manifest.ts"],
      }),
    );
    const inputs = apiDeclarationCacheInputs(project);
    expect(inputs).toContain("**");
    expect(inputs).not.toContain("!src/handlers/visual-sandbox/browser/**");
    const writeInputs = (values: string[]) =>
      writeFileSync(
        path.join(root, "turbo.json"),
        JSON.stringify({
          tasks: {
            "@stll/api#generate:typecheck-declarations": { inputs: values },
          },
        }),
      );
    writeInputs(inputs);
    const result = emitApiTypecheckDeclarations(project);
    expect(result.diagnostics).toEqual([]);
    expect(result.files.toSorted()).toEqual([manifest, leaf].toSorted());
    expect(missingDeclarationCacheInputs(result.files, project)).toEqual([]);
    for (const removed of [manifest, leaf]) {
      writeInputs([...inputs, `!${repoRelativePath(api, removed)}`]);
      expect(missingDeclarationCacheInputs(result.files, project)).toEqual([
        removed,
      ]);
      expect(() => emitApiTypecheckDeclarations(project)).toThrow(
        "Emitted API sources missing from declaration cache inputs",
      );
    }
    writeInputs([...inputs, "!src/handlers/visual-sandbox/browser/**"]);
    expect(
      missingDeclarationCacheInputs(result.files, project).toSorted(),
    ).toEqual(result.files.toSorted());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["server-analytics.ts"])(
  "shared utilities remain serializable without admitting runtime routes: %s",
  (filename) => {
    const root = mkdtempSync(path.join(tmpdir(), "api-schema-boundary-"));
    const source = path.join(root, `apps/api/src/lib/${filename}`);
    try {
      mkdirSync(path.dirname(source), { recursive: true });
      writeFileSync(source, "export interface Schema { value: string }\n");
      const project = path.join(root, "tsconfig.json");
      writeFileSync(
        project,
        JSON.stringify({
          compilerOptions: {
            noCheck: true,
            declaration: true,
            emitDeclarationOnly: true,
            rootDir: root,
            outDir: path.join(root, "declarations"),
            types: [],
          },
          files: [source],
        }),
      );
      expect(emitApiTypecheckDeclarations(project).diagnostics).toEqual([]);
      expect(
        existsSync(
          path.join(
            root,
            `declarations/apps/api/src/lib/${filename.replace(/\.ts$/u, ".d.ts")}`,
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("source-only route assertions do not enter the declaration surface", () => {
  const root = mkdtempSync(path.join(tmpdir(), "api-route-assertion-"));
  const source = path.join(root, "apps/api/src");
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(
      path.join(source, "routes.ts"),
      'export type RouteId = "/example";\n',
    );
    writeFileSync(
      path.join(source, "policy.ts"),
      'import type { RouteId } from "./routes"; export const policy = { "/example": "browse" } as const satisfies Record<RouteId, string>;\n',
    );
    const project = path.join(root, "tsconfig.json");
    writeFileSync(
      project,
      JSON.stringify({
        compilerOptions: {
          noCheck: true,
          declaration: true,
          emitDeclarationOnly: true,
          rootDir: root,
          outDir: path.join(root, "declarations"),
          types: [],
        },
        files: [path.join(source, "policy.ts")],
      }),
    );
    const result = emitApiTypecheckDeclarations(project);
    expect(result.diagnostics).toEqual([]);
    expect(result.files).toEqual([path.join(source, "policy.ts")]);
    expect(
      readFileSync(
        path.join(root, "declarations/apps/api/src/policy.d.ts"),
        "utf-8",
      ),
    ).toContain('readonly "/example": "browse"');
    expect(
      existsSync(path.join(root, "declarations/apps/api/src/routes.d.ts")),
    ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace symlink imports hash their source files and satisfy emitted-input coverage", () => {
  const root = mkdtempSync(path.join(tmpdir(), "api-workspace-inputs-"));
  const api = path.join(root, "apps/api");
  const shared = path.join(root, "packages/shared");
  const project = path.join(api, "tsconfig.declarations.json");
  try {
    mkdirSync(path.join(api, "src"), { recursive: true });
    mkdirSync(path.join(api, "node_modules/@stll"), { recursive: true });
    mkdirSync(path.join(shared, "src"), { recursive: true });
    writeFileSync(
      path.join(shared, "package.json"),
      JSON.stringify({ name: "@stll/shared", types: "src/contract.ts" }),
    );
    writeFileSync(
      path.join(shared, "src/contract.ts"),
      "export interface Contract { value: string }\n",
    );
    symlinkSync(shared, path.join(api, "node_modules/@stll/shared"), "dir");
    writeFileSync(
      path.join(api, "src/surface.ts"),
      'export type { Contract } from "@stll/shared";\n',
    );
    writeFileSync(
      project,
      JSON.stringify({
        compilerOptions: {
          noCheck: true,
          declaration: true,
          emitDeclarationOnly: true,
          preserveSymlinks: true,
          rootDir: "../..",
          outDir: ".cache/declarations",
          types: [],
        },
        files: ["src/surface.ts"],
      }),
    );
    const inputs = apiDeclarationCacheInputs(project);
    expect(inputs).toContain("$TURBO_ROOT$/packages/shared/**");
    expect(
      inputs.some(
        (file) => !file.startsWith("!") && file.includes("node_modules"),
      ),
    ).toBe(false);
    writeFileSync(
      path.join(root, "turbo.json"),
      JSON.stringify({
        tasks: { "@stll/api#generate:typecheck-declarations": { inputs } },
      }),
    );
    const result = emitApiTypecheckDeclarations(project);
    expect(result.diagnostics).toEqual([]);
    expect(result.files).toHaveLength(2);
    expect(missingDeclarationCacheInputs(result.files, project)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("declaration aliases resolve transitive API contracts without checking their source", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "api-declaration-alias-"));
  const api = path.join(root, "apps/api");
  try {
    mkdirSync(path.join(api, "src"), { recursive: true });
    writeFileSync(
      path.join(api, "src/leaf.ts"),
      "export interface View { count: number }\n",
    );
    writeFileSync(
      path.join(api, "src/runtime.ts"),
      "export const runtime = { count: 1 };\n",
    );
    writeFileSync(
      path.join(api, "src/surface.ts"),
      [
        'import type { View } from "@/api/leaf";',
        'import { runtime } from "./runtime";',
        'export type { View } from "@/api/leaf";',
        'export type Reference = import("@/api/leaf").View;',
        "export const get = (): View => runtime;",
      ].join("\n"),
    );
    const options = {
      module: "ESNext",
      moduleResolution: "Bundler",
      types: [],
      paths: { "@/api/*": ["./src/*"] },
    };
    const project = path.join(api, "tsconfig.declarations.json");
    writeFileSync(
      project,
      JSON.stringify({
        compilerOptions: {
          ...options,
          composite: true,
          noCheck: true,
          declaration: true,
          emitDeclarationOnly: true,
          rootDir: ".",
          outDir: ".cache/declarations",
        },
        files: ["src/surface.ts"],
        include: [],
      }),
    );
    const emitted = emitApiTypecheckDeclarations(project);
    expect(emitted.diagnostics).toEqual([]);
    expect(writeApiDeclarationSurface(project, emitted.files)).toEqual([
      "src/leaf.ts",
      "src/surface.ts",
    ]);
    const declaration = readFileSync(
      path.join(api, ".cache/declarations/src/surface.d.ts"),
      "utf-8",
    );
    expect(declaration.match(/@\/api\/leaf/gu)).toHaveLength(3);
    writeFileSync(
      path.join(api, "consumer.test.ts"),
      'import { get } from "./src/surface"; export const count: number = get().count;\n',
    );
    const consumer = path.join(api, "tsconfig.consumer.json");
    writeFileSync(
      consumer,
      JSON.stringify({
        compilerOptions: {
          ...options,
          noEmit: true,
          disableSourceOfProjectReferenceRedirect: true,
        },
        references: [{ path: "./tsconfig.declarations.json" }],
        files: ["consumer.test.ts"],
        include: [],
      }),
    );
    const check = Bun.spawnSync(
      [
        process.execPath,
        "check",
        "--no-pretty",
        "--all",
        `--project=${consumer}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(
      check.exitCode,
      check.stdout.toString() + check.stderr.toString(),
    ).toBe(0);
    const list = Bun.spawnSync(
      [
        process.execPath,
        "check",
        "--no-pretty",
        "--all",
        "--listFilesOnly",
        `--project=${consumer}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(list.exitCode).toBe(0);
    const files = list.stdout.toString().split(/\r?\n/u);
    expect(
      files.some((file) => file.endsWith("/src/leaf.d.ts")),
      list.stdout.toString(),
    ).toBe(true);
    expect(files.some((file) => file.endsWith("/src/leaf.ts"))).toBe(false);
    expect(files.some((file) => file.endsWith("/src/runtime.ts"))).toBe(false);
    expect(files.some((file) => file.endsWith("/src/surface.ts"))).toBe(false);
    const turbo = path.join(root, "turbo.json");
    writeFileSync(
      turbo,
      `// retain configuration comments\n${JSON.stringify({
        tasks: {
          "@stll/api#generate:typecheck-declarations": {
            inputs: apiDeclarationCacheInputs(project),
          },
        },
      })}\n`,
    );
    writeFileSync(path.join(api, "src/extra.ts"), "export const extra = 1;\n");
    writeFileSync(
      path.join(api, "consumer.test.ts"),
      'import { extra } from "./src/extra"; export const count: number = extra;\n',
    );
    const regenerated = await regenerateApiDeclarationSurface(
      project,
      "update-inputs",
    );
    expect(regenerated.diagnostics).toEqual([]);
    expect(readFileSync(turbo, "utf-8")).toContain(
      "// retain configuration comments",
    );
    const producer = "@stll/api#generate:typecheck-declarations";
    const generated = readTurboTypecheckInputs(turbo);
    expect(generated.tasks[producer]?.inputs).toContain("**");
    writeFileSync(
      turbo,
      JSON.stringify({ tasks: { [producer]: { inputs: [] } } }),
    );
    expect(() => emitApiTypecheckDeclarations(project)).toThrow(
      "Emitted API sources missing from declaration cache inputs",
    );
    expect(
      (await regenerateApiDeclarationSurface(project, "update-inputs"))
        .diagnostics,
    ).toEqual([]);
    const stale = JSON.parse(readFileSync(project, "utf-8"));
    stale.files.push("src/deleted.ts");
    writeFileSync(project, JSON.stringify(stale));
    const testsProject = path.join(api, "tsconfig.tests.json");
    const staleTests = JSON.parse(readFileSync(consumer, "utf-8"));
    staleTests.files.push("src/deleted.test.ts");
    writeFileSync(testsProject, JSON.stringify(staleTests));
    expect(() => emitApiTypecheckDeclarations(project)).toThrow(
      "Missing declaration source",
    );
    expect(
      (await regenerateApiDeclarationSurface(project)).diagnostics,
    ).toEqual([]);
    expect(JSON.parse(readFileSync(project, "utf-8")).files).not.toContain(
      "src/deleted.ts",
    );
    expect(JSON.parse(readFileSync(testsProject, "utf-8")).files).toEqual([
      "consumer.test.ts",
    ]);
    expect(JSON.parse(readFileSync(project, "utf-8")).files).toContain(
      "src/extra.ts",
    );
    expect(
      readFileSync(
        path.join(api, ".cache/declarations/src/extra.d.ts"),
        "utf-8",
      ),
    ).toContain("export declare const extra = 1;");
    const closed = Bun.spawnSync(
      [process.execPath, "check", "--listFilesOnly", `--project=${consumer}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(closed.exitCode).toBe(0);
    expect(closed.stdout.toString()).not.toContain(
      path.join(api, "src/extra.ts"),
    );
    const surfaceConfig = JSON.parse(readFileSync(project, "utf-8"));
    surfaceConfig.files = ["src/surface.ts"];
    writeFileSync(project, JSON.stringify(surfaceConfig));
    writeFileSync(
      path.join(api, "src/extra.ts"),
      'import { routes } from "@/api/http/route"; export const extra = routes({});\n',
    );
    expect(
      await rejectionOf(regenerateApiDeclarationSurface(project)),
    ).toMatchObject({
      message: expect.stringContaining(
        "Forbidden API runtime declaration dependency",
      ),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("stable wrappers prepare and restore exact roots and owners without committed config churn", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "api-prepared-projects-"));
  const api = path.join(root, "apps/api");
  const write = (file: string, value: unknown) => {
    const target = path.join(api, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(
      target,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  try {
    write("tsconfig.json", {
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        types: [],
        noEmit: true,
      },
      include: ["src"],
    });
    write("tsconfig.declarations.json", {
      extends: [
        "./tsconfig.json",
        "./.cache/typecheck-declarations/roots.json",
      ],
      include: [],
      compilerOptions: {
        composite: true,
        noCheck: true,
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: "../..",
        outDir: "./.cache/typecheck-declarations",
      },
    });
    write("tsconfig.src.json", {
      extends: ["./tsconfig.json", "./.cache/typecheck-declarations/src.json"],
    });
    write("tsconfig.tests.json", {
      extends: [
        "./tsconfig.json",
        "./.cache/typecheck-declarations/tests.json",
      ],
      compilerOptions: { disableSourceOfProjectReferenceRedirect: true },
      references: [{ path: "./tsconfig.declarations.json" }],
      include: [],
    });
    write("src/value.ts", "export const value = 1;\n");
    write(
      "src/value.test.ts",
      "import { value } from './value'; export const checked: number = value;\n",
    );
    write("src/routes.ts", "export const route = 1;\n");
    write(
      "src/routes.test.ts",
      "import { route } from './routes'; export const checked = route;\n",
    );
    const project = path.join(api, "tsconfig.declarations.json");
    const wrappers = [
      project,
      path.join(api, "tsconfig.src.json"),
      path.join(api, "tsconfig.tests.json"),
    ];
    const turbo = path.join(root, "turbo.json");
    const turboSource = JSON.stringify({
      tasks: {
        "@stll/api#generate:typecheck-declarations": { inputs: ["**"] },
      },
    });
    writeFileSync(turbo, turboSource);
    const before = wrappers.map((file) => readFileSync(file, "utf-8"));
    expect(() => readApiTypecheckConfig(project)).toThrow(
      "run bun --filter @stll/api generate:typecheck-declarations",
    );
    expect(
      (await regenerateApiDeclarationSurface(project)).diagnostics,
    ).toEqual([]);
    expect(readApiTypecheckConfig(project).fileNames).toEqual([
      path.join(api, "src/value.ts"),
    ]);
    expect(
      readApiTypecheckConfig(path.join(api, "tsconfig.tests.json")).fileNames,
    ).toEqual([path.join(api, "src/value.test.ts")]);
    expect(
      readApiTypecheckConfig(path.join(api, "tsconfig.src.json")).fileNames,
    ).toContain(path.join(api, "src/routes.test.ts"));
    write("src/extra.ts", "export type Extra = string;\n");
    write(
      "src/value.ts",
      "export type { Extra } from './extra'; export const value = 1;\n",
    );
    expect(
      (await regenerateApiDeclarationSurface(project)).diagnostics,
    ).toEqual([]);
    expect(readApiTypecheckConfig(project).fileNames).toContain(
      path.join(api, "src/extra.ts"),
    );
    expect(wrappers.map((file) => readFileSync(file, "utf-8"))).toEqual(before);
    expect(readFileSync(turbo, "utf-8")).toBe(turboSource);
    const output = path.join(api, ".cache/typecheck-declarations");
    const cached = path.join(root, "cached");
    cpSync(output, cached, { recursive: true });
    rmSync(output, { recursive: true });
    expect(() => readApiTypecheckConfig(project)).toThrow(
      "Missing prepared API typecheck config",
    );
    cpSync(cached, output, { recursive: true });
    expect(readApiTypecheckConfig(project).fileNames).toContain(
      path.join(api, "src/extra.ts"),
    );
    const files = nativeTypecheckProgramFiles(
      path.join(api, "tsconfig.tests.json"),
    );
    expect(files).not.toContain(path.join(api, "src/value.ts"));
    expect(files.some((file) => file.endsWith("/value.d.ts"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
