import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import oxlintConfig from "../../../oxlint.config";
import { PRODUCT_FRONTEND_FILES } from "../../../scripts/product-frontend-files";
import { MCP_APPS } from "../src/manifest";

const root = path.resolve(import.meta.dirname, "../../..");
const packageSource = "packages/mcp-apps/src";

test("every MCP app belongs to its package, manifest and product frontend policy", () => {
  const directories = readdirSync(path.join(root, packageSource), {
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isDirectory() && !["shared", "generated"].includes(entry.name),
    )
    .map(({ name }) => name)
    .toSorted();
  expect(directories).toEqual(
    MCP_APPS.map(({ directory }) => directory).toSorted(),
  );
  const misplaced = ["apps", "packages"].flatMap((area) =>
    [
      ...new Bun.Glob("*/src/**/mcp/apps/*").scanSync({
        cwd: path.join(root, area),
        onlyFiles: false,
      }),
    ].map((file) => `${area}/${file}`),
  );
  expect(misplaced).toEqual([]);
  for (const { directory } of MCP_APPS) {
    const entry = `${packageSource}/${directory}/app.tsx`;
    expect(existsSync(path.join(root, entry))).toBe(true);
    expect(
      existsSync(path.join(root, packageSource, directory, "app.html")),
    ).toBe(true);
    expect(
      PRODUCT_FRONTEND_FILES.some((glob) => new Bun.Glob(glob).match(entry)),
    ).toBe(true);
    expect(
      oxlintConfig.overrides?.some(
        ({ files, rules }) =>
          files?.some((glob) => new Bun.Glob(glob).match(entry)) &&
          rules !== undefined &&
          "no-raw-use-effect/no-raw-use-effect" in rules &&
          rules["no-raw-use-effect/no-raw-use-effect"] === "error" &&
          "require-cn-for-classname-composition/require-cn-for-classname-composition" in
            rules &&
          rules[
            "require-cn-for-classname-composition/require-cn-for-classname-composition"
          ] === "error",
      ),
    ).toBe(true);
  }
});

test("MCP app package never imports API code or API environment setup", async () => {
  const sourceRoot = path.join(root, "packages/mcp-apps");
  const files = [
    ...new Bun.Glob("{src,scripts}/**/*.{ts,tsx,js}").scanSync(sourceRoot),
  ];
  const forbidden: string[] = [];
  for (const file of files) {
    const filename = path.join(sourceRoot, file);
    const module = ts.createSourceFile(
      file,
      await Bun.file(filename).text(),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        inspect(node.moduleSpecifier.text);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        const specifier = node.arguments.at(0);
        if (specifier && ts.isStringLiteralLike(specifier)) {
          inspect(specifier.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    const inspect = (specifier: string) => {
      const resolved = path.relative(
        root,
        path.resolve(path.dirname(filename), specifier),
      );
      if (
        specifier === "@stll/api" ||
        specifier.startsWith("@stll/api/") ||
        specifier.startsWith("@/api/") ||
        resolved.startsWith("apps/api/")
      ) {
        forbidden.push(`${file}: ${specifier}`);
      }
    };
    visit(module);
  }
  expect(forbidden).toEqual([]);
});
