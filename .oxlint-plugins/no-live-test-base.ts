/**
 * Test baselines use treeBaseRevision, never a moving remote tip. Recognizes
 * argv arrays passed to spawners, run wrappers and git-named wrappers. A
 * missing cwd means the checkout; an explicit cwd is checked only when its
 * initializer derives from import.meta or process.cwd(). Fixture directories
 * (mkdtemp, parameters, and their aliases) need no exemptions. Arbitrary shell
 * strings, explicit PATH overrides, interprocedural cwd forwarding and dynamically built argv are outside
 * this syntactic check.
 */
import { eslintCompatPlugin, type Ranged } from "@oxlint/plugins";

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

const parts = (value: unknown): string[] => {
  const node = unwrapExpression(value);
  if (node === null) {
    return [];
  }
  const text = staticStringValue(node);
  if (text !== null) {
    return [text];
  }
  if (node.type === "ArrayExpression" && Array.isArray(node.elements)) {
    return node.elements.flatMap(parts);
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

const cwdProperty = (value: unknown): AstNode | null => {
  const node = unwrapExpression(value);
  if (node?.type !== "ObjectExpression" || !Array.isArray(node.properties)) {
    return null;
  }
  for (const property of node.properties) {
    if (isAstNode(property) && getPropertyName(property.key) === "cwd") {
      return unwrapExpression(property.value);
    }
  }
  return null;
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
              if (node.arguments.some(overridesGitPath)) {
                return;
              }
              const argv = node.arguments.flatMap(parts);
              if (!argv.some((arg) => /^origin\/main(?:[:.^~]|$)/u.test(arg))) {
                return;
              }
              const callee = unwrapExpression(node.callee);
              const name =
                callee?.type === "Identifier"
                  ? callee.name
                  : callee?.type === "MemberExpression"
                    ? getPropertyName(callee.property)
                    : null;
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
              const cwd = node.arguments
                .map(cwdProperty)
                .find((value) => value !== null);
              if (cwd !== undefined) {
                if (!checkoutPath({ context, value: cwd })) {
                  return;
                }
              } else {
                const positional = node.arguments.filter(
                  (arg) =>
                    isAstNode(arg) &&
                    arg.type !== "ArrayExpression" &&
                    !(
                      typeof name === "string" &&
                      SPAWN_CALLS.has(name) &&
                      arg.type === "ObjectExpression"
                    ) &&
                    staticStringValue(arg) !== "git",
                );
                if (
                  positional.length > 0 &&
                  !positional.some((arg) =>
                    checkoutPath({ context, value: arg }),
                  )
                ) {
                  return;
                }
                if (
                  gitWrapper &&
                  !node.arguments.some((arg) =>
                    checkoutPath({ context, value: arg }),
                  )
                ) {
                  return;
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
