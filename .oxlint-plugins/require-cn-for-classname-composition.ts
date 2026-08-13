// Require dynamic JSX class-name composition to use Stella's canonical cn().
// Static classes and pass-through className values stay valid; conditional,
// interpolated, concatenated, or helper-composed values must enter through cn()
// so Tailwind conflicts are resolved consistently.
// Adapted from https://github.com/typeonce-dev/ai-automation

import {
  eslintCompatPlugin,
  type ESTree,
  type Scope,
  type Variable,
} from "@oxlint/plugins";

import {
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const CANONICAL_CN_MODULE = "@stll/ui/lib/utils";
const CANONICAL_CN_EXPORT = "cn";

const isIdentifierReference = (
  node: unknown,
): node is ESTree.IdentifierReference => isIdentifier(node);

const isMemberExpression = (node: unknown): node is ESTree.MemberExpression =>
  isAstNode(node) && node.type === "MemberExpression";

const isObjectExpression = (node: unknown): node is ESTree.ObjectExpression =>
  isAstNode(node) && node.type === "ObjectExpression";

const isTemplateLiteral = (node: unknown): node is ESTree.TemplateLiteral =>
  isAstNode(node) && node.type === "TemplateLiteral";

const isFunctionExpression = (
  node: unknown,
): node is ESTree.ArrowFunctionExpression | ESTree.FunctionExpression =>
  isAstNode(node) &&
  (node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression");

const isClassNameAttribute = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "JSXAttribute" &&
  isAstNode(node.name) &&
  node.name.type === "JSXIdentifier" &&
  typeof node.name.name === "string" &&
  (node.name.name === "className" || node.name.name.endsWith("ClassName"));

const unwrapClassExpression = (value: unknown) => {
  const node = unwrapExpression(value);
  if (
    node !== null &&
    (node.type === "ParenthesizedExpression" ||
      node.type === "TSInstantiationExpression" ||
      node.type === "TSNonNullExpression" ||
      node.type === "TSTypeAssertion")
  ) {
    return unwrapClassExpression(node.expression);
  }
  return node;
};

const isStaticLiteral = (node: unknown): boolean =>
  isAstNode(node) &&
  (node.type === "Literal" ||
    node.type === "BigIntLiteral" ||
    node.type === "BooleanLiteral" ||
    node.type === "NullLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "RegExpLiteral" ||
    node.type === "StringLiteral");

export default eslintCompatPlugin({
  meta: { name: "require-cn-for-classname-composition" },
  rules: {
    "require-cn-for-classname-composition": {
      meta: {
        type: "problem",
        messages: {
          requireCanonicalCn:
            "Compose dynamic className values with cn imported from @stll/ui/lib/utils.",
        },
      },
      createOnce(context) {
        const reportedAttributes = new Set<unknown>();
        const conditionalCallbackAttributes = new Set<unknown>();

        const resolveVariable = (identifier: unknown): Variable | null => {
          if (!isIdentifierReference(identifier)) {
            return null;
          }
          let scope: Scope | null = context.sourceCode.getScope(identifier);
          while (scope !== null) {
            const variable = scope.set.get(identifier.name);
            if (variable !== undefined) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        const getConstInitializer = (identifier: unknown): unknown => {
          const variable = resolveVariable(identifier);
          if (variable === null) {
            return null;
          }
          for (const definition of variable.defs) {
            if (
              definition.type === "Variable" &&
              isAstNode(definition.node) &&
              definition.node.type === "VariableDeclarator" &&
              isAstNode(definition.parent) &&
              definition.parent.type === "VariableDeclaration" &&
              definition.parent.kind === "const"
            ) {
              return definition.node.init;
            }
          }
          return null;
        };

        const isCanonicalCn = (identifier: unknown): boolean => {
          const variable = resolveVariable(identifier);
          return (
            variable?.defs.some(
              (definition) =>
                definition.type === "ImportBinding" &&
                isAstNode(definition.node) &&
                definition.node.type === "ImportSpecifier" &&
                getImportedName(definition.node) === CANONICAL_CN_EXPORT &&
                isAstNode(definition.parent) &&
                definition.parent.type === "ImportDeclaration" &&
                isAstNode(definition.parent.source) &&
                definition.parent.source.value === CANONICAL_CN_MODULE,
            ) ?? false
          );
        };

        const localMemberValue = (value: unknown): unknown => {
          const member = unwrapClassExpression(value);
          if (!isMemberExpression(member)) {
            return null;
          }
          const propertyName =
            member.computed === false
              ? getPropertyName(member.property)
              : isStringLiteral(member.property)
                ? member.property.value
                : null;
          if (propertyName === null) {
            return null;
          }

          const owner = unwrapClassExpression(member.object);
          const ownerValue = isIdentifierReference(owner)
            ? getConstInitializer(owner)
            : isMemberExpression(owner)
              ? localMemberValue(owner)
              : owner;
          const object = unwrapClassExpression(ownerValue);
          if (!isObjectExpression(object)) {
            return null;
          }

          for (const property of object.properties) {
            if (
              property.type === "Property" &&
              property.computed === false &&
              getPropertyName(property.key) === propertyName
            ) {
              return property.value;
            }
            if (
              property.type === "Property" &&
              property.computed === true &&
              isStringLiteral(property.key) &&
              property.key.value === propertyName
            ) {
              return property.value;
            }
          }
          return null;
        };

        const isCanonicalCnComposition = (
          value: unknown,
          visitedVariables = new Set<Variable>(),
        ): boolean => {
          const node = unwrapClassExpression(value);
          if (node === null) {
            return false;
          }
          if (node.type === "CallExpression") {
            return isCanonicalCn(node.callee);
          }
          if (!isIdentifier(node)) {
            return false;
          }
          const variable = resolveVariable(node);
          if (variable === null || visitedVariables.has(variable)) {
            return false;
          }
          visitedVariables.add(variable);
          return isCanonicalCnComposition(
            getConstInitializer(node),
            visitedVariables,
          );
        };

        const isAllowedClassValue = (
          value: unknown,
          visitedVariables = new Set<Variable>(),
        ): boolean => {
          const node = unwrapClassExpression(value);
          if (node === null || isStaticLiteral(node)) {
            return true;
          }
          if (isIdentifier(node)) {
            const variable = resolveVariable(node);
            if (variable === null) {
              return true;
            }
            const initializer = getConstInitializer(node);
            if (initializer === null) {
              return true;
            }
            if (visitedVariables.has(variable)) {
              return true;
            }
            visitedVariables.add(variable);
            return isAllowedClassValue(initializer, visitedVariables);
          }
          if (isMemberExpression(node)) {
            const localValue = localMemberValue(node);
            return (
              localValue === null ||
              isAllowedClassValue(localValue, visitedVariables)
            );
          }
          if (isTemplateLiteral(node)) {
            return node.expressions.length === 0;
          }
          if (node.type === "CallExpression") {
            return isCanonicalCn(node.callee);
          }
          if (isFunctionExpression(node)) {
            return (
              node.body?.type === "BlockStatement" ||
              isAllowedClassValue(node.body, visitedVariables)
            );
          }
          return false;
        };

        const report = (node: unknown) => {
          if (!isAstNode(node) || reportedAttributes.has(node)) {
            return;
          }
          reportedAttributes.add(node);
          context.report({ node, messageId: "requireCanonicalCn" });
        };

        const getEnclosingClassNameAttribute = (node: unknown): unknown => {
          if (!isAstNode(node)) {
            return null;
          }
          let current = node.parent;
          while (
            isAstNode(current) &&
            current.type !== "ArrowFunctionExpression" &&
            current.type !== "FunctionExpression"
          ) {
            current = current.parent;
          }
          if (
            !isAstNode(current) ||
            !isAstNode(current.parent) ||
            current.parent.type !== "JSXExpressionContainer" ||
            !isAstNode(current.parent.parent) ||
            !isClassNameAttribute(current.parent.parent)
          ) {
            return null;
          }
          return current.parent.parent;
        };

        return {
          before() {
            reportedAttributes.clear();
            conditionalCallbackAttributes.clear();
          },
          IfStatement(node) {
            const attribute = getEnclosingClassNameAttribute(node);
            if (attribute !== null) {
              conditionalCallbackAttributes.add(attribute);
            }
          },
          SwitchStatement(node) {
            const attribute = getEnclosingClassNameAttribute(node);
            if (attribute !== null) {
              conditionalCallbackAttributes.add(attribute);
            }
          },
          JSXAttribute(node) {
            if (
              !isClassNameAttribute(node) ||
              node.value?.type !== "JSXExpressionContainer" ||
              node.value.expression?.type === "JSXEmptyExpression"
            ) {
              return;
            }
            const expression = unwrapClassExpression(node.value.expression);
            if (
              isFunctionExpression(expression) &&
              expression.type === "ArrowFunctionExpression" &&
              expression.body?.type === "BlockStatement"
            ) {
              return;
            }
            if (
              isFunctionExpression(expression) &&
              expression.type === "FunctionExpression" &&
              expression.body?.type === "BlockStatement"
            ) {
              return;
            }
            if (!isAllowedClassValue(expression)) {
              report(node);
            }
          },
          ReturnStatement(node) {
            if (node.argument === null) {
              return;
            }
            const attribute = getEnclosingClassNameAttribute(node);
            if (
              attribute !== null &&
              ((conditionalCallbackAttributes.has(attribute) &&
                !isCanonicalCnComposition(node.argument)) ||
                !isAllowedClassValue(node.argument))
            ) {
              report(attribute);
            }
          },
        };
      },
    },
  },
});
