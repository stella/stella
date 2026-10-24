import { describe, expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript6";

const apiRoot = path.resolve(import.meta.dir, "../../..");
const decisionOwner = "src/lib/workflow/decisions/decide.ts";

const isFunction = (node: ts.Node) =>
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node);

const callName = (node: ts.CallExpression) => {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  return ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name.text
    : "";
};

const generationCall = (name: string) =>
  /^(?:generate(?:TanStack|Field)|collectTanStack|classifyWithLLM)/u.test(name);

// Inspect each function separately: a generator callback handed to decide is
// owned by decide, whereas calling it after a decided-return is a private tier.
const functionNodes = (root: ts.Node) => {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (node !== root && isFunction(node)) {
      return;
    }
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return nodes;
};

const fallbackViolations = (file: string, source: string) => {
  if (file === decisionOwner) {
    return [];
  }
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const decisionCalls = new Set([
    "decide",
    "decideMany",
    "classifyWithSystemOne",
  ]);
  const generationCalls = new Set<string>();
  const localFunctions = new Map<string, ts.Node>();
  const index = (node: ts.Node) => {
    if (ts.isImportSpecifier(node)) {
      const imported = node.propertyName?.text ?? node.name.text;
      if (decisionCalls.has(imported)) {
        decisionCalls.add(node.name.text);
      }
      if (generationCall(imported)) {
        generationCalls.add(node.name.text);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      localFunctions.set(node.name.text, node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isFunction(node.initializer)
    ) {
      localFunctions.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, index);
  };
  index(ast);
  const isGeneration = (name: string) =>
    generationCall(name) || generationCalls.has(name);
  // Follow local wrappers as well as imported generator aliases, so moving a
  // private call into a differently named helper cannot hide the second tier.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, fn] of localFunctions) {
      if (generationCalls.has(name)) {
        continue;
      }
      if (
        functionNodes(fn).some(
          (child) =>
            ts.isCallExpression(child) && isGeneration(callName(child)),
        )
      ) {
        generationCalls.add(name);
        changed = true;
      }
    }
  }
  const violations = new Set<string>();
  const report = (node: ts.Node, reason: string) => {
    const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
    violations.add(`${file}:${line + 1}: ${reason}`);
  };
  const visit = (node: ts.Node) => {
    if (isFunction(node)) {
      const nodes = functionNodes(node);
      const calls = nodes.filter(ts.isCallExpression);
      const asksDecision = calls.some((call) =>
        decisionCalls.has(callName(call)),
      );
      const readsDecisionState = nodes.some(
        (child) =>
          ts.isStringLiteral(child) &&
          (child.text === "decided" || child.text === "undecided"),
      );
      if (asksDecision && readsDecisionState) {
        for (const call of calls) {
          if (isGeneration(callName(call))) {
            report(call, "decision consumer starts a private generation");
          }
        }
      }
    }
    const undecidedBranch =
      (ts.isIfStatement(node) &&
        functionNodes(node.expression).some(
          (child) => ts.isStringLiteral(child) && child.text === "undecided",
        )) ||
      (ts.isCaseClause(node) &&
        ts.isStringLiteral(node.expression) &&
        node.expression.text === "undecided");
    if (undecidedBranch) {
      for (const child of functionNodes(node)) {
        if (!ts.isCallExpression(child)) {
          continue;
        }
        const name = callName(child);
        const queueWrite =
          name === "push" &&
          ts.isPropertyAccessExpression(child.expression) &&
          /fallback|generative|remaining/iu.test(
            child.expression.expression.getText(ast),
          );
        if (isGeneration(name) || queueWrite) {
          report(child, "undecided outcome enters a private generative tier");
        }
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      /^(?:generative|remaining)$/u.test(node.name.getText(ast)) &&
      ts.isCallExpression(node.initializer) &&
      callName(node.initializer) === "filter" &&
      /\boutput\s*\[[\s\S]*?===\s*undefined/u.test(
        node.initializer.getText(ast),
      )
    ) {
      report(node, "missing typed output enters a private generative tier");
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...violations];
};

describe("typed decision fallback ownership", () => {
  test.each([
    `async function consume() {
      const decision = await decide({});
      if (decision.state === "undecided") return generateTanStackObjectForTask({});
    }`,
    `async function consume() {
      const decision = await decide({});
      if (decision.state === "decided") return decision.answer;
      return generateFieldObject({});
    }`,
    `import { decide as ask } from "@/api/lib/workflow/decisions/decide";
    import { generateTanStackObjectForTask as write } from "@/api/lib/tanstack-ai-generate";
    async function privateTier() { return write({}); }
    async function consume() {
      const decision = await ask({});
      if (decision.state === "decided") return decision.answer;
      return privateTier();
    }`,
    `function decode(outcome) {
      switch (outcome.state) {
        case "undecided": fallbackPropertyIds.push(property.id); break;
      }
    }`,
    `function decode(outcome) {
      if (outcome.state === "undecided") remaining.push(question);
    }`,
    `function decode() {
      return { generative: properties.filter(property => output[property.id] === undefined) };
    }`,
  ])("rejects a restored private fallback: %s", (source) => {
    expect(
      fallbackViolations("src/lib/example.ts", source).length,
    ).toBeGreaterThan(0);
  });

  test("allows terminal undecided results and independent text generation", () => {
    expect(
      fallbackViolations(
        "src/lib/example.ts",
        `async function consume() {
          const decision = await decide({});
          if (decision.state === "undecided") return { state: "failed", reason: decision.reason };
          return decision.answer;
        }
        async function writeText() { return generateTanStackObjectForTask({}); }`,
      ),
    ).toEqual([]);
  });

  test("production consumers leave generative fallback to decide", async () => {
    const violations: string[] = [];
    const files = new Bun.Glob("{src,scripts}/**/*.ts").scanSync({
      cwd: apiRoot,
    });
    for (const file of files) {
      if (file.endsWith(".test.ts") || file.endsWith(".spec.ts")) {
        continue;
      }
      const source = await Bun.file(path.join(apiRoot, file)).text();
      if (!/decided|undecided|generative|remaining/u.test(source)) {
        continue;
      }
      violations.push(...fallbackViolations(file, source));
    }
    expect(violations).toEqual([]);
  });
});
