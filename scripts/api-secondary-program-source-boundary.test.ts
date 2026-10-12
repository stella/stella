import { describe, expect, test } from "bun:test";
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
  apiSourceBoundaryViolations,
  secondaryImportBoundaryViolations,
  secondaryProgramFiles,
} from "./api-secondary-program-source-boundary";

describe("secondary TypeScript API source boundary", () => {
  test("rejects every executable source extension while allowing declarations and data", () => {
    const sourceRoot = path.join(tmpdir(), "api-boundary/src");
    const implementations = [
      "ts",
      "tsx",
      "mts",
      "cts",
      "js",
      "jsx",
      "mjs",
      "cjs",
    ].map((extension) => path.join(sourceRoot, `implementation.${extension}`));
    const assets = ["d.ts", "d.mts", "d.cts", "json"].map((extension) =>
      path.join(sourceRoot, `asset.${extension}`),
    );
    expect(
      apiSourceBoundaryViolations([...implementations, ...assets], sourceRoot),
    ).toEqual(implementations);
  });

  test("non-emitting root scripts keep explicit TypeScript imports across declaration references", () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "api-import-extension-")),
    );
    const api = path.join(root, "apps/api");
    const source = path.join(api, "src/value.ts");
    const output = path.join(
      api,
      ".cache/typecheck-declarations/apps/api/src/value.d.ts",
    );
    const project = path.join(root, "tsconfig.scripts.json");
    try {
      mkdirSync(path.dirname(source), { recursive: true });
      mkdirSync(path.dirname(output), { recursive: true });
      mkdirSync(path.join(root, "scripts"));
      writeFileSync(source, "export const value = 1;\n");
      writeFileSync(output, "export declare const value = 1;\n");
      writeFileSync(
        path.join(root, "scripts/entry.ts"),
        'import { value } from "../apps/api/src/value.ts";\nvoid value;\n',
      );
      writeFileSync(
        path.join(api, "tsconfig.declarations.json"),
        JSON.stringify({
          compilerOptions: {
            composite: true,
            noCheck: true,
            declaration: true,
            emitDeclarationOnly: true,
            rootDir: root,
            outDir: path.join(api, ".cache/typecheck-declarations"),
            types: [],
          },
          files: [source],
        }),
      );
      const check = (rewrite?: "rewrite") => {
        writeFileSync(
          project,
          JSON.stringify({
            extends: path.resolve(import.meta.dir, "../tsconfig.scripts.json"),
            compilerOptions: {
              types: [],
              paths: {},
              tsBuildInfoFile: path.join(root, "cache.json"),
              ...(rewrite === "rewrite"
                ? { rewriteRelativeImportExtensions: true }
                : {}),
            },
            files: ["scripts/entry.ts"],
            include: [],
            references: [{ path: "./apps/api/tsconfig.declarations.json" }],
          }),
        );
        const result = Bun.spawnSync(
          [process.execPath, "check", "--all", "--project", project],
          { stdout: "pipe", stderr: "pipe" },
        );
        return {
          code: result.exitCode,
          output: result.stdout.toString() + result.stderr.toString(),
        };
      };
      const rewritten = check("rewrite");
      expect(rewritten.code, rewritten.output).toBe(1);
      expect(rewritten.output).toContain("TS2878");
      const preserved = check();
      expect(preserved.code, preserved.output).toBe(0);
      const files = secondaryProgramFiles(project);
      expect(files).toContain(output);
      expect(apiSourceBoundaryViolations(files, path.dirname(source))).toEqual(
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects an implementation source imported into a secondary program", () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "api-source-boundary-")),
    );
    const apiSource = path.join(root, "apps/api/src");
    const secondarySource = path.join(root, "apps/secondary/src");
    mkdirSync(apiSource, { recursive: true });
    mkdirSync(secondarySource, { recursive: true });
    const importedSource = path.join(apiSource, "implementation.ts");
    const importedDeclaration = path.join(apiSource, "generated.d.ts");
    const importedJavaScript = path.join(apiSource, "runtime.mjs");
    const importedData = path.join(apiSource, "inventory.json");
    const entry = path.join(secondarySource, "entry.ts");

    try {
      writeFileSync(importedSource, "export const implementation = 1;\n");
      writeFileSync(importedDeclaration, "declare const generated: string;\n");
      writeFileSync(importedJavaScript, "export const runtime = 1;\n");
      writeFileSync(importedData, '{"entries": []}\n');
      writeFileSync(
        entry,
        'import { implementation } from "../../api/src/implementation";\n' +
          'import "../../api/src/generated";\n' +
          'import "../../api/src/runtime.mjs";\n' +
          'import inventory from "../../api/src/inventory.json";\n' +
          "void inventory;\n" +
          "void implementation;\n",
      );

      const config = path.join(root, "tsconfig.json");
      writeFileSync(
        config,
        JSON.stringify({
          compilerOptions: {
            module: "ESNext",
            moduleResolution: "Bundler",
            target: "ESNext",
            checkers: 1,
            allowJs: true,
            resolveJsonModule: true,
            types: [],
          },
          files: [entry],
        }),
      );
      const files = secondaryProgramFiles(config);
      expect(files).toContain(importedSource);
      expect(files).toContain(importedDeclaration);
      expect(files).toContain(importedJavaScript);
      expect(files).toContain(importedData);
      expect(
        apiSourceBoundaryViolations(files, apiSource).map((file) =>
          path.basename(file),
        ),
      ).toEqual(["implementation.ts", "runtime.mjs"]);

      const declarationsProject = path.join(root, "tsconfig.declarations.json");
      const output = path.join(root, "declarations/implementation.d.ts");
      const writeDeclarationConfig = (rootFiles: string[]) =>
        writeFileSync(
          declarationsProject,
          JSON.stringify({
            compilerOptions: {
              declaration: true,
              checkers: 1,
              emitDeclarationOnly: true,
              rootDir: apiSource,
              outDir: path.dirname(output),
              types: [],
            },
            files: rootFiles,
          }),
        );
      const importViolations = () =>
        secondaryImportBoundaryViolations({
          project: config,
          declarationsProject,
          sourceRoot: apiSource,
        });
      writeDeclarationConfig([importedSource]);
      expect(importViolations()).toEqual([
        `${entry}: missing API declaration ../../api/src/implementation`,
      ]);
      mkdirSync(path.dirname(output));
      writeFileSync(output, "export declare const implementation = 1;\n");
      expect(importViolations()).toEqual([]);
      writeDeclarationConfig([importedDeclaration]);
      expect(importViolations()).toEqual([
        `${entry}: unsupported API import ../../api/src/implementation`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
