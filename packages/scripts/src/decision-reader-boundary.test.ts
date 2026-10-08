import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { canonicalModuleId } from "../../../.oxlint-plugins/module-id";

const packageRoot = path.resolve(import.meta.dirname, "../../decision-reader");
const productionDependencyRoots = new Set([
  "@fontsource-variable/source-serif-4",
  "react",
  "react-dom",
  "better-result",
  "valibot",
  "@stll/api-contract",
  "@stll/clipboard",
  "@stll/legal-ast",
  "@stll/legal-atlas",
  "@stll/text-normalize",
  "@stll/ui",
]);

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const reactEffects = new Set([
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
]);

const lifecycleViolations = (source: string) => {
  const tree = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "react"
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (reactEffects.has(imported)) {
            violations.push(imported);
          }
        }
      }
    }
    // Count global references as well as calls: assigning fetch to an alias
    // must not bypass the package's network boundary.
    if (
      ts.isIdentifier(node) &&
      (node.text === "fetch" || node.text === "XMLHttpRequest") &&
      (!ts.isPropertyAccessExpression(node.parent) || node.parent.name !== node)
    ) {
      violations.push(node.text);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const member = node.name.text;
      const globalOwner =
        ts.isIdentifier(node.expression) &&
        ["window", "globalThis", "self"].includes(node.expression.text);
      if (
        reactEffects.has(member) ||
        (globalOwner && (member === "fetch" || member === "XMLHttpRequest"))
      ) {
        violations.push(member);
      }
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      const member = node.argumentExpression.text;
      const globalOwner =
        ts.isIdentifier(node.expression) &&
        ["window", "globalThis", "self"].includes(node.expression.text);
      if (
        reactEffects.has(member) ||
        (globalOwner && (member === "fetch" || member === "XMLHttpRequest"))
      ) {
        violations.push(member);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return violations;
};

const manifest: {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
} = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf-8"));
const declaredDependencies = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);

const dependencyRoot = (specifier: string) =>
  specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/").at(0);

const moduleSpecifiers = (source: string) => {
  const tree = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression;
      specifiers.push(
        expression && ts.isStringLiteral(expression)
          ? expression.text
          : "<computed module specifier>",
      );
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const argument = node.arguments.at(0);
      specifiers.push(
        argument &&
          (ts.isStringLiteral(argument) ||
            ts.isNoSubstitutionTemplateLiteral(argument))
          ? argument.text
          : "<computed module specifier>",
      );
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return specifiers;
};

const boundaryViolations = (file: string, source: string) =>
  moduleSpecifiers(source).filter((specifier) => {
    if (specifier.startsWith(".")) {
      const destination = path.resolve(path.dirname(file), specifier);
      return (
        destination !== packageRoot &&
        !destination.startsWith(`${packageRoot}${path.sep}`)
      );
    }
    const root = dependencyRoot(specifier);
    return (
      root === undefined ||
      !productionDependencyRoots.has(root) ||
      !declaredDependencies.has(root)
    );
  });

test("reader production dependencies contain only rendering and data contracts", () => {
  expect(
    [...declaredDependencies].filter(
      (name) => !productionDependencyRoots.has(name),
    ),
  ).toEqual([]);
});

test("reader production imports stay inside its context-free boundary", () => {
  for (const relativeFile of new Bun.Glob(
    "src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  ).scanSync({ cwd: packageRoot })) {
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(relativeFile)) {
      continue;
    }
    const file = path.join(packageRoot, relativeFile);
    const source = readFileSync(file, "utf-8");
    expect(boundaryViolations(file, source), relativeFile).toEqual([]);
    expect(lifecycleViolations(source), relativeFile).toEqual([]);
  }
});

for (const effect of reactEffects) {
  for (const mutation of [
    `import { ${effect} as sync } from "react";`,
    `import * as React from "react"; React.${effect}(() => {});`,
    `import React from "react"; React["${effect}"](() => {});`,
    `import React from "react"; const sync = React.${effect}; sync(() => {});`,
  ]) {
    test(`reader boundary rejects lifecycle effect: ${mutation}`, () => {
      expect(lifecycleViolations(mutation)).toEqual([effect]);
    });
  }
}

for (const mutation of [
  "fetch('/api');",
  "globalThis.fetch('/api');",
  "window['fetch']('/api');",
  "new XMLHttpRequest();",
  "new self.XMLHttpRequest();",
  "const request = fetch; request('/api');",
  "const request = globalThis.fetch; request('/api');",
]) {
  test(`reader boundary rejects network access: ${mutation}`, () => {
    expect(lifecycleViolations(mutation)).toHaveLength(1);
  });
}

// Migration tombstones: all web modules removed when the shared reader took ownership.
const removedReaderPaths = [
  "apps/web/src/components/legal-reader/annotations/annotation-anchors.test.ts",
  "apps/web/src/components/legal-reader/annotations/annotation-anchors.tsx",
  "apps/web/src/components/legal-reader/citation-link.tsx",
  "apps/web/src/components/legal-reader/document-ast-text.tsx",
  "apps/web/src/components/legal-reader/query-marks.test.ts",
  "apps/web/src/components/legal-reader/query-marks.ts",
  "apps/web/src/components/legal-reader/reader-inset-box.tsx",
  "apps/web/src/components/legal-reader/reader-landing.ts",
  "apps/web/src/components/legal-reader/reader-outline.test.ts",
  "apps/web/src/components/legal-reader/reader-outline.ts",
  "apps/web/src/components/legal-reader/reader-search.test.ts",
  "apps/web/src/components/legal-reader/reader-search.ts",
  "apps/web/src/components/legal-reader/reader-text-scale.logic.ts",
  "apps/web/src/components/legal-reader/reader.css",
  "apps/web/src/components/legal-reader/source-link-policy.test.tsx",
  "apps/web/src/components/legal-reader/source-link-policy.tsx",
  "apps/web/src/components/legal-reader/use-reader-text-scale.ts",
  "apps/web/src/features/case-law/citation-anchors.ts",
  "apps/web/src/features/case-law/components/case-viewer/decision-body-state.logic.ts",
  "apps/web/src/features/case-law/components/case-viewer/decision-text.logic.ts",
  "apps/web/src/features/case-law/components/case-viewer/decision-text.tsx",
  "apps/web/src/features/case-law/components/case-viewer/headnote-block.tsx",
  "apps/web/src/features/case-law/fallback-legal-anchors.test.ts",
  "apps/web/src/features/case-law/fallback-legal-anchors.ts",
  "apps/web/src/features/case-law/provision-anchors.test.ts",
  "apps/web/src/features/case-law/provision-anchors.ts",
  "apps/web/src/lib/sanitize-href.test.ts",
  "apps/web/src/lib/sanitize-href.ts",
] as const;
const removedReaderModules = new Set(
  removedReaderPaths.map((file) => canonicalModuleId(file, "")),
);

const removedReaderImportViolations = (file: string, source: string) => {
  const specifiers = file.endsWith(".css")
    ? [
        ...source
          .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
          .matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gu),
      ].map((match) => match[1] ?? "")
    : moduleSpecifiers(source);
  return specifiers.filter((specifier) =>
    removedReaderModules.has(
      canonicalModuleId(specifier.replace(/[?#].*$/u, ""), file),
    ),
  );
};

test("web has no second owner for any extracted reader module", () => {
  expect(
    removedReaderPaths.filter((file) =>
      existsSync(path.join(repositoryRoot, file)),
    ),
  ).toEqual([]);
});

test("source imports never reference any removed reader module", () => {
  const violations: { file: string; specifier: string }[] = [];
  for (const pattern of [
    "apps/*/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,css}",
    "packages/*/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,css}",
    "scripts/**/*.{ts,tsx,js,jsx}",
    ".oxlint-plugins/**/*.{ts,tsx,js,jsx}",
  ]) {
    for (const file of new Bun.Glob(pattern).scanSync({
      cwd: repositoryRoot,
    })) {
      for (const specifier of removedReaderImportViolations(
        file,
        readFileSync(path.join(repositoryRoot, file), "utf-8"),
      )) {
        violations.push({ file, specifier });
      }
    }
  }
  expect(violations).toEqual([]);
}, 30_000);

const removedReaderMutationFile =
  "apps/web/src/features/statutes/components/statute-compare-view.tsx";
for (const oldPath of removedReaderPaths) {
  const alias = oldPath.replace("apps/web/src/", "@/");
  const relative = path.relative(
    path.dirname(removedReaderMutationFile),
    oldPath,
  );
  const extensionlessAlias = alias.replace(/\.[cm]?[jt]sx?$/u, "");
  test(`removed reader imports reject every syntax and path spelling: ${oldPath}`, () => {
    for (const specifier of new Set([
      alias,
      extensionlessAlias,
      relative,
      `${alias}?raw`,
    ])) {
      for (const mutation of [
        `import "${specifier}";`,
        `export { value } from "${specifier}";`,
        `const value = import("${specifier}");`,
        `const value = require("${specifier}");`,
        `type Value = import("${specifier}");`,
        `import value = require("${specifier}");`,
      ]) {
        expect(
          removedReaderImportViolations(removedReaderMutationFile, mutation),
          mutation,
        ).toEqual([specifier]);
      }
    }
  });
}

test("removed reader stylesheet imports reject CSS import forms", () => {
  expect(
    Bun.resolveSync(
      "@stll/decision-reader/reader.css",
      path.dirname(path.join(repositoryRoot, removedReaderMutationFile)),
    ),
  ).toBe(path.join(packageRoot, "src/reader.css"));
  for (const mutation of [
    '@import "@/components/legal-reader/reader.css";',
    '@import url("@/components/legal-reader/reader.css");',
    "@import url(@/components/legal-reader/reader.css);",
    '@import "@/components/legal-reader/reader.css?inline";',
    '@import "../components/legal-reader/reader.css";',
  ]) {
    expect(
      removedReaderImportViolations("apps/web/src/styles/app.css", mutation),
    ).toHaveLength(1);
  }
  expect(
    removedReaderImportViolations(
      removedReaderMutationFile,
      'import "@stll/decision-reader/reader.css";',
    ),
  ).toEqual([]);
});

const mcpReaderRequiresSharedPackage = (file: string, source: string) => {
  const readerEntry =
    /(?:^|\/)(?:decision-reader|decision-text|document-ast-text)(?:\/|\.)/u.test(
      file,
    ) ||
    /<(?:\w+\.)?(?:DecisionText|DecisionReader|DocumentAstText)(?:\s|\/|>)/u.test(
      source,
    );
  return (
    readerEntry &&
    !moduleSpecifiers(source).some((specifier) =>
      specifier.startsWith("@stll/decision-reader/"),
    )
  );
};

test("MCP decision reader entries use the shared rendering package", () => {
  for (const file of new Bun.Glob(
    "apps/api/src/mcp/apps/**/*.{ts,tsx}",
  ).scanSync({ cwd: repositoryRoot })) {
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)) {
      continue;
    }
    expect(
      mcpReaderRequiresSharedPackage(
        file,
        readFileSync(path.join(repositoryRoot, file), "utf-8"),
      ),
      file,
    ).toBe(false);
  }
});

test("MCP reader ownership guard distinguishes reader entries from result snippets", () => {
  const file = "apps/api/src/mcp/apps/decision-reader/app.tsx";
  expect(
    mcpReaderRequiresSharedPackage(
      file,
      "const App = () => <article>Text</article>;",
    ),
  ).toBe(true);
  expect(
    mcpReaderRequiresSharedPackage(
      file,
      'import { DecisionText } from "@stll/decision-reader/decision-text";',
    ),
  ).toBe(false);
  expect(
    mcpReaderRequiresSharedPackage(
      "apps/api/src/mcp/apps/case-law-results/app.tsx",
      "const App = () => <article>Result snippet</article>;",
    ),
  ).toBe(false);
  expect(
    mcpReaderRequiresSharedPackage(
      "apps/api/src/mcp/apps/new-app/app.tsx",
      "const App = () => <DecisionText />;",
    ),
  ).toBe(true);
});

const mutationFile = path.join(packageRoot, "src/reader.tsx");
for (const specifier of [
  "@/lib/auth",
  "../../../apps/web/src/lib/api",
  "@tanstack/react-router",
  "@tanstack/react-query",
  "better-auth",
  "use-intl",
  "node:fs",
  "/apps/web/auth.ts",
]) {
  for (const mutation of [
    `import { value } from "${specifier}";`,
    `export { value } from "${specifier}";`,
    `const value = import("${specifier}");`,
    `const value = require("${specifier}");`,
    `type Value = import("${specifier}");`,
    `import value = require("${specifier}");`,
  ]) {
    test(`reader boundary rejects ${mutation}`, () => {
      expect(boundaryViolations(mutationFile, mutation)).toEqual([specifier]);
    });
  }
}

test("reader boundary rejects computed module loading", () => {
  expect(
    boundaryViolations(mutationFile, "import(target); require(target);"),
  ).toEqual(["<computed module specifier>", "<computed module specifier>"]);
});

test("reader boundary allows local modules and declared rendering contracts", () => {
  expect(
    boundaryViolations(
      mutationFile,
      'import "./reader.css"; export { value } from "./reader"; import React from "react"; import type { Block } from "@stll/legal-ast/document-ast";',
    ),
  ).toEqual([]);
});
