import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { canonicalModuleId } from "../../../.oxlint-plugins/module-id";
import { parseSource, walk } from "./syntax-tree";
import { createProgram } from "./typescript-program";

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

const lifecycleViolations = (source: string, filename = "source.tsx") => {
  const parsed = parseSource(filename, source);
  const violations: string[] = [];
  walk(parsed.program, (node, ancestors) => {
    if (node.type === "ImportDeclaration" && node.source.value === "react") {
      for (const binding of node.specifiers) {
        if (binding.type !== "ImportSpecifier") {
          continue;
        }
        const imported =
          binding.imported.type === "Identifier"
            ? binding.imported.name
            : binding.imported.value;
        if (reactEffects.has(imported)) {
          violations.push(imported);
        }
      }
    }
    const parent = ancestors.at(-1);
    if (
      node.type === "Identifier" &&
      (node.name === "fetch" || node.name === "XMLHttpRequest") &&
      !(
        parent?.type === "MemberExpression" &&
        !parent.computed &&
        parent.property === node
      )
    ) {
      violations.push(node.name);
    }
    if (node.type !== "MemberExpression") {
      return;
    }
    let member: string | undefined;
    if (node.computed) {
      if (
        node.property.type === "Literal" &&
        typeof node.property.value === "string"
      ) {
        member = node.property.value;
      }
    } else if (node.property.type === "Identifier") {
      member = node.property.name;
    }
    if (member === undefined) {
      return;
    }
    const globalOwner =
      node.object.type === "Identifier" &&
      ["window", "globalThis", "self"].includes(node.object.name);
    if (
      reactEffects.has(member) ||
      (globalOwner && (member === "fetch" || member === "XMLHttpRequest"))
    ) {
      violations.push(member);
    }
  });
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

const moduleSpecifiers = (source: string, filename = "source.tsx") => {
  const parsed = parseSource(filename, source);
  const specifiers: string[] = [];
  walk(parsed.program, (node) => {
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      node.source
    ) {
      specifiers.push(node.source.value);
    }
    if (node.type === "TSExternalModuleReference") {
      specifiers.push(node.expression.value);
    }
    if (node.type === "TSImportType") {
      specifiers.push(node.source.value);
    }
    if (
      node.type !== "ImportExpression" &&
      !(
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "require"
      )
    ) {
      return;
    }
    const argument =
      node.type === "ImportExpression" ? node.source : node.arguments.at(0);
    if (argument?.type === "Literal" && typeof argument.value === "string") {
      specifiers.push(argument.value);
    } else if (
      argument?.type === "TemplateLiteral" &&
      argument.expressions.length === 0
    ) {
      specifiers.push(
        argument.quasis.map(({ value }) => value.cooked ?? value.raw).join(""),
      );
    } else {
      specifiers.push("<computed module specifier>");
    }
  });
  return specifiers;
};

const boundaryViolations = (file: string, source: string) =>
  moduleSpecifiers(source, file).filter((specifier) => {
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

test("shared decision identity exports resolve to context-free package owners", () => {
  for (const module of ["court-name", "decision-identity"]) {
    const resolved = Bun.resolveSync(
      `@stll/decision-reader/${module}`,
      path.join(repositoryRoot, "apps/web"),
    );
    expect(resolved).toBe(path.join(packageRoot, "src", `${module}.tsx`));
    expect(
      boundaryViolations(resolved, readFileSync(resolved, "utf-8")),
    ).toEqual([]);
    expect(
      lifecycleViolations(readFileSync(resolved, "utf-8"), resolved),
    ).toEqual([]);
  }
});

test("reader catalogue types compile without DOM or JSX dependencies", async () => {
  const entry = Bun.resolveSync(
    "@stll/decision-reader/reader-message-types",
    path.join(repositoryRoot, "apps/api"),
  );
  const opened = await createProgram({
    rootNames: [entry],
    compilerOptions: {
      lib: ["ESNext"],
      types: [],
      noEmit: true,
      strict: true,
      skipLibCheck: true,
    },
  });
  try {
    expect(
      [
        ...(await opened.program.getProgramDiagnostics()),
        ...(await opened.program.getSyntacticDiagnostics()),
        ...(await opened.program.getSemanticDiagnostics()),
      ].map(({ text }) => text),
    ).toEqual([]);
  } finally {
    await opened.close();
  }
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
    expect(lifecycleViolations(source, file), relativeFile).toEqual([]);
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
    : moduleSpecifiers(source, file);
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
  const relative = repoRelativePath(
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

// Owns source entry definitions: a module painting decision text delegates its
// renderer to the shared package. The metafile guard owns shipped reachability.
const mcpReaderRequiresSharedPackage = (file: string, source: string) => {
  const parsed = parseSource(file, source);
  const readerPath =
    /(?:^|\/)(?:decision-reader|decision-text|document-ast-text)(?:\/|\.)/u.test(
      file,
    );
  const imports = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of parsed.program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      !statement.source.value.startsWith("@stll/decision-reader/") ||
      statement.importKind === "type"
    ) {
      continue;
    }
    for (const binding of statement.specifiers) {
      if (binding.type === "ImportSpecifier" && binding.importKind !== "type") {
        imports.add(binding.local.name);
      }
      if (binding.type === "ImportNamespaceSpecifier") {
        namespaces.add(binding.local.name);
      }
    }
  }
  const rendered = { reader: false, shared: false };
  walk(parsed.program, (node) => {
    if (node.type === "JSXOpeningElement") {
      const name = source.slice(node.name.start, node.name.end);
      const rendersNative =
        /^(?:article|p|h[1-6]|table|blockquote|figure|pre)$/u.test(name);
      const readerElement =
        /^(?:\w+\.)?(?:DecisionText|DecisionReader|DocumentAstText|BlockRenderer|InlineContent|DecisionIdentity|CourtName)$/u.test(
          name,
        );
      rendered.reader ||= (readerPath && rendersNative) || readerElement;
      rendered.shared ||=
        imports.has(name) ||
        (node.name.type === "JSXMemberExpression" &&
          node.name.object.type === "JSXIdentifier" &&
          namespaces.has(node.name.object.name));
    }
  });
  // The build's metafile guard owns reachability. This source guard owns modules
  // that paint reader UI; data modules and bootstraps delegate that rendering.
  return rendered.reader && !rendered.shared;
};

test("MCP decision reader entries use the shared rendering package", () => {
  for (const file of new Bun.Glob(
    "packages/mcp-apps/src/**/*.{ts,tsx}",
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

test("copying the production renderer into an app entry violates source ownership", () => {
  const entry = "packages/mcp-apps/src/decision-reader/app.tsx";
  const productionEntry = readFileSync(
    path.join(repositoryRoot, entry),
    "utf-8",
  );
  expect(mcpReaderRequiresSharedPackage(entry, productionEntry)).toBe(false);
  const copiedRenderer = readFileSync(
    path.join(packageRoot, "src/document-ast-text.tsx"),
    "utf-8",
  );
  expect(copiedRenderer).toContain("export const BlockRenderer");
  expect(mcpReaderRequiresSharedPackage(entry, copiedRenderer)).toBe(true);
});

test("MCP reader ownership guard distinguishes reader entries from result snippets", () => {
  const file = "packages/mcp-apps/src/decision-reader/app.tsx";
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
      file,
      'import { DecisionText } from "@stll/decision-reader/decision-text"; const App = () => <article>Clone</article>;',
    ),
  ).toBe(true);
  expect(
    mcpReaderRequiresSharedPackage(
      file,
      'import { BlockRenderer as SharedBlock } from "@stll/decision-reader/document-ast-text"; const App = () => <SharedBlock />;',
    ),
  ).toBe(false);
  expect(
    mcpReaderRequiresSharedPackage(
      "packages/mcp-apps/src/decision-reader/model.ts",
      'import { blockSchema } from "@stll/legal-ast/document-ast"; export const readBlock = (value) => v.parse(blockSchema, value);',
    ),
  ).toBe(false);
  expect(
    mcpReaderRequiresSharedPackage(
      file,
      'import { ReaderView } from "./view"; createRoot(root).render(<ReaderView host={host} />);',
    ),
  ).toBe(false);
  expect(
    mcpReaderRequiresSharedPackage(
      "packages/mcp-apps/src/decision-reader/messages.tsx",
      'import type { ReaderMessages } from "@stll/decision-reader/reader-adapters"; const messages = { dissentByline: (text) => <bdi>{text}</bdi> };',
    ),
  ).toBe(false);
  expect(
    mcpReaderRequiresSharedPackage(
      "packages/mcp-apps/src/case-law-results/app.tsx",
      "const App = () => <article>Result snippet</article>;",
    ),
  ).toBe(false);
  expect(
    mcpReaderRequiresSharedPackage(
      "packages/mcp-apps/src/new-app/app.tsx",
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
