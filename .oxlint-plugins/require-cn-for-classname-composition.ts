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
): node is
  | ESTree.ArrowFunctionExpression
  | (ESTree.Function & { type: "FunctionExpression" }) =>
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

        const localMemberValue = (
          value: unknown,
          visitedVariables = new Set<Variable>(),
        ): unknown => {
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

          const resolveObject = (
            candidate: unknown,
          ): ESTree.ObjectExpression | null => {
            const expression = unwrapClassExpression(candidate);
            if (isObjectExpression(expression)) {
              return expression;
            }
            if (isMemberExpression(expression)) {
              return resolveObject(
                localMemberValue(expression, visitedVariables),
              );
            }
            if (!isIdentifierReference(expression)) {
              return null;
            }
            const variable = resolveVariable(expression);
            if (variable === null || visitedVariables.has(variable)) {
              return null;
            }
            visitedVariables.add(variable);
            return resolveObject(getConstInitializer(expression));
          };

          const readProperty = (object: ESTree.ObjectExpression): unknown => {
            for (
              let index = object.properties.length - 1;
              index >= 0;
              index--
            ) {
              const property = object.properties.at(index);
              if (property === undefined) {
                continue;
              }
              if (property.type === "SpreadElement") {
                const spreadObject = resolveObject(property.argument);
                if (spreadObject !== null) {
                  const spreadValue = readProperty(spreadObject);
                  if (spreadValue !== null) {
                    return spreadValue;
                  }
                }
                continue;
              }
              if (
                property.computed === false &&
                getPropertyName(property.key) === propertyName
              ) {
                return property.value;
              }
              if (
                property.computed === true &&
                isStringLiteral(property.key) &&
                property.key.value === propertyName
              ) {
                return property.value;
              }
              if (property.computed === true) {
                return null;
              }
            }
            return null;
          };

          const object = resolveObject(member.object);
          return object === null ? null : readProperty(object);
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
            const localValue = localMemberValue(
              node,
              new Set(visitedVariables),
            );
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
            if (node.body?.type !== "BlockStatement") {
              return isAllowedClassValue(node.body, visitedVariables);
            }

            const returnValues: unknown[] = [];
            const visitBody = (candidate: unknown, isRoot = false): void => {
              if (!isAstNode(candidate)) {
                return;
              }
              if (
                !isRoot &&
                (candidate.type === "ArrowFunctionExpression" ||
                  candidate.type === "FunctionExpression" ||
                  candidate.type === "FunctionDeclaration")
              ) {
                return;
              }
              if (candidate.type === "ReturnStatement") {
                returnValues.push(candidate.argument);
                return;
              }
              for (const [key, child] of Object.entries(candidate)) {
                if (key === "parent" || key === "loc" || key === "range") {
                  continue;
                }
                if (Array.isArray(child)) {
                  for (const item of child) {
                    visitBody(item);
                  }
                } else {
                  visitBody(child);
                }
              }
            };
            visitBody(node.body, true);

            const returnKinds = new Set(
              returnValues.map((returnValue) => {
                if (returnValue === null) {
                  return "empty";
                }
                if (isCanonicalCnComposition(returnValue)) {
                  return "canonical";
                }
                const returned = unwrapClassExpression(returnValue);
                if (isStringLiteral(returned)) {
                  return `static:${returned.value}`;
                }
                if (
                  isTemplateLiteral(returned) &&
                  returned.expressions.length === 0
                ) {
                  return `static:${context.sourceCode.getText(returned)}`;
                }
                return isAstNode(returned)
                  ? `dynamic:${context.sourceCode.getText(returned)}`
                  : "dynamic:unknown";
              }),
            );
            const selectsClassValue = returnKinds.size > 1;

            return returnValues.every((returnValue) =>
              selectsClassValue
                ? isCanonicalCnComposition(returnValue)
                : isAllowedClassValue(returnValue, new Set(visitedVariables)),
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

        return {
          before() {
            reportedAttributes.clear();
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
            if (!isAllowedClassValue(expression)) {
              report(node);
            }
          },
        };
      },
    },
  },
});
