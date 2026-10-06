import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";

import { VISUAL_RUNTIME_BUILD_OPTIONS } from "../../../apps/api/scripts/visual-sandbox-build-options";
import { escapeVisualScript } from "../../../apps/api/src/handlers/visual-sandbox/srcdoc";

const runtimePath = new URL(
  "../../../apps/api/src/handlers/visual-sandbox/generated/runtime.js.txt",
  import.meta.url,
);

const isFunctionScope = (node: ts.Node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node);

const hasTemplateBinding = (access: ts.PropertyAccessExpression) => {
  const receiver = access.expression;
  if (!ts.isIdentifier(receiver)) {
    return false;
  }
  let scope: ts.Node = access;
  while (scope.parent && !isFunctionScope(scope) && !ts.isSourceFile(scope)) {
    scope = scope.parent;
  }
  let found = false;
  const visit = (node: ts.Node) => {
    if (node !== scope && isFunctionScope(node)) {
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === receiver.text &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const call = node.initializer;
      const tag = call.arguments.at(0);
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "createElement" &&
        tag &&
        ts.isStringLiteral(tag) &&
        tag.text === "template"
      ) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
};

const inspectRuntime = (source: string) => {
  const ast = ts.createSourceFile(
    "runtime.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const problems: string[] = [];
  let templateWrites = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      (node.text === "eval" || node.text === "Function")
    ) {
      problems.push("dynamic code");
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression) &&
      ["eval", "Function", "innerHTML"].includes(node.argumentExpression.text)
    ) {
      problems.push("computed code or markup sink");
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "innerHTML") {
      if (!hasTemplateBinding(node)) {
        problems.push("markup outside template parsing");
      }
      templateWrites++;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { problems, templateWrites };
};

describe("visual sandbox runtime asset", () => {
  test("contains charts without dynamic code and confines markup parsing to templates", async () => {
    const built = await Bun.build({
      ...VISUAL_RUNTIME_BUILD_OPTIONS,
      sourcemap: "external",
      entrypoints: [
        new URL(
          "../../../apps/api/src/handlers/visual-sandbox/browser/treemap.harness.ts",
          import.meta.url,
        ).pathname,
      ],
    });
    expect(built.success).toBe(true);
    const artifact = built.outputs.find(
      (output) => output.kind === "entry-point",
    );
    expect(artifact).toBeDefined();
    if (!artifact) {
      throw new TypeError("Chart build requires one artifact");
    }
    const sourceMap = built.outputs.find(
      (output) => output.kind === "sourcemap",
    );
    expect(sourceMap).toBeDefined();
    if (!sourceMap) {
      throw new TypeError("Chart build requires source ownership metadata");
    }
    const metadata: { sources: string[]; sourcesContent: string[] } =
      JSON.parse(await sourceMap.text());
    for (const [index, original] of metadata.sourcesContent.entries()) {
      if (!original.includes("innerHTML")) {
        continue;
      }
      expect(metadata.sources[index]).toMatch(
        /@tanstack[/+]charts.*\/dist\/(?:reconcile|motion|svg-focus-guide-serializer)\.js$/u,
      );
    }
    const source = escapeVisualScript(await artifact.text());
    console.log(
      `Treemap harness bundle: ${new TextEncoder().encode(source).byteLength} raw bytes; ${Bun.gzipSync(source).byteLength} gzip bytes`,
    );
    expect(source).toContain("setColorMode");
    expect(source).toContain("treemap");
    expect(source).not.toMatch(/<\/script|<!--/iu);
    expect(inspectRuntime(readFileSync(runtimePath, "utf-8")).problems).toEqual(
      [],
    );
    const { problems, templateWrites } = inspectRuntime(source);
    expect(problems).toEqual([]);
    // The library's SVG reconciliation must actually be inspected.
    expect(templateWrites).toBeGreaterThan(0);
  });

  test("derives every tier legend label from every current UI locale", () => {
    const catalogs = new URL(
      "../../../apps/web/src/i18n/langs/",
      import.meta.url,
    );
    const generated: Record<string, Record<string, string>> = JSON.parse(
      readFileSync(
        new URL(
          "../../../apps/api/src/handlers/visual-sandbox/generated/court-tier-labels.json",
          import.meta.url,
        ),
        "utf-8",
      ),
    );
    const names = readdirSync(catalogs)
      .filter((name) => name.endsWith(".json"))
      .toSorted();
    expect(Object.keys(generated).toSorted()).toEqual(
      names.map((name) => name.slice(0, -5)),
    );
    for (const name of names) {
      const original: { caseLaw: { courtTiers: Record<string, string> } } =
        JSON.parse(readFileSync(new URL(name, catalogs), "utf-8"));
      const labels = generated[name.slice(0, -5)];
      expect(labels).toBeDefined();
      expect(Object.keys(labels ?? {}).toSorted()).toEqual(
        [...COURT_TIER_LABELS].toSorted(),
      );
      for (const tier of COURT_TIER_LABELS) {
        expect(labels?.[tier]).toBe(original.caseLaw.courtTiers[tier]);
      }
    }
  });

  test("detects code generation and markup writes outside template parsing", () => {
    for (const source of [
      "eval('1')",
      "new Function('return 1')",
      "window['eval']('1')",
      "const node=document.createElement('div');node.innerHTML='x'",
      "function a(){const t=document.createElement('template')} function b(t){t.innerHTML='x'}",
      "const t=document.createElement('template');t['innerHTML']='x'",
    ]) {
      expect(inspectRuntime(source).problems.length).toBeGreaterThan(0);
    }
    expect(
      inspectRuntime(
        "function parse(document,markup){const t=document.createElement('template');t.innerHTML=markup;return t.content}",
      ).problems,
    ).toEqual([]);
  });
});
