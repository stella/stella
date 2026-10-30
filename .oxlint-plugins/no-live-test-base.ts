/**
 * Test baselines use treeBaseRevision, never a moving remote tip. Recognizes
 * argv arrays passed to spawners, run wrappers and git-named wrappers, inline
 * or through stable `const` aliases, as are their options objects. A missing
 * cwd means the checkout; an explicit cwd is checked only when its
 * initializer derives from import.meta or process.cwd(), and an options
 * spread that may replace cwd but cannot be resolved counts as the checkout.
 * A git-named wrapper without a directory argument is followed to its local
 * definition (or the one a factory passes to a callback); an unresolved one
 * runs in the checkout. Fixture directories (mkdtemp, parameters, and their
 * aliases) need no exemptions. Arbitrary shell strings, explicit PATH
 * overrides, other interprocedural cwd forwarding and dynamically built argv
 * are outside this syntactic check.
 */
import { eslintCompatPlugin, type Ranged } from "@oxlint/plugins";
import { panic } from "better-result";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import {
  type AstNode,
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  isTestFile,
  resolveVariable,
  type ScopeContext,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const CHECKOUT_PATH_CALLS = new Set([
  "resolve",
  "join",
  "normalize",
  "fileURLToPath",
  "URL",
]);
const SPAWN_CALLS = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);

const COMMAND_CALLS = new Set([
  ...SPAWN_CALLS,
  "run",
  "runSync",
  "exec",
  "execSync",
]);

/** The expression a stable `const` alias chain names, or the unresolved node. */
const resolveStable = (context: ScopeContext, value: unknown) => {
  const seen = new Set<AstNode>();
  let node = unwrapExpression(value);
  while (node !== null && isIdentifierReference(node) && !seen.has(node)) {
    seen.add(node);
    const variable = resolveVariable(context, node);
    const initializer =
      variable === null ? null : unwrapExpression(stableInitializer(variable));
    if (initializer === null) {
      return node;
    }
    node = initializer;
  }
  return node;
};

const parts = (context: ScopeContext, value: unknown): string[] => {
  const node = resolveStable(context, value);
  if (node === null) {
    return [];
  }
  const text = staticStringValue(node);
  if (text !== null) {
    return [text];
  }
  if (node.type === "ArrayExpression" && Array.isArray(node.elements)) {
    return node.elements.flatMap((element) => parts(context, element));
  }
  if (node.type === "TemplateLiteral" && Array.isArray(node.quasis)) {
    return node.quasis.flatMap((quasi) =>
      isAstNode(quasi) &&
      typeof quasi.value === "object" &&
      quasi.value !== null &&
      "raw" in quasi.value &&
      typeof quasi.value.raw === "string"
        ? [quasi.value.raw]
        : [],
    );
  }
  return [];
};

type CheckoutPathOptions = {
  context: ScopeContext;
  value: unknown;
  seen?: Set<unknown>;
};

const checkoutPath = ({
  context,
  value,
  seen = new Set<unknown>(),
}: CheckoutPathOptions): boolean => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (isIdentifierReference(node)) {
    const variable = resolveVariable(context, node);
    return (
      variable !== null &&
      checkoutPath({ context, value: stableInitializer(variable), seen })
    );
  }
  if (node.type === "MetaProperty") {
    return getPropertyName(node.meta) === "import";
  }
  if (node.type === "MemberExpression") {
    return checkoutPath({ context, value: node.object, seen });
  }
  if (node.type === "CallExpression" || node.type === "NewExpression") {
    const callee = unwrapExpression(node.callee);
    if (
      callee?.type === "MemberExpression" &&
      isIdentifierReference(callee.object) &&
      callee.object.name === "process" &&
      getPropertyName(callee.property) === "cwd"
    ) {
      return true;
    }
    const name =
      callee?.type === "Identifier"
        ? callee.name
        : callee?.type === "MemberExpression"
          ? getPropertyName(callee.property)
          : null;
    if (typeof name !== "string" || !CHECKOUT_PATH_CALLS.has(name)) {
      return false;
    }
    return (
      Array.isArray(node.arguments) &&
      node.arguments.some((arg) =>
        checkoutPath({ context, value: arg, seen: new Set(seen) }),
      )
    );
  }
  return false;
};

type CwdSetting =
  { type: "absent" } | { type: "set"; value: AstNode } | { type: "unresolved" };

const CWD_ABSENT: CwdSetting = { type: "absent" };
const CWD_UNRESOLVED: CwdSetting = { type: "unresolved" };

type CwdSettingOptions = {
  context: ScopeContext;
  value: unknown;
  seen?: Set<AstNode>;
};

/**
 * The cwd an options object passes. Later properties win, so a spread after
 * `cwd` may replace it: a spread is followed into a stable object, and one
 * that cannot be followed leaves the cwd unresolved.
 */
const cwdSetting = ({
  context,
  value,
  seen = new Set<AstNode>(),
}: CwdSettingOptions): CwdSetting => {
  const node = resolveStable(context, value);
  if (
    node?.type !== "ObjectExpression" ||
    !Array.isArray(node.properties) ||
    seen.has(node)
  ) {
    return CWD_ABSENT;
  }
  seen.add(node);
  let setting = CWD_ABSENT;
  for (const property of node.properties) {
    if (!isAstNode(property)) {
      continue;
    }
    if (property.type === "SpreadElement") {
      const spread = resolveStable(context, property.argument);
      const inner =
        spread?.type === "ObjectExpression"
          ? cwdSetting({ context, value: spread, seen })
          : CWD_UNRESOLVED;
      if (inner.type !== "absent") {
        setting = inner;
      }
      continue;
    }
    if (getPropertyName(property.key) !== "cwd") {
      continue;
    }
    const cwd = unwrapExpression(property.value);
    setting = cwd === null ? CWD_UNRESOLVED : { type: "set", value: cwd };
  }
  return setting;
};

// An explicit executable search path may select a fixture's Git stub.
const overridesGitPath = (value: unknown): boolean => {
  const node = unwrapExpression(value);
  if (node?.type !== "ObjectExpression" || !Array.isArray(node.properties)) {
    return false;
  }
  return node.properties.some((property) => {
    if (!isAstNode(property) || getPropertyName(property.key) !== "env") {
      return false;
    }
    const env = unwrapExpression(property.value);
    return (
      env?.type === "ObjectExpression" &&
      Array.isArray(env.properties) &&
      env.properties.some(
        (entry) => isAstNode(entry) && getPropertyName(entry.key) === "PATH",
      )
    );
  });
};

const calleeName = (callee: unknown) => {
  const node = unwrapExpression(callee);
  return node?.type === "Identifier"
    ? node.name
    : node?.type === "MemberExpression"
      ? getPropertyName(node.property)
      : null;
};

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

const descendantCalls = (root: AstNode): AstNode[] => {
  const calls: AstNode[] = [];
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isAstNode(value)) {
      continue;
    }
    if (value.type === "CallExpression") {
      calls.push(value);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "parent") {
        pending.push(child);
      }
    }
  }
  return calls;
};

/** The function a stable binding names: a declaration or a `const` initializer. */
const functionDefinition = (
  context: ScopeContext,
  value: unknown,
): AstNode | null => {
  const node = resolveStable(context, value);
  if (node !== null && FUNCTION_TYPES.has(node.type)) {
    return node;
  }
  if (!isIdentifierReference(node)) {
    return null;
  }
  const variable = resolveVariable(context, node);
  const definition = variable?.defs.at(0);
  return variable?.defs.length === 1 &&
    definition?.type === "FunctionName" &&
    isAstNode(definition.node)
    ? definition.node
    : null;
};

/** Where a Git-named wrapper without a directory argument runs Git. */
type WrapperCheckout = "fixture" | "checkout";

type WrapperOptions = {
  context: ScopeContext;
  callee: unknown;
  seen: Set<unknown>;
};

// A wrapper body runs in a fixture only when every spawn in it passes an
// explicit cwd that does not derive from the checkout.
const functionCheckout = (
  context: ScopeContext,
  fn: AstNode,
): WrapperCheckout => {
  const spawns = descendantCalls(fn).filter((call) => {
    const name = calleeName(call.callee);
    return typeof name === "string" && SPAWN_CALLS.has(name);
  });
  const fixtureBound =
    spawns.length > 0 &&
    spawns.every((call) => {
      const cwd =
        (Array.isArray(call.arguments) ? call.arguments : [])
          .map((arg) => cwdSetting({ context, value: arg }))
          .find((setting) => setting.type !== "absent") ?? CWD_ABSENT;
      return cwd.type === "set" && !checkoutPath({ context, value: cwd.value });
    });
  return fixtureBound ? "fixture" : "checkout";
};

// A callback parameter is bound by the factory that invokes the callback:
// follow `factory((…, git) => …)` to the factory's `callback(…, git)` calls.
const parameterCheckout = (
  { context, seen }: Omit<WrapperOptions, "callee">,
  callback: AstNode,
  parameter: unknown,
): WrapperCheckout => {
  const parameters = Array.isArray(callback.params) ? callback.params : [];
  const position = parameters.indexOf(parameter);
  const call = isAstNode(callback.parent) ? callback.parent : null;
  if (
    position === -1 ||
    call?.type !== "CallExpression" ||
    !Array.isArray(call.arguments)
  ) {
    return "checkout";
  }
  const callbackPosition = call.arguments.indexOf(callback);
  const factory = functionDefinition(context, call.callee);
  const factoryParameter =
    factory !== null && callbackPosition !== -1 && Array.isArray(factory.params)
      ? factory.params.at(callbackPosition)
      : undefined;
  if (factory === null || !isIdentifierReference(factoryParameter)) {
    return "checkout";
  }
  const invocations = descendantCalls(factory).filter((invocation) => {
    const callee = unwrapExpression(invocation.callee);
    return (
      isIdentifierReference(callee) && callee.name === factoryParameter.name
    );
  });
  const fixtureBound =
    invocations.length > 0 &&
    invocations.every(
      (invocation) =>
        Array.isArray(invocation.arguments) &&
        wrapperCheckout({
          context,
          callee: invocation.arguments.at(position),
          seen,
        }) === "fixture",
    );
  return fixtureBound ? "fixture" : "checkout";
};

/**
 * Resolves a Git-named wrapper to its local definition. One the rule cannot
 * follow, such as an import, runs in the checkout.
 */
const wrapperCheckout = ({
  context,
  callee,
  seen,
}: WrapperOptions): WrapperCheckout => {
  const node = unwrapExpression(callee);
  if (!isIdentifierReference(node) || seen.has(node)) {
    return "checkout";
  }
  seen.add(node);
  const variable = resolveVariable(context, node);
  const definition = variable?.defs.at(0);
  if (
    variable === null ||
    definition === undefined ||
    variable.defs.length !== 1 ||
    !isAstNode(definition.node)
  ) {
    return "checkout";
  }
  if (definition.type === "Parameter") {
    return parameterCheckout(
      { context, seen },
      definition.node,
      definition.name,
    );
  }
  const fn = functionDefinition(context, node);
  return fn === null ? "checkout" : functionCheckout(context, fn);
};

export const createTestBasePlugin = (enforcesLine = guardEnforcesLine) =>
  eslintCompatPlugin({
    meta: { name: "no-live-test-base" },
    rules: {
      "no-live-test-base": {
        meta: {
          type: "problem",
          messages: {
            liveBase:
              "Resolve the tree's pinned comparison base with treeBaseRevision from @stll/scripts/src/tree-base-revision instead of reading origin/main.",
          },
        },
        createOnce(context) {
          const enforces = (node: Ranged) => {
            const start = context.sourceCode.getLocFromIndex(
              node.range[0],
            ).line;
            const end = context.sourceCode.getLocFromIndex(
              node.range[1] - 1,
            ).line;
            for (let line = start; line <= end; line++) {
              if (
                enforcesLine({
                  guard: "test-base-revision",
                  file: filenameForContext(context),
                  line,
                })
              ) {
                return true;
              }
            }
            return false;
          };
          let enabled = false;
          return {
            before() {
              const filename = filenameForContext(context);
              enabled =
                isTestFile(filename) ||
                filename.endsWith("no-live-test-base.fixture.ts");
            },
            CallExpression(node) {
              if (!enabled) {
                return;
              }
              if (
                node.arguments.some((arg) =>
                  overridesGitPath(resolveStable(context, arg)),
                )
              ) {
                return;
              }
              const argv = node.arguments.flatMap((arg) => parts(context, arg));
              if (!argv.some((arg) => /^origin\/main(?:[:.^~]|$)/u.test(arg))) {
                return;
              }
              const name = calleeName(node.callee);
              const gitWrapper =
                typeof name === "string" && /git$/iu.test(name);
              if (
                typeof name !== "string" ||
                (!gitWrapper && !COMMAND_CALLS.has(name))
              ) {
                return;
              }
              if (!argv.includes("git") && !gitWrapper) {
                return;
              }
              // A merge-base call is safe but still belongs to the shared owner:
              // it must honor RATCHET_BASE_REF as well.
              const cwd =
                node.arguments
                  .map((arg) => cwdSetting({ context, value: arg }))
                  .find((setting) => setting.type !== "absent") ?? CWD_ABSENT;
              switch (cwd.type) {
                case "set": {
                  if (!checkoutPath({ context, value: cwd.value })) {
                    return;
                  }
                  break;
                }
                case "unresolved": {
                  break;
                }
                case "absent": {
                  // Literal words, argv arrays and spawner options are not a
                  // directory; with no other argument the call runs in the
                  // checkout, for spawners and Git-named wrappers alike.
                  const directories = node.arguments.filter((arg) => {
                    const resolved = resolveStable(context, arg);
                    return (
                      isAstNode(arg) &&
                      resolved?.type !== "ArrayExpression" &&
                      resolved?.type !== "TemplateLiteral" &&
                      !(
                        SPAWN_CALLS.has(name) &&
                        resolved?.type === "ObjectExpression"
                      ) &&
                      staticStringValue(resolved) === null
                    );
                  });
                  if (
                    directories.length > 0 &&
                    !directories.some((arg) =>
                      checkoutPath({ context, value: arg }),
                    )
                  ) {
                    return;
                  }
                  // A wrapper may carry its own directory, such as a fixture
                  // repository captured where it is defined.
                  if (
                    directories.length === 0 &&
                    gitWrapper &&
                    !COMMAND_CALLS.has(name) &&
                    wrapperCheckout({
                      context,
                      callee: node.callee,
                      seen: new Set(),
                    }) === "fixture"
                  ) {
                    return;
                  }
                  break;
                }
                default: {
                  cwd satisfies never;
                  return panic("Unhandled cwd setting");
                }
              }
              if (enforces(node)) {
                context.report({ node, messageId: "liveBase" });
              }
            },
          };
        },
      },
    },
  });

export default createTestBasePlugin();
