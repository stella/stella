import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  type CallExpression,
  isObjectLiteralProperty,
  type Node,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree";

const apiRoot = path.resolve(import.meta.dir, "../../..");
const decisionOwner = "src/lib/workflow/decisions/decide.ts";

// A method's function value is its own scope; accessors and constructors stay
// in the scope that declares them.
const isFunction = (node: Node, parent: Node | undefined) => {
  if (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "TSDeclareFunction"
  ) {
    return true;
  }
  if (
    node.type !== "FunctionExpression" &&
    node.type !== "TSEmptyBodyFunctionExpression"
  ) {
    return false;
  }
  if (
    parent?.type === "MethodDefinition" ||
    parent?.type === "TSAbstractMethodDefinition"
  ) {
    return parent.kind === "method";
  }
  return parent?.type !== "Property" || parent.kind === "init";
};

const callName = (node: CallExpression) => {
  if (node.callee.type === "Identifier") {
    return node.callee.name;
  }
  if (node.callee.type !== "MemberExpression" || node.callee.computed) {
    return "";
  }
  return node.callee.property.type === "PrivateIdentifier"
    ? `#${node.callee.property.name}`
    : node.callee.property.name;
};

const generationCall = (name: string) =>
  /^(?:generate(?:TanStack|Field)|collectTanStack|classifyWithLLM)/u.test(name);

const isStringLiteral = (node: Node, text?: string) =>
  node.type === "Literal" &&
  typeof node.value === "string" &&
  (text === undefined || node.value === text);

// Inspect each function separately: a generator callback handed to decide is
// owned by decide, whereas calling it after a decided-return is a private tier.
const functionNodes = (root: Node) => {
  const nodes: Node[] = [];
  walk(root, (node, ancestors) => {
    if (node !== root && isFunction(node, ancestors.at(-1))) {
      return "skip-children";
    }
    nodes.push(node);
    return undefined;
  });
  return nodes;
};

const functionCalls = (nodes: readonly Node[]) =>
  nodes.filter(
    (node): node is CallExpression => node.type === "CallExpression",
  );

const fallbackViolations = (file: string, source: string) => {
  if (file === decisionOwner) {
    return [];
  }
  const ast = parseSource(file, source);
  const text = (node: Node) => source.slice(node.start, node.end);
  const decisionCalls = new Set([
    "decide",
    "decideMany",
    "classifyWithSystemOne",
  ]);
  const generationCalls = new Set<string>();
  const localFunctions = new Map<string, Node>();
  walk(ast.program, (node) => {
    if (node.type === "ImportSpecifier") {
      const imported =
        node.imported.type === "Identifier"
          ? node.imported.name
          : node.imported.value;
      if (decisionCalls.has(imported)) {
        decisionCalls.add(node.local.name);
      }
      if (generationCall(imported)) {
        generationCalls.add(node.local.name);
      }
    }
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "TSDeclareFunction") &&
      node.id
    ) {
      localFunctions.set(node.id.name, node);
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init &&
      isFunction(node.init, node)
    ) {
      localFunctions.set(node.id.name, node.init);
    }
  });
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
        functionCalls(functionNodes(fn)).some((child) =>
          isGeneration(callName(child)),
        )
      ) {
        generationCalls.add(name);
        changed = true;
      }
    }
  }
  const violations = new Set<string>();
  const report = (node: Node, reason: string) => {
    const { line } = ast.locate(node.start);
    violations.add(`${file}:${line}: ${reason}`);
  };
  walk(ast.program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (isFunction(node, parent)) {
      const nodes = functionNodes(node);
      const calls = functionCalls(nodes);
      const asksDecision = calls.some((call) =>
        decisionCalls.has(callName(call)),
      );
      const readsDecisionState = nodes.some(
        (child) =>
          isStringLiteral(child, "decided") ||
          isStringLiteral(child, "undecided"),
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
      (node.type === "IfStatement" &&
        functionNodes(node.test).some((child) =>
          isStringLiteral(child, "undecided"),
        )) ||
      (node.type === "SwitchCase" &&
        node.test !== null &&
        isStringLiteral(node.test, "undecided"));
    if (undecidedBranch) {
      for (const child of functionCalls(functionNodes(node))) {
        const name = callName(child);
        const queueWrite =
          name === "push" &&
          child.callee.type === "MemberExpression" &&
          /fallback|generative|remaining/iu.test(text(child.callee.object));
        if (isGeneration(name) || queueWrite) {
          report(child, "undecided outcome enters a private generative tier");
        }
      }
    }
    if (
      isObjectLiteralProperty(node, parent) &&
      node.kind === "init" &&
      !node.method &&
      !node.shorthand &&
      !node.computed &&
      /^(?:generative|remaining)$/u.test(text(node.key)) &&
      node.value.type === "CallExpression" &&
      callName(node.value) === "filter" &&
      /\boutput\s*\[[\s\S]*?===\s*undefined/u.test(text(node.value))
    ) {
      report(node, "missing typed output enters a private generative tier");
    }
  });
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
