/**
 * Repo-local oxlint rules, loaded through `jsPlugins` in
 * oxlint.config.ts (ESLint-compatible plugin shape).
 */

type ImportExpressionSource = {
  type: string;
  value?: unknown;
  expressions?: readonly unknown[];
};

type ImportExpressionNode = {
  type: "ImportExpression";
  source: ImportExpressionSource;
};

type RuleContext = {
  report: (descriptor: { node: unknown; messageId: string }) => void;
  sourceCode: {
    isGlobalReference: (node: AstNode) => boolean;
  };
};

type AstNode = {
  type: string;
  callee?: AstNode;
  computed?: boolean;
  expression?: AstNode;
  id?: AstNode;
  init?: AstNode | null;
  name?: string;
  object?: AstNode;
  property?: AstNode;
  parent?: AstNode;
  typeAnnotation?: AstNode;
  value?: unknown;
};

const isErasureType = (node: AstNode | undefined): boolean =>
  node?.type === "TSUnknownKeyword" || node?.type === "TSAnyKeyword";

const isUnknownType = (node: AstNode | undefined): boolean =>
  node?.type === "TSUnknownKeyword";

const isMemberExpression = (node: AstNode | undefined): boolean =>
  node?.type === "MemberExpression" ||
  node?.type === "ComputedMemberExpression" ||
  node?.type === "StaticMemberExpression";

const hasStaticMemberName = (node: AstNode, name: string): boolean => {
  if (!isMemberExpression(node)) {
    return false;
  }
  if (node.computed === true) {
    return (
      (node.property?.type === "Literal" ||
        node.property?.type === "StringLiteral") &&
      node.property.value === name
    );
  }
  return node.property?.type === "Identifier" && node.property.name === name;
};

const isGlobalIdentifier = (
  node: AstNode | undefined,
  name: string,
  isGlobalReference: (node: AstNode) => boolean,
): boolean =>
  node?.type === "Identifier" && node.name === name && isGlobalReference(node);

const isJsonObject = (
  node: AstNode | undefined,
  isGlobalReference: (node: AstNode) => boolean,
): boolean => {
  if (isGlobalIdentifier(node, "JSON", isGlobalReference)) {
    return true;
  }
  return (
    node !== undefined &&
    hasStaticMemberName(node, "JSON") &&
    isGlobalIdentifier(node.object, "globalThis", isGlobalReference)
  );
};

const isJsonParseCall = (
  node: AstNode | null | undefined,
  isGlobalReference: (node: AstNode) => boolean,
): boolean => {
  if (node?.type !== "CallExpression") {
    return false;
  }
  const { callee } = node;
  return (
    callee !== undefined &&
    hasStaticMemberName(callee, "parse") &&
    isJsonObject(callee.object, isGlobalReference)
  );
};

/**
 * Bundled packages must use statically resolvable import specifiers:
 * a computed specifier survives bundling as a runtime-relative path
 * that does not exist in dist (the published artifact), failing only
 * at runtime for package consumers. Contexts that resolve imports at
 * runtime instead of bundling (tests, bench) opt out via overrides in
 * oxlint.config.ts.
 */
const noDynamicImportSpecifier = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow computed dynamic import specifiers in bundled packages",
    },
    messages: {
      dynamicSpecifier:
        "Computed import() specifiers cannot be resolved by the bundler and break in dist. " +
        "Use a registry of literal import specifiers instead " +
        "(see LOADERS in packages/data/dictionaries/index.ts, or " +
        "CITY_LOADERS in packages/data/dictionaries/city-loaders.ts for a generated one).",
    },
    schema: [],
  },
  create: (context: RuleContext) => ({
    ImportExpression: (node: ImportExpressionNode) => {
      const { source } = node;
      if (source.type === "Literal" && typeof source.value === "string") {
        return;
      }
      if (
        source.type === "TemplateLiteral" &&
        (source.expressions?.length ?? 0) === 0
      ) {
        return;
      }
      context.report({ node: source, messageId: "dynamicSpecifier" });
    },
  }),
};

/**
 * A double assertion erases the compiler's evidence before claiming a domain
 * type. Assertions from `unknown` are allowed only as a single, explicit
 * boundary step; production code must validate or construct the target type.
 */
const noDoubleAssertion = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow `value as unknown as T` double assertions",
    },
    messages: {
      doubleAssertion:
        "Do not erase type information with a double assertion. Validate an external value, or fix the source type so the target is inferred.",
    },
    schema: [],
  },
  create: (context: RuleContext) => {
    const check = (node: AstNode): void => {
      if (
        !isErasureType(node.typeAnnotation) &&
        (node.expression?.type === "TSAsExpression" ||
          node.expression?.type === "TSTypeAssertion") &&
        isErasureType(node.expression.typeAnnotation)
      ) {
        context.report({ node, messageId: "doubleAssertion" });
      }
    };
    return {
      TSAsExpression: check,
      TSTypeAssertion: check,
    };
  },
};

/**
 * `JSON.parse` returns `any`; assigning or asserting that value directly to a
 * domain type makes an untrusted transport value look validated. Parsing to
 * `unknown` remains valid and makes the required validation step explicit.
 */
const noUncheckedJsonParseTyping = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow asserting or annotating JSON.parse results as trusted types",
    },
    messages: {
      uncheckedParse:
        "JSON.parse output is untrusted. Parse to unknown, then validate it before returning or assigning a domain type.",
    },
    schema: [],
  },
  create: (context: RuleContext) => {
    return {
      CallExpression: (node: AstNode) => {
        if (!isJsonParseCall(node, context.sourceCode.isGlobalReference)) {
          return;
        }
        const { parent } = node;
        if (
          (parent?.type === "TSAsExpression" ||
            parent?.type === "TSTypeAssertion") &&
          isUnknownType(parent.typeAnnotation)
        ) {
          return;
        }
        if (
          parent?.type === "VariableDeclarator" &&
          parent.init === node &&
          isUnknownType(parent.id?.typeAnnotation?.typeAnnotation)
        ) {
          return;
        }
        context.report({ node, messageId: "uncheckedParse" });
      },
    };
  },
};

const plugin = {
  meta: { name: "stll" },
  rules: {
    "no-double-assertion": noDoubleAssertion,
    "no-dynamic-import-specifier": noDynamicImportSpecifier,
    "no-unchecked-json-parse-typing": noUncheckedJsonParseTyping,
  },
};

export default plugin;
