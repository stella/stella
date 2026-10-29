import { readFileSync } from "node:fs";
import path from "node:path";

import {
  type Node,
  type ParsedSource,
  parseSource,
  walk,
} from "../packages/scripts/src/syntax-tree";

const TEST_DIRECTORY = path.resolve(
  import.meta.dirname,
  "../.oxlint-plugins/__tests__",
);
// Every exception must name the measured runtime and why the central runner cannot own it.
const TIMEOUT_ALLOWLIST: Readonly<Record<string, string>> = {
  "confine-owner.test.ts":
    "11.36s shuffled runtime; the changed-test gate invokes Bun directly",
};
const TEST_APIS = new Set(["test", "it", "describe", "setDefaultTimeout"]);

/** A string literal or a template literal without substitutions. */
const stringLiteralText = (node: Node): string | undefined => {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.at(0)?.value.cooked ?? undefined;
  }
  return undefined;
};

const memberPath = (expression: Node): string[] => {
  if (expression.type === "Identifier") {
    return [expression.name];
  }
  if (expression.type === "MemberExpression") {
    const members = memberPath(expression.object);
    if (!expression.computed) {
      members.push(
        expression.property.type === "PrivateIdentifier"
          ? `#${expression.property.name}`
          : expression.property.name,
      );
    } else {
      const text = stringLiteralText(expression.property);
      if (text !== undefined) {
        members.push(text);
      }
    }
    return members;
  }
  if (expression.type === "CallExpression") {
    return memberPath(expression.callee);
  }
  if (expression.type === "TaggedTemplateExpression") {
    return memberPath(expression.tag);
  }
  // An optional chain's wrapper is transparent, as in the chain it wraps.
  if (
    expression.type === "ParenthesizedExpression" ||
    expression.type === "ChainExpression"
  ) {
    return memberPath(expression.expression);
  }
  return [];
};

const PATTERNS = new Set([
  "ObjectPattern",
  "ArrayPattern",
  "AssignmentPattern",
  "RestElement",
  "Property",
]);

/**
 * Whether the pattern holding the node at `index` of `ancestors` assigns to
 * existing bindings (`({ a } = b)`, `for ([a] of b)`) rather than declaring.
 */
const isAssignmentPattern = (
  ancestors: readonly Node[],
  index: number,
): boolean => {
  let child = ancestors[index];
  for (let at = index - 1; at >= 0; at -= 1) {
    const ancestor = ancestors[at];
    if (ancestor === undefined || child === undefined) {
      return false;
    }
    if (!PATTERNS.has(ancestor.type)) {
      return (
        (ancestor.type === "AssignmentExpression" && ancestor.left === child) ||
        ((ancestor.type === "ForOfStatement" ||
          ancestor.type === "ForInStatement") &&
          ancestor.left === child)
      );
    }
    child = ancestor;
  }
  return false;
};

const NAMED_DECLARATIONS = new Set([
  "VariableDeclarator",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
  "ClassDeclaration",
  "ClassExpression",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSEnumDeclaration",
  "TSEnumMember",
  "TSModuleDeclaration",
  "TSImportEqualsDeclaration",
  "TSNamespaceExportDeclaration",
  "TSTypeParameter",
  "CatchClause",
  "TSParameterProperty",
  "MetaProperty",
]);
const NAMED_MEMBERS = new Set([
  "MethodDefinition",
  "PropertyDefinition",
  "AccessorProperty",
  "TSAbstractMethodDefinition",
  "TSAbstractPropertyDefinition",
  "TSAbstractAccessorProperty",
  "TSPropertySignature",
  "TSMethodSignature",
]);

type IdentifierRole = "name" | "reference" | "duplicate";

/**
 * Classifies an identifier the way a declaration's `name` slot does: a
 * declared, member or property name is no reference to the test API. oxc
 * repeats a shorthand property as key and value; the key is the duplicate.
 */
const identifierRole = (
  node: Node,
  ancestors: readonly Node[],
): IdentifierRole => {
  const parentIndex = ancestors.length - 1;
  const parent = ancestors[parentIndex];
  if (parent === undefined) {
    return "reference";
  }
  if (parent.type === "MemberExpression") {
    return !parent.computed && parent.property === node ? "name" : "reference";
  }
  if (parent.type === "Property") {
    if (parent.computed && parent.key === node) {
      return "reference";
    }
    const isKey = parent.key === node;
    if (ancestors[parentIndex - 1]?.type !== "ObjectPattern") {
      if (parent.shorthand) {
        return isKey ? "duplicate" : "reference";
      }
      return isKey ? "name" : "reference";
    }
    const assigns = isAssignmentPattern(ancestors, parentIndex);
    if (parent.shorthand) {
      if (!assigns) {
        return "name";
      }
      return isKey ? "duplicate" : "reference";
    }
    // `{ key: value }` names the key when it assigns, the value when it
    // declares.
    return isKey === assigns ? "name" : "reference";
  }
  if (
    parent.type === "ArrayPattern" ||
    (parent.type === "AssignmentPattern" && parent.left === node) ||
    (parent.type === "RestElement" && parent.argument === node)
  ) {
    return isAssignmentPattern(ancestors, parentIndex) ? "reference" : "name";
  }
  return declarationRole(node, parent);
};

/** Names in declarations, signatures and class members. */
const declarationRole = (node: Node, parent: Node): IdentifierRole => {
  if (
    ("params" in parent &&
      parent.params.some((parameter: Node) => parameter === node)) ||
    parent.type === "TSIndexSignature"
  ) {
    return "name";
  }
  if (NAMED_DECLARATIONS.has(parent.type)) {
    const isValue =
      ("init" in parent && parent.init === node) ||
      ("body" in parent && parent.body === node) ||
      ("superClass" in parent && parent.superClass === node) ||
      ("initializer" in parent && parent.initializer === node) ||
      ("moduleReference" in parent && parent.moduleReference === node);
    return isValue ? "reference" : "name";
  }
  const isMemberName =
    NAMED_MEMBERS.has(parent.type) &&
    "key" in parent &&
    parent.key === node &&
    !("computed" in parent && parent.computed);
  return isMemberName ? "name" : "reference";
};

const testPolicyViolation = (file: ParsedSource): string | undefined => {
  const bindings = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of file.program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.source.value !== "bun:test"
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") {
        namespaces.add(specifier.local.name);
      } else if (specifier.type === "ImportSpecifier") {
        bindings.set(
          specifier.local.name,
          specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : specifier.imported.value,
        );
      }
    }
  }
  const apiFor = (expression: Node): string | undefined => {
    const members = memberPath(expression);
    const root = members.at(0);
    if (root === undefined) {
      return undefined;
    }
    return namespaces.has(root) ? members.at(1) : bindings.get(root);
  };
  const isTestReference = (expression: Node): boolean => {
    const api = apiFor(expression);
    if (api !== undefined && TEST_APIS.has(api)) {
      return true;
    }
    const members = memberPath(expression);
    return members.length === 1 && namespaces.has(members.at(0) ?? "");
  };
  const isFactoryValue = (expression: Node): boolean => {
    if (
      expression.type !== "CallExpression" &&
      expression.type !== "TaggedTemplateExpression"
    ) {
      return false;
    }
    let target =
      expression.type === "CallExpression" ? expression.callee : expression.tag;
    while (
      target.type === "ParenthesizedExpression" ||
      target.type === "ChainExpression"
    ) {
      target = target.expression;
    }
    return (
      target.type !== "CallExpression" &&
      target.type !== "TaggedTemplateExpression" &&
      ["each", "if", "skipIf"].includes(memberPath(target).at(-1) ?? "")
    );
  };
  const isTimeoutFreeOptions = (expression: Node): boolean => {
    if (expression.type !== "ObjectExpression") {
      return false;
    }
    return expression.properties.every((property) => {
      if (property.type !== "Property" || property.computed) {
        return false;
      }
      if (property.key.type === "Identifier") {
        return property.key.name !== "timeout";
      }
      return (
        property.key.type === "Literal" &&
        typeof property.key.value === "string" &&
        property.key.value !== "timeout"
      );
    });
  };

  type Position = {
    /** The node, or the optional chain wrapping it. */
    self: Node;
    parent: Node | undefined;
  };
  const position = (node: Node, ancestors: readonly Node[]): Position => {
    const wrapper = ancestors.at(-1);
    return wrapper?.type === "ChainExpression" && wrapper.expression === node
      ? { self: wrapper, parent: ancestors.at(-2) }
      : { self: node, parent: wrapper };
  };

  const isIndirectReference = (
    expression: Node,
    ancestors: readonly Node[],
  ): boolean => {
    if (!isTestReference(expression)) {
      return false;
    }
    if (
      expression.type === "MemberExpression" &&
      expression.computed &&
      stringLiteralText(expression.property) === undefined
    ) {
      return true;
    }
    if (
      memberPath(expression).some((member) =>
        ["bind", "call", "apply"].includes(member),
      )
    ) {
      return true;
    }
    const { self, parent } = position(expression, ancestors);
    const isName =
      expression.type === "Identifier" &&
      identifierRole(expression, ancestors) === "name";
    const isChainPart =
      (parent?.type === "MemberExpression" && parent.object === self) ||
      (parent?.type === "ParenthesizedExpression" &&
        parent.expression === self);
    const isCallTarget =
      (parent?.type === "CallExpression" && parent.callee === self) ||
      (parent?.type === "TaggedTemplateExpression" && parent.tag === self);
    const isCall =
      expression.type === "CallExpression" ||
      expression.type === "TaggedTemplateExpression";
    return (
      !isName &&
      !isChainPart &&
      !isCallTarget &&
      (!isCall || isFactoryValue(expression))
    );
  };

  let violation: string | undefined;
  walk(file.program, (node, ancestors) => {
    if (violation !== undefined || node.type === "ImportDeclaration") {
      return "skip-children";
    }
    if (
      node.type === "Identifier" &&
      identifierRole(node, ancestors) === "duplicate"
    ) {
      return undefined;
    }
    if (
      node.type !== "ChainExpression" &&
      isIndirectReference(node, ancestors)
    ) {
      violation = "call test APIs directly";
      return "skip-children";
    }
    if (node.type === "CallExpression") {
      // The data call in test.each(cases)(...) has no test arguments.
      const { self, parent } = position(node, ancestors);
      const isFactory =
        (parent?.type === "CallExpression" && parent.callee === self) ||
        (parent?.type === "TaggedTemplateExpression" && parent.tag === self);
      const api = apiFor(node.callee);
      if (!isFactory && api !== undefined && TEST_APIS.has(api)) {
        const secondArgument = node.arguments.at(1);
        const thirdArgument = node.arguments.at(2);
        const optionsFirst =
          secondArgument !== undefined &&
          (secondArgument.type === "ObjectExpression" ||
            (thirdArgument !== undefined &&
              (thirdArgument.type === "ArrowFunctionExpression" ||
                thirdArgument.type === "FunctionExpression")));
        const optionsArgument = optionsFirst ? secondArgument : thirdArgument;
        if (
          api === "setDefaultTimeout" ||
          node.arguments.some(
            (argument) => argument.type === "SpreadElement",
          ) ||
          (optionsArgument !== undefined &&
            !isTimeoutFreeOptions(optionsArgument))
        ) {
          violation =
            "pass test options inline without timeout keys or spreads";
          return "skip-children";
        }
      }
    }
    return undefined;
  });
  return violation;
};

type CustomLintTestTimeoutOptions = {
  directory?: string;
  allowlist?: Readonly<Record<string, string>>;
};

export const customLintTestTimeoutViolations = ({
  directory = TEST_DIRECTORY,
  allowlist = TIMEOUT_ALLOWLIST,
}: CustomLintTestTimeoutOptions = {}): string[] => {
  const violations: string[] = [];
  for (const filename of new Bun.Glob(
    "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
  ).scanSync(directory)) {
    const source = readFileSync(path.join(directory, filename), "utf-8");
    const violation = testPolicyViolation(parseSource(filename, source));
    if (violation === undefined) {
      continue;
    }
    const reason = allowlist[filename];
    if (reason === undefined || reason.trim() === "") {
      violations.push(
        `${filename}: ${violation}; exceptions require an allow-list reason`,
      );
    }
  }
  return violations.toSorted();
};
