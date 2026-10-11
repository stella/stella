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
    const entry = path.join(secondarySource, "entry.ts");

    try {
      writeFileSync(importedSource, "export const implementation = 1;\n");
      writeFileSync(importedDeclaration, "declare const generated: string;\n");
      writeFileSync(
        entry,
        'import { implementation } from "../../api/src/implementation";\n' +
          'import "../../api/src/generated";\n' +
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
            types: [],
          },
          files: [entry],
        }),
      );
      const files = secondaryProgramFiles(config);
      expect(files).toContain(importedSource);
      expect(files).toContain(importedDeclaration);
      expect(
        apiSourceBoundaryViolations(files, apiSource).map((file) =>
          path.basename(file),
        ),
      ).toEqual(["implementation.ts"]);

      const declarationsProject = path.join(root, "tsconfig.declarations.json");
      const output = path.join(root, "declarations/implementation.d.ts");
      const writeDeclarationConfig = (rootFiles: string[]) =>
        writeFileSync(
          declarationsProject,
          JSON.stringify({
            compilerOptions: {
              declaration: true,
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
