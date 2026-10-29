import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  type ModuleExportName,
  type Node,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree";

const exportName = (name: ModuleExportName) =>
  name.type === "Identifier" ? name.name : name.value;

const apiRoot = path.resolve(import.meta.dir, "../../..");
const guardedSymbols = new Map([
  ["s3", new Set(["writeS3ObjectWithRetry"])],
  ["file-scan/stored-object", new Set(["writeScannedObject"])],
]);

// Types require ownership at every direct and forwarded call. Keep one import
// spelling so dynamic loading and relative aliases cannot conceal the owner.
const importViolations = (file: string, source: string) => {
  const { program } = parseSource(file, source);
  const violations: string[] = [];
  const moduleOwner = (specifier: string) => {
    const resolved = specifier.startsWith(".")
      ? path.posix.normalize(
          path.posix.join(path.posix.dirname(file), specifier),
        )
      : specifier.replace("@/api/", "src/");
    for (const [module, symbols] of guardedSymbols) {
      if (resolved.replace(/\.(?:ts|js)$/u, "") === `src/lib/${module}`) {
        return { canonical: `@/api/lib/${module}`, symbols };
      }
    }
    return undefined;
  };
  walk(program, (node) => {
    let loaded: Node | undefined;
    if (node.type === "ImportExpression") {
      loaded = node.source;
    } else if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      loaded = node.arguments.at(0);
    }
    if (loaded?.type === "Literal" && typeof loaded.value === "string") {
      const owner = moduleOwner(loaded.value);
      if (owner) {
        for (const symbol of owner.symbols) {
          if (!source.includes(symbol)) {
            continue;
          }
          violations.push(`${file}:${symbol}: dynamic import`);
        }
      }
    }
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      (node.type === "ExportNamedDeclaration" && node.source !== null)
    ) {
      const specifier = node.source?.value ?? "";
      const owner = moduleOwner(specifier);
      if (owner) {
        // Named bindings list their symbols; a default, namespace or
        // side-effect import and `export *` reach every one.
        let importedSymbols = [...owner.symbols];
        if (node.type === "ImportDeclaration") {
          const named = node.specifiers.flatMap((item) =>
            item.type === "ImportSpecifier" ? [exportName(item.imported)] : [],
          );
          importedSymbols = named.length > 0 ? named : importedSymbols;
        } else if (node.type === "ExportNamedDeclaration") {
          importedSymbols = node.specifiers.map((item) =>
            exportName(item.local),
          );
        }
        for (const symbol of importedSymbols) {
          if (!owner.symbols.has(symbol)) {
            continue;
          }
          if (node.type !== "ImportDeclaration") {
            violations.push(`${file}:${symbol}: re-export`);
          } else if (specifier !== owner.canonical) {
            violations.push(`${file}:${symbol}: relative import`);
          }
        }
      }
    }
  });
  return violations;
};

describe("object write ownership imports", () => {
  test.each([
    [
      'import { writeS3ObjectWithRetry as put } from "../lib/s3";',
      "relative import",
    ],
    ['import * as storage from "../lib/s3";', "relative import"],
    [
      'const storage = await import("../lib/s3"); storage.writeS3ObjectWithRetry({ key, data });',
      "dynamic import",
    ],
    [
      'const { writeS3ObjectWithRetry } = await import("@/api/lib/s3");',
      "dynamic import",
    ],
    [
      'export { writeS3ObjectWithRetry as put } from "@/api/lib/s3";',
      "re-export",
    ],
  ])("detects concealed owner in %s", (source, violation) => {
    expect(importViolations("src/handlers/example.ts", source)).toEqual([
      `src/handlers/example.ts:writeS3ObjectWithRetry: ${violation}`,
    ]);
  });

  test("allows canonical aliases and unrelated relative imports", () => {
    expect(
      importViolations(
        "src/handlers/example.ts",
        'import { writeS3ObjectWithRetry as put } from "@/api/lib/s3"; import { getS3 } from "../lib/s3";',
      ),
    ).toEqual([]);
  });

  test("production callers use canonical static symbols", async () => {
    const files = [
      ...new Bun.Glob("{src,scripts}/**/*.ts").scanSync({ cwd: apiRoot }),
    ].filter(
      (file) => !file.endsWith(".test.ts") && !file.endsWith(".spec.ts"),
    );
    const violations: string[] = [];
    for (const file of files) {
      const source = await Bun.file(path.join(apiRoot, file)).text();
      if (!source.includes("s3") && !source.includes("stored-object")) {
        continue;
      }
      violations.push(...importViolations(file, source));
    }
    expect(violations).toEqual([]);
  });
});
