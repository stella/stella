import { describe, expect, test } from "bun:test";
import ts from "typescript";

import { toSafeId } from "@/api/lib/branded-types";

import {
  ACTION_KIND_COUNTED_BY,
  ACTION_KINDS,
  type ActionKind,
} from "./action-kinds";
import {
  admitFixtureModelDispatch,
  assertModelDispatchScope,
  NO_ORGANIZATION_MODEL_DISPATCH,
} from "./model-dispatch-admission";

const apiRoot = new URL("../../../", import.meta.url);

/** The entry points that send a request to a model. */
const DISPATCH_ENTRY_POINTS = new Set([
  "collectTanStackTextRun",
  "generateTanStackChatObject",
  "generateTanStackObjectForRole",
  "generateTanStackTextForRole",
  "resolveTanStackTextModel",
  "streamTanStackChatRun",
  "streamTanStackObjectForRole",
  "streamTanStackTextForRole",
]);
const DISPATCH_MODULE = "@/api/lib/tanstack-ai-generate";
const CHAT_TOOLS_PREFIX = "handlers/chat/tools/";

type ModelDispatchSite = { file: string; line: number; via: string };

type ModelDispatchScan = {
  sites: ModelDispatchSite[];
  violations: string[];
};

const propertyName = (name: ts.PropertyName) =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;

const declaresProperty = (
  literal: ts.ObjectLiteralExpression,
  name: string,
): boolean =>
  literal.properties.some(
    (property) =>
      (ts.isPropertyAssignment(property) &&
        propertyName(property.name) === name) ||
      (ts.isShorthandPropertyAssignment(property) &&
        property.name.text === name),
  );

/** The dispatch entry point an expression names, through local aliases. */
const dispatchNamed = (
  expression: ts.Expression,
  names: ReadonlyMap<string, string>,
): string | undefined => {
  if (ts.isParenthesizedExpression(expression)) {
    return dispatchNamed(expression.expression, names);
  }
  if (ts.isIdentifier(expression)) {
    return names.get(expression.text);
  }
  // `dependencies.resolveModel`, where a dependency object maps the
  // property to an entry point.
  if (ts.isPropertyAccessExpression(expression)) {
    return names.get(`.${expression.name.text}`);
  }
  // `deps.generate ?? generateTanStackObjectForRole`: the fallback names it.
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return dispatchNamed(expression.right, names);
  }
  return undefined;
};

/**
 * Every call that dispatches a model in one source file, and each that does
 * so without an admission. A dispatch names the proof of its admitted action
 * as `admission`; the type requires it, and this scan keeps a cast, an alias
 * or an injected default from carrying a dispatch past the type. Spreads and
 * non-literal options are left to the type. Two helpers that trust an
 * admission made elsewhere are checked here too: `configuredModelAdmission`
 * only in a handler whose config declares its `actionAdmission`, and
 * `requireChatToolModelAdmission` only in chat tools.
 */
const scanModelDispatches = (
  file: string,
  source: string,
): ModelDispatchScan => {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const names = new Map<string, string>();
  for (const statement of tree.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== DISPATCH_MODULE
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const binding of bindings.elements) {
      const imported = (binding.propertyName ?? binding.name).text;
      if (DISPATCH_ENTRY_POINTS.has(imported)) {
        names.set(binding.name.text, imported);
      }
    }
  }

  // Injected defaults and fallbacks: `generate = generateTanStack…` and
  // `const generate = deps.generate ?? generateTanStack…`.
  const collectAliases = (node: ts.Node): void => {
    if (
      (ts.isBindingElement(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const named = dispatchNamed(node.initializer, names);
      if (named !== undefined) {
        names.set(node.name.text, named);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const named = dispatchNamed(node.initializer, names);
      if (named !== undefined) {
        names.set(node.name.text, named);
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const property = propertyName(node.name);
      const named = dispatchNamed(node.initializer, names);
      if (property !== undefined && named !== undefined) {
        names.set(`.${property}`, named);
      }
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      const named = names.get(node.name.text);
      if (named !== undefined) {
        names.set(`.${node.name.text}`, named);
      }
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(tree);

  const sites: ModelDispatchSite[] = [];
  const violations: string[] = [];
  let configuredAdmissionCalls = 0;
  let declaresConfiguredAdmission = false;
  const lineOf = (node: ts.Node) =>
    tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const via = dispatchNamed(node.expression, names);
      if (via !== undefined) {
        const line = lineOf(node);
        sites.push({ file, line, via });
        const options = node.arguments.at(0);
        if (
          options !== undefined &&
          ts.isObjectLiteralExpression(options) &&
          !declaresProperty(options, "admission") &&
          !options.properties.some(ts.isSpreadAssignment)
        ) {
          violations.push(
            `${file}:${String(line)}: ${via} dispatches without an admission`,
          );
        }
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "configuredModelAdmission"
      ) {
        configuredAdmissionCalls += 1;
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "requireChatToolModelAdmission" &&
        !file.startsWith(CHAT_TOOLS_PREFIX)
      ) {
        violations.push(
          `${file}:${String(lineOf(node))}: requireChatToolModelAdmission outside chat tools`,
        );
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === "actionAdmission" &&
      ts.isObjectLiteralExpression(node.initializer) &&
      declaresProperty(node.initializer, "actionKind")
    ) {
      declaresConfiguredAdmission = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);

  if (configuredAdmissionCalls > 0 && !declaresConfiguredAdmission) {
    violations.push(
      `${file}: configuredModelAdmission without a configured actionAdmission`,
    );
  }
  return { sites, violations };
};

const scan = (source: string, file = "handlers/example.ts") =>
  scanModelDispatches(file, source);

const productionSources = async () => {
  const sources: { file: string; source: string }[] = [];
  for (const root of ["src", "evals", "scripts"]) {
    for (const relative of new Bun.Glob("**/*.ts").scanSync({
      cwd: new URL(`${root}/`, apiRoot).pathname,
    })) {
      if (relative.includes(".test.") || relative.startsWith("tests/")) {
        continue;
      }
      sources.push({
        // Paths below `src/` read as the handlers and libraries name them.
        file: root === "src" ? relative : `${root}/${relative}`,
        source: await Bun.file(new URL(`${root}/${relative}`, apiRoot)).text(),
      });
    }
  }
  return sources;
};

const RAW_CHAT_RUNTIME = "@/api/lib/chat/tanstack-chat-runtime";
const RAW_CHAT_ENTRY_POINTS = new Set([
  "generateChatObject",
  "streamChatChunks",
  "streamChatObject",
]);
/**
 * The chat runtime's raw entry points read no proof, so a run through them
 * aborts with its admitted action only where the caller joins the proof's
 * signal itself. Everything else dispatches through the admitted helpers.
 */
const RAW_CHAT_RUNTIME_OWNERS = {
  "handlers/chat/stream-chat.ts":
    "the turn's provider abort controller joins its execution admission",
  "lib/tanstack-ai-generate.ts":
    "the admitted helpers join the proof's signal to every run",
};

const importsRawChatRuntime = (file: string, source: string): boolean =>
  ts
    .createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    .statements.some((statement) => {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== RAW_CHAT_RUNTIME
      ) {
        return false;
      }
      const bindings = statement.importClause?.namedBindings;
      return (
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some((binding) =>
          RAW_CHAT_ENTRY_POINTS.has(
            (binding.propertyName ?? binding.name).text,
          ),
        )
      );
    });

describe("model dispatch admission guard", () => {
  test("flags a dispatch without an admission however it names the entry point", () => {
    const offending = [
      `import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";
       await generateTanStackTextForRole({ organizationId, role: "fast" });`,
      `import { generateTanStackTextForRole as generate } from "@/api/lib/tanstack-ai-generate";
       await generate({ organizationId, role: "fast" });`,
      `import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
       const run = async ({ generate = generateTanStackObjectForRole }) =>
         await generate({ organizationId });`,
      `import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
       await (deps.generate ?? generateTanStackObjectForRole)({ organizationId });`,
      `import { resolveTanStackTextModel } from "@/api/lib/tanstack-ai-generate";
       const resolve = deps.resolve ?? resolveTanStackTextModel;
       await resolve({ organizationId, role: "chat" });`,
      `import { resolveTanStackTextModel } from "@/api/lib/tanstack-ai-generate";
       const defaults = { resolveModel: resolveTanStackTextModel };
       await dependencies.resolveModel({ organizationId, role: "chat" });`,
    ];
    for (const source of offending) {
      const result = scan(source);
      expect(result.sites).toHaveLength(1);
      expect(result.violations).toHaveLength(1);
    }
  });

  test("accepts a dispatch that names its admission or passes typed options", () => {
    const compliant = [
      `import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";
       await generateTanStackTextForRole({ organizationId, admission, role: "fast" });`,
      `import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";
       await generateTanStackTextForRole({ organizationId, admission: context.admission });`,
      `import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
       await generateTanStackObjectForRole(options);`,
      `import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";
       await generateTanStackTextForRole({ ...options, resolveTextModel });`,
    ];
    for (const source of compliant) {
      const result = scan(source);
      expect(result.sites).toHaveLength(1);
      expect(result.violations).toEqual([]);
    }
  });

  test("ties the configured-admission helper to a configured admission", () => {
    expect(
      scan(`const config = { permissions: {} };
            generate({ admission: configuredModelAdmission({ modelAdmission }) });`)
        .violations,
    ).toHaveLength(1);
    expect(
      scan(`const config = {
              actionAdmission: { type: "handler", actionKind: "clauses.rewrite" },
            };
            generate({ admission: configuredModelAdmission({ modelAdmission }) });`)
        .violations,
    ).toEqual([]);
  });

  test("keeps the chat tool helper to chat tools", () => {
    const source = "requireChatToolModelAdmission(modelAdmission);";
    expect(scan(source, "lib/templates/example.ts").violations).toHaveLength(1);
    expect(scan(source, "handlers/chat/tools/example.ts").violations).toEqual(
      [],
    );
  });

  test("only the owners that join the proof's signal run the chat runtime directly", async () => {
    const importers = (await productionSources())
      .filter(
        ({ file, source }) =>
          !file.startsWith("evals/") &&
          !file.startsWith("scripts/") &&
          importsRawChatRuntime(file, source),
      )
      .map(({ file }) => file)
      .toSorted();
    expect(importers).toEqual(Object.keys(RAW_CHAT_RUNTIME_OWNERS).toSorted());
  });

  test("every model dispatch in the API, its evaluations and scripts carries an admission", async () => {
    const sites: ModelDispatchSite[] = [];
    const violations: string[] = [];
    for (const { file, source } of await productionSources()) {
      const result = scan(source, file);
      sites.push(...result.sites);
      violations.push(...result.violations);
    }
    expect(violations).toEqual([]);
    // The scan reads real dispatches, not an empty tree: every owner of a
    // model request appears among the sites it found.
    const files = new Set(sites.map((site) => site.file));
    for (const owner of [
      "handlers/chat/stream-chat.ts",
      "handlers/chat/subagent-runner.ts",
      "lib/workflow/ai-generate-batch.ts",
      "lib/flows/flow-executor.ts",
      "lib/scheduler/tasks/memory-extractor.ts",
      "handlers/case-law/polarity/llm-classifier.ts",
      "scripts/ai-provider-canary.ts",
    ]) {
      expect(files.has(owner)).toBe(true);
    }
  });
});

describe("action kind registry", () => {
  test("every registered kind is admitted by some path", async () => {
    const kinds = Object.keys(ACTION_KINDS).filter((kind): kind is ActionKind =>
      Object.hasOwn(ACTION_KINDS, kind),
    );
    const referenced = new Set<string>();
    for (const { file, source } of await productionSources()) {
      if (file === "lib/rate-limit/action-kinds.ts") {
        continue;
      }
      const tree = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isStringLiteral(node) &&
          Object.hasOwn(ACTION_KINDS, node.text)
        ) {
          referenced.add(node.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    // Kickoff and background kinds of queued work are named through the
    // registry's own maps.
    for (const kind of ["workflow.start", "flow.start"]) {
      referenced.add(kind);
    }
    for (const kind of Object.keys(ACTION_KIND_COUNTED_BY)) {
      referenced.add(kind);
    }
    expect(kinds.filter((kind) => !referenced.has(kind))).toEqual([]);
  });

  test("background kinds are counted by a period kind that serves the same credentials", () => {
    const backgroundKinds = Object.keys(ACTION_KIND_COUNTED_BY).filter(
      (kind): kind is keyof typeof ACTION_KIND_COUNTED_BY =>
        Object.hasOwn(ACTION_KIND_COUNTED_BY, kind),
    );
    for (const background of backgroundKinds) {
      const parent = ACTION_KIND_COUNTED_BY[background];
      expect(ACTION_KINDS[background].admission).toBe("concurrency-only");
      expect(ACTION_KINDS[parent].admission).toBe("period");
      expect(ACTION_KINDS[background].serviceCredentials).toBe(
        ACTION_KINDS[parent].serviceCredentials,
      );
    }
  });
});

describe("model dispatch scope", () => {
  test("a proof admits a dispatch for its own organization", () => {
    const organizationId = toSafeId<"organization">("org_fixture");
    const admission = admitFixtureModelDispatch({
      organizationId,
      actionKind: "chat.send",
    });
    expect(admission).toMatchObject({
      type: "organization",
      organizationId,
      actionKind: "chat.send",
    });
    expect(() =>
      assertModelDispatchScope({ organizationId, admission }),
    ).not.toThrow();
  });

  test("work with no organization dispatches only without one", () => {
    expect(() =>
      assertModelDispatchScope({
        organizationId: null,
        admission: NO_ORGANIZATION_MODEL_DISPATCH,
      }),
    ).not.toThrow();
  });
});
