import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

import { emitApiTypecheckDeclarations } from "./api-typecheck-declarations";

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

test.each([
  "lib/auth.ts",
  "server.ts",
  "handlers/example/routes.ts",
  "handlers/example/run-route.ts",
  "handlers/example/events.ts",
  "mcp/server-core.ts",
])(
  "declarations reject retained runtime boundaries and report the import chain: %s",
  (module) => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "api-declaration-boundary-"),
    );
    try {
      const sourceRoot = path.join(directory, "apps/api/src");
      const forbidden = path.join(sourceRoot, module);
      mkdirSync(path.dirname(forbidden), { recursive: true });
      writeFileSync(
        forbidden,
        module.endsWith("events.ts")
          ? 'import Application from "elysia"; export const route = new Application(); export interface View { count: number }\n'
          : "export interface View { count: number }\n",
      );
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
      expect(() => emitApiTypecheckDeclarations(project)).toThrow(
        `Forbidden API runtime declaration dependency: ${surface} -> ${bridge} -> ${forbidden}`,
      );
      expect(existsSync(path.join(directory, "declarations"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
