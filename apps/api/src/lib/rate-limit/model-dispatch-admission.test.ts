import { describe, expect, mock, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";
import {
  isObjectLiteralProperty,
  type Node,
  type ObjectExpression,
  type ObjectProperty,
  type ParsedSource,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree";

import type { ScopedDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  ACTION_KIND_COUNTED_BY,
  ACTION_KINDS,
  type ActionKind,
} from "./action-kinds";
import {
  admitModelDispatch,
  assertModelDispatchScope,
  NO_ORGANIZATION_MODEL_DISPATCH,
} from "./model-dispatch-admission";

const testState = createTestState({ file: import.meta.path, config: env });

const apiRoot = new URL("../../../", import.meta.url);

/** The entry points that send a request to a model. */
const DISPATCH_ENTRY_POINTS = new Set([
  "collectTanStackTextRun",
  "generateTanStackChatObject",
  "generateTanStackObjectForTask",
  "generateTanStackTextForTask",
  "resolveTanStackTextModel",
  "streamTanStackChatRun",
  "streamTanStackObjectForTask",
  "streamTanStackTextForTask",
]);
const DISPATCH_MODULE = "@/api/lib/tanstack-ai-generate";
const CHAT_TOOLS_PREFIX = "handlers/chat/tools/";

type ModelDispatchSite = { file: string; line: number; via: string };

type ModelDispatchScan = {
  sites: ModelDispatchSite[];
  violations: string[];
};

const propertyName = (property: ObjectProperty) => {
  if (property.computed) {
    return undefined;
  }
  if (property.key.type === "Identifier") {
    return property.key.name;
  }
  return property.key.type === "Literal" &&
    typeof property.key.value === "string"
    ? property.key.value
    : undefined;
};

const declaresProperty = (literal: ObjectExpression, name: string): boolean =>
  literal.properties.some(
    (property) =>
      property.type === "Property" &&
      !property.method &&
      property.kind === "init" &&
      propertyName(property) === name,
  );

/** The dispatch entry point an expression names, through local aliases. */
const dispatchNamed = (
  expression: Node,
  names: ReadonlyMap<string, string>,
): string | undefined => {
  if (
    expression.type === "ParenthesizedExpression" ||
    expression.type === "ChainExpression"
  ) {
    return dispatchNamed(expression.expression, names);
  }
  if (expression.type === "Identifier") {
    return names.get(expression.name);
  }
  // `dependencies.resolveModel`, where a dependency object maps the
  // property to an entry point.
  if (
    expression.type === "MemberExpression" &&
    !expression.computed &&
    expression.property.type === "Identifier"
  ) {
    return names.get(`.${expression.property.name}`);
  }
  // `deps.generate ?? generateTanStackObjectForTask`: the fallback names it.
  if (expression.type === "LogicalExpression" && expression.operator === "??") {
    return dispatchNamed(expression.right, names);
  }
  return undefined;
};

/** Local names a module imports `importNames` from `specifier` under. */
const importedNames = (
  parsed: ParsedSource,
  specifier: string,
  importNames: ReadonlySet<string>,
) =>
  parsed.module.staticImports
    .filter(({ moduleRequest }) => moduleRequest.value === specifier)
    .flatMap(({ entries }) =>
      entries.flatMap(({ importName, localName }) =>
        importName.name !== null && importNames.has(importName.name)
          ? [{ imported: importName.name, local: localName.value }]
          : [],
      ),
    );

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
  const tree = parseSource(file, source);
  const names = new Map<string, string>();
  for (const { imported, local } of importedNames(
    tree,
    DISPATCH_MODULE,
    DISPATCH_ENTRY_POINTS,
  )) {
    names.set(local, imported);
  }

  // Injected defaults and fallbacks: `generate = generateTanStack…` and
  // `const generate = deps.generate ?? generateTanStack…`.
  walk(tree.program, (node, ancestors) => {
    if (node.type === "AssignmentPattern" && node.left.type === "Identifier") {
      const named = dispatchNamed(node.right, names);
      if (named !== undefined) {
        names.set(node.left.name, named);
      }
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init
    ) {
      const named = dispatchNamed(node.init, names);
      if (named !== undefined) {
        names.set(node.id.name, named);
      }
    }
    if (
      isObjectLiteralProperty(node, ancestors.at(-1)) &&
      !node.method &&
      node.kind === "init"
    ) {
      if (node.shorthand) {
        const named =
          node.key.type === "Identifier" ? names.get(node.key.name) : undefined;
        if (named !== undefined && node.key.type === "Identifier") {
          names.set(`.${node.key.name}`, named);
        }
      } else {
        const property = propertyName(node);
        const named = dispatchNamed(node.value, names);
        if (property !== undefined && named !== undefined) {
          names.set(`.${property}`, named);
        }
      }
    }
  });

  const sites: ModelDispatchSite[] = [];
  const violations: string[] = [];
  let configuredAdmissionCalls = 0;
  const configured = { declaresAdmission: false };
  const lineOf = (node: Node) => tree.locate(node.start).line;

  walk(tree.program, (node, ancestors) => {
    if (node.type === "CallExpression") {
      const via = dispatchNamed(node.callee, names);
      if (via !== undefined) {
        const line = lineOf(node);
        sites.push({ file, line, via });
        const options = node.arguments.at(0);
        if (
          options?.type === "ObjectExpression" &&
          !declaresProperty(options, "admission") &&
          !options.properties.some(
            (property) => property.type === "SpreadElement",
          )
        ) {
          violations.push(
            `${file}:${String(line)}: ${via} dispatches without an admission`,
          );
        }
      }
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "configuredModelAdmission"
      ) {
        configuredAdmissionCalls += 1;
      }
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "requireChatToolModelAdmission" &&
        !file.startsWith(CHAT_TOOLS_PREFIX)
      ) {
        violations.push(
          `${file}:${String(lineOf(node))}: requireChatToolModelAdmission outside chat tools`,
        );
      }
    }
    if (
      isObjectLiteralProperty(node, ancestors.at(-1)) &&
      !node.shorthand &&
      !node.method &&
      node.kind === "init" &&
      propertyName(node) === "actionAdmission" &&
      node.value.type === "ObjectExpression" &&
      declaresProperty(node.value, "actionKind")
    ) {
      configured.declaresAdmission = true;
    }
  });

  if (configuredAdmissionCalls > 0 && !configured.declaresAdmission) {
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
  importedNames(
    parseSource(file, source),
    RAW_CHAT_RUNTIME,
    RAW_CHAT_ENTRY_POINTS,
  ).length > 0;

describe("model dispatch admission guard", () => {
  test("flags a dispatch without an admission however it names the entry point", () => {
    const offending = [
      `import { generateTanStackTextForTask } from "@/api/lib/tanstack-ai-generate";
       await generateTanStackTextForTask({ organizationId, task: "short-text" });`,
      `import { generateTanStackTextForTask as generate } from "@/api/lib/tanstack-ai-generate";
       await generate({ organizationId, task: "short-text" });`,
      `import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
       const run = async ({ generate = generateTanStackObjectForTask }) =>
         await generate({ organizationId });`,
      `import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
       await (deps.generate ?? generateTanStackObjectForTask)({ organizationId });`,
      `import { resolveTanStackTextModel } from "@/api/lib/tanstack-ai-generate";
       const resolve = deps.resolve ?? resolveTanStackTextModel;
       await resolve({ organizationId, task: "chat" });`,
      `import { resolveTanStackTextModel } from "@/api/lib/tanstack-ai-generate";
       const defaults = { resolveModel: resolveTanStackTextModel };
       await dependencies.resolveModel({ organizationId, task: "chat" });`,
    ];
    for (const source of offending) {
      const result = scan(source);
      expect(result.sites).toHaveLength(1);
      expect(result.violations).toHaveLength(1);
    }
  });

  test("accepts a dispatch that names its admission or passes typed options", () => {
    const compliant = [
      `import { generateTanStackTextForTask } from "@/api/lib/tanstack-ai-generate";
       await generateTanStackTextForTask({ organizationId, admission, task: "short-text" });`,
      `import { generateTanStackTextForTask } from "@/api/lib/tanstack-ai-generate";
       await generateTanStackTextForTask({ organizationId, admission: context.admission });`,
      `import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
       await generateTanStackObjectForTask(options);`,
      `import { generateTanStackTextForTask } from "@/api/lib/tanstack-ai-generate";
       await generateTanStackTextForTask({ ...options, resolveTextModel });`,
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
      "lib/workflow/decisions/decide.ts",
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
      walk(parseSource(file, source).program, (node) => {
        if (
          node.type === "Literal" &&
          typeof node.value === "string" &&
          Object.hasOwn(ACTION_KINDS, node.value)
        ) {
          referenced.add(node.value);
        }
      });
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
    for (const modelTier of Object.values(MANAGED_MODEL_TIER)) {
      const admission = testModelAdmission(
        organizationId,
        "chat.send",
        modelTier,
      );
      expect(admission).toMatchObject({
        type: "organization",
        organizationId,
        actionKind: "chat.send",
        modelTier,
      });
      expect(() =>
        assertModelDispatchScope({ organizationId, userId: null, admission }),
      ).not.toThrow();
    }
  });

  test("work with no organization dispatches only without one", () => {
    expect(() =>
      assertModelDispatchScope({
        organizationId: null,
        userId: null,
        admission: NO_ORGANIZATION_MODEL_DISPATCH,
      }),
    ).not.toThrow();
    expect(NO_ORGANIZATION_MODEL_DISPATCH.modelTier).toBe(
      MANAGED_MODEL_TIER.standard,
    );
  });
});

describe("minted model tier", () => {
  test("a proof minted without the free tier is standard and reads nothing", async () => {
    testState.setConfig("FEATURE_FREE_TIER", false);
    const scopedDb = mock(async () => await Promise.reject(new Error("read")));
    const modelTier = await admitModelDispatch({
      organizationId: mintAuthProviderId<"organization">(),
      userId: null,
      actionKind: "chat.send",
      organizationStateDb: asTestRaw<ScopedDb>(scopedDb),
      signal: new AbortController().signal,
      run: async (admission) => await Promise.resolve(admission.modelTier),
    });
    expect(modelTier.unwrap()).toBe(MANAGED_MODEL_TIER.standard);
    expect(scopedDb).not.toHaveBeenCalled();
  });

  test("a proof minted under the free tier reads its organization's standing", async () => {
    testState.setConfig("FEATURE_FREE_TIER", true);
    const failure = new Error("access state unavailable");
    const scopedDb = mock(async () => await Promise.reject(failure));
    // The tier comes only from the organization's scope: a failed read
    // refuses the mint instead of defaulting a tier.
    expect(
      await rejectionOf(
        admitModelDispatch({
          organizationId: mintAuthProviderId<"organization">(),
          userId: null,
          actionKind: "chat.send",
          organizationStateDb: asTestRaw<ScopedDb>(scopedDb),
          signal: new AbortController().signal,
          run: async (admission) => await Promise.resolve(admission),
        }),
      ),
    ).toBe(failure);
    expect(scopedDb).toHaveBeenCalledTimes(1);
  });
});
