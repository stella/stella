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

const isFunction = (
  node: unknown,
): node is
  | ESTree.ArrowFunctionExpression
  | (ESTree.Function & {
      type: "FunctionDeclaration" | "FunctionExpression";
    }) =>
  isAstNode(node) &&
  (node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration");

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

type LogicalDisposition = "falsy" | "nullish" | "truthy" | "unknown";

const logicalDisposition = (value: unknown): LogicalDisposition => {
  const expression = unwrapClassExpression(value);
  if (expression === null) {
    return "unknown";
  }
  if (
    expression.type === "Literal" ||
    expression.type === "BigIntLiteral" ||
    expression.type === "BooleanLiteral" ||
    expression.type === "NullLiteral" ||
    expression.type === "NumericLiteral" ||
    expression.type === "StringLiteral"
  ) {
    if (!("value" in expression) || expression.value === null) {
      return "nullish";
    }
    return expression.value ? "truthy" : "falsy";
  }
  if (isTemplateLiteral(expression) && expression.expressions.length === 0) {
    const quasi = expression.quasis.at(0);
    return (quasi?.value.cooked ?? quasi?.value.raw ?? "") === ""
      ? "falsy"
      : "truthy";
  }
  if (
    expression.type === "ObjectExpression" ||
    expression.type === "ArrayExpression" ||
    isFunction(expression)
  ) {
    return "truthy";
  }
  if (expression.type === "UnaryExpression") {
    if (expression.operator === "void") {
      return "nullish";
    }
    if (expression.operator === "typeof") {
      return "truthy";
    }
    if (expression.operator === "!") {
      const argumentDisposition = logicalDisposition(expression.argument);
      if (argumentDisposition === "truthy") {
        return "falsy";
      }
      if (
        argumentDisposition === "falsy" ||
        argumentDisposition === "nullish"
      ) {
        return "truthy";
      }
    }
  }
  if (
    expression.type === "SequenceExpression" &&
    Array.isArray(expression.expressions)
  ) {
    return logicalDisposition(expression.expressions.at(-1));
  }
  return "unknown";
};

const isProvablyNonObject = (value: unknown): boolean => {
  const expression = unwrapClassExpression(value);
  if (expression === null) {
    return false;
  }
  if (
    (expression.type === "Literal" &&
      (expression.value === null || typeof expression.value !== "object")) ||
    expression.type === "BigIntLiteral" ||
    expression.type === "BooleanLiteral" ||
    expression.type === "NullLiteral" ||
    expression.type === "NumericLiteral" ||
    expression.type === "StringLiteral" ||
    expression.type === "TemplateLiteral" ||
    expression.type === "BinaryExpression" ||
    expression.type === "UnaryExpression" ||
    expression.type === "UpdateExpression"
  ) {
    return true;
  }
  if (
    expression.type === "SequenceExpression" &&
    Array.isArray(expression.expressions)
  ) {
    return isProvablyNonObject(expression.expressions.at(-1));
  }
  return false;
};

type LogicalExpressionNode = {
  left: unknown;
  operator: "&&" | "??" | "||";
  right: unknown;
  type: "LogicalExpression";
};

const isLogicalExpression = (value: unknown): value is LogicalExpressionNode =>
  isAstNode(value) &&
  value.type === "LogicalExpression" &&
  isAstNode(value.left) &&
  isAstNode(value.right) &&
  (value.operator === "&&" ||
    value.operator === "||" ||
    value.operator === "??");

type LogicalOutcome = { propertyAbsent: boolean; value: unknown };

const logicalOutcomes = (
  expression: LogicalExpressionNode,
): LogicalOutcome[] => {
  const leftDisposition = logicalDisposition(expression.left);
  if (expression.operator === "&&") {
    if (leftDisposition === "truthy") {
      return [{ propertyAbsent: false, value: expression.right }];
    }
    if (leftDisposition === "falsy" || leftDisposition === "nullish") {
      return [{ propertyAbsent: true, value: expression.left }];
    }
    return [
      { propertyAbsent: true, value: expression.left },
      { propertyAbsent: false, value: expression.right },
    ];
  }
  if (expression.operator === "||") {
    if (leftDisposition === "truthy") {
      return [{ propertyAbsent: false, value: expression.left }];
    }
    if (leftDisposition === "falsy" || leftDisposition === "nullish") {
      return [{ propertyAbsent: false, value: expression.right }];
    }
  }
  if (expression.operator === "??") {
    if (leftDisposition === "nullish") {
      return [{ propertyAbsent: false, value: expression.right }];
    }
    if (leftDisposition === "truthy" || leftDisposition === "falsy") {
      return [{ propertyAbsent: false, value: expression.left }];
    }
  }
  return [
    { propertyAbsent: false, value: expression.left },
    { propertyAbsent: false, value: expression.right },
  ];
};

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

        const getVariableInitializer = (variable: Variable): unknown => {
          for (const definition of variable.defs) {
            if (
              definition.type === "Variable" &&
              isAstNode(definition.node) &&
              definition.node.type === "VariableDeclarator"
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

        const staticPropertyName = (
          property: unknown,
          computed = false,
          visitedVariables = new Set<Variable>(),
        ): string | null => {
          if (!computed) {
            const named = getPropertyName(property);
            if (named !== null) {
              return named;
            }
          }
          const expression = unwrapClassExpression(property);
          if (
            isAstNode(expression) &&
            expression.type === "Literal" &&
            (typeof expression.value === "string" ||
              typeof expression.value === "number")
          ) {
            return String(expression.value);
          }
          if (
            isTemplateLiteral(expression) &&
            expression.expressions.length === 0
          ) {
            const quasi = expression.quasis.at(0);
            return quasi?.value.cooked ?? quasi?.value.raw ?? "";
          }
          if (!isIdentifier(expression)) {
            return null;
          }
          const variable = resolveVariable(expression);
          if (variable === null || visitedVariables.has(variable)) {
            return null;
          }
          for (const definition of variable.defs) {
            if (
              definition.type !== "Variable" ||
              !isAstNode(definition.node) ||
              definition.node.type !== "VariableDeclarator" ||
              !isIdentifier(definition.node.id) ||
              !isAstNode(definition.parent) ||
              definition.parent.type !== "VariableDeclaration" ||
              definition.parent.kind !== "const"
            ) {
              continue;
            }
            const nextVisited = new Set(visitedVariables);
            nextVisited.add(variable);
            return staticPropertyName(definition.node.init, true, nextVisited);
          }
          return null;
        };

        type LocalResolution =
          | { type: "absent" }
          | { type: "found"; value: unknown }
          | { type: "opaque" };

        type LocalObjectRestValue = {
          type: "LocalObjectRestValue";
          excludedProperties: ReadonlySet<string>;
          source: unknown;
        };

        type LocalPossibleValues = {
          type: "LocalPossibleValues";
          values: readonly unknown[];
        };

        type LocalAbsentValue = { type: "LocalAbsentValue" };
        type LocalOpaqueValue = { type: "LocalOpaqueValue" };

        const LOCAL_ABSENT_VALUE: LocalAbsentValue = {
          type: "LocalAbsentValue",
        };
        const LOCAL_OPAQUE_VALUE: LocalOpaqueValue = {
          type: "LocalOpaqueValue",
        };

        const isLocalObjectRestValue = (
          value: unknown,
        ): value is LocalObjectRestValue =>
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          value.type === "LocalObjectRestValue";

        const isLocalPossibleValues = (
          value: unknown,
        ): value is LocalPossibleValues =>
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          value.type === "LocalPossibleValues";

        const isLocalAbsentValue = (
          value: unknown,
        ): value is LocalAbsentValue => value === LOCAL_ABSENT_VALUE;

        const isLocalOpaqueValue = (
          value: unknown,
        ): value is LocalOpaqueValue => value === LOCAL_OPAQUE_VALUE;

        const possibleValues = (value: unknown): readonly unknown[] =>
          isLocalPossibleValues(value) ? value.values : [value];

        const resolutionValues = (
          resolution: LocalResolution,
        ): readonly unknown[] | null => {
          if (resolution.type === "opaque") {
            return null;
          }
          if (resolution.type === "absent") {
            return [LOCAL_ABSENT_VALUE];
          }
          return possibleValues(resolution.value);
        };

        const resolutionFromValues = (
          values: readonly unknown[],
        ): LocalResolution => {
          const flattened = values.flatMap((value) => possibleValues(value));
          if (flattened.every(isLocalAbsentValue)) {
            return { type: "absent" };
          }
          return {
            type: "found",
            value: {
              type: "LocalPossibleValues",
              values: flattened,
            } satisfies LocalPossibleValues,
          };
        };

        const overlayResolution = (
          base: LocalResolution,
          override: LocalResolution,
        ): LocalResolution => {
          if (override.type === "opaque") {
            return override;
          }
          if (override.type === "absent") {
            return base;
          }
          const overrideValues = possibleValues(override.value);
          if (!overrideValues.some(isLocalAbsentValue)) {
            return override;
          }
          const baseValues = resolutionValues(base);
          if (baseValues === null) {
            return { type: "opaque" };
          }
          return resolutionFromValues(
            overrideValues.flatMap((value) =>
              isLocalAbsentValue(value) ? baseValues : [value],
            ),
          );
        };

        const isProvablyUndefined = (value: unknown): boolean => {
          if (isLocalAbsentValue(value)) {
            return true;
          }
          const expression = unwrapClassExpression(value);
          if (
            isAstNode(expression) &&
            expression.type === "UnaryExpression" &&
            expression.operator === "void"
          ) {
            return true;
          }
          if (!isIdentifier(expression) || expression.name !== "undefined") {
            return false;
          }
          const variable = resolveVariable(expression);
          return variable === null || variable.defs.length === 0;
        };

        const controlFlowContext = (
          node: unknown,
          boundary: unknown,
        ): "conditional" | "unconditional" | null => {
          let current = node;
          let conditional = false;
          while (isAstNode(current)) {
            const parent = current.parent;
            if (current === boundary || parent === boundary) {
              return conditional ? "conditional" : "unconditional";
            }
            if (!isAstNode(parent)) {
              return null;
            }
            if (
              (parent.type === "IfStatement" && current !== parent.test) ||
              (parent.type === "ConditionalExpression" &&
                current !== parent.test) ||
              parent.type === "SwitchCase" ||
              (parent.type === "LogicalExpression" &&
                current === parent.right) ||
              (parent.type === "CatchClause" && current === parent.body) ||
              parent.type === "ForStatement" ||
              parent.type === "ForInStatement" ||
              parent.type === "ForOfStatement" ||
              parent.type === "WhileStatement" ||
              parent.type === "DoWhileStatement"
            ) {
              conditional = true;
            }
            if (
              parent.type === "ArrowFunctionExpression" ||
              parent.type === "FunctionExpression" ||
              parent.type === "FunctionDeclaration"
            ) {
              return null;
            }
            current = parent;
          }
          return null;
        };

        const constAliasFromReference = (
          identifier: unknown,
        ): Variable | null => {
          if (!isIdentifier(identifier)) {
            return null;
          }
          let current: unknown = identifier;
          while (isAstNode(current)) {
            const parent = current.parent;
            if (
              isAstNode(parent) &&
              (parent.type === "ParenthesizedExpression" ||
                parent.type === "TSAsExpression" ||
                parent.type === "TSSatisfiesExpression" ||
                parent.type === "TSNonNullExpression" ||
                parent.type === "TSTypeAssertion") &&
              parent.expression === current
            ) {
              current = parent;
              continue;
            }
            if (
              !isAstNode(parent) ||
              parent.type !== "VariableDeclarator" ||
              parent.init !== current ||
              !isIdentifier(parent.id) ||
              !isAstNode(parent.parent) ||
              parent.parent.type !== "VariableDeclaration" ||
              parent.parent.kind !== "const"
            ) {
              return null;
            }
            return resolveVariable(parent.id);
          }
          return null;
        };

        const stableObjectAliases = (
          variable: Variable,
          readPosition: number,
          visited = new Set<Variable>(),
        ): Set<Variable> => {
          if (visited.has(variable)) {
            return visited;
          }
          visited.add(variable);
          for (const reference of variable.references) {
            if (reference.identifier.range[0] >= readPosition) {
              continue;
            }
            const alias = constAliasFromReference(reference.identifier);
            if (alias !== null) {
              stableObjectAliases(alias, readPosition, visited);
            }
          }
          return visited;
        };

        type LocalValueResolver = {
          memberValue: (
            value: unknown,
            visitedVariables?: Set<Variable>,
          ) => unknown;
          patternValue: (
            pattern: unknown,
            source: unknown,
            target: Variable,
            visitedVariables: Set<Variable>,
            readPosition: number,
          ) => unknown;
          propertyValue: (
            source: unknown,
            propertyName: string,
            visitedVariables?: Set<Variable>,
            readPosition?: number,
          ) => unknown;
          propertyResolution: (
            source: unknown,
            propertyName: string,
            visitedVariables?: Set<Variable>,
            readPosition?: number,
          ) => LocalResolution;
          stableValue: (
            identifier: unknown,
            visitedVariables?: Set<Variable>,
          ) => unknown;
        };

        const localValueResolver: LocalValueResolver = {
          memberValue(value, visitedVariables = new Set()) {
            const member = unwrapClassExpression(value);
            if (!isMemberExpression(member)) {
              return null;
            }
            const propertyName = staticPropertyName(
              member.property,
              member.computed,
            );
            if (propertyName === null) {
              return null;
            }
            return this.propertyValue(
              member.object,
              propertyName,
              visitedVariables,
              member.range[0],
            );
          },
          patternValue(
            pattern,
            source,
            target,
            visitedVariables,
            readPosition,
          ) {
            if (!isAstNode(pattern)) {
              return null;
            }
            if (isIdentifier(pattern)) {
              return target.identifiers.some(
                (identifier) => identifier.range[0] === pattern.range[0],
              )
                ? source
                : null;
            }
            if (pattern.type === "AssignmentPattern") {
              if (isLocalPossibleValues(source)) {
                return {
                  type: "LocalPossibleValues",
                  values: source.values.flatMap((possibleValue) =>
                    possibleValues(
                      this.patternValue(
                        pattern,
                        possibleValue,
                        target,
                        new Set(visitedVariables),
                        readPosition,
                      ),
                    ),
                  ),
                } satisfies LocalPossibleValues;
              }
              if (isProvablyUndefined(source)) {
                return this.patternValue(
                  pattern.left,
                  pattern.right,
                  target,
                  visitedVariables,
                  readPosition,
                );
              }
              const selected = this.patternValue(
                pattern.left,
                source,
                target,
                visitedVariables,
                readPosition,
              );
              if (isLocalOpaqueValue(source)) {
                const fallback = this.patternValue(
                  pattern.left,
                  pattern.right,
                  target,
                  visitedVariables,
                  readPosition,
                );
                return {
                  type: "LocalPossibleValues",
                  values: [selected, fallback],
                } satisfies LocalPossibleValues;
              }
              return (
                selected ??
                this.patternValue(
                  pattern.left,
                  pattern.right,
                  target,
                  visitedVariables,
                  readPosition,
                )
              );
            }
            if (
              pattern.type === "ObjectPattern" &&
              Array.isArray(pattern.properties)
            ) {
              for (const property of pattern.properties) {
                if (property.type === "RestElement") {
                  const containsTarget = target.identifiers.some(
                    (identifier) =>
                      identifier.range[0] >= property.argument.range[0] &&
                      identifier.range[1] <= property.argument.range[1],
                  );
                  if (!containsTarget) {
                    continue;
                  }
                  const excludedProperties = new Set<string>();
                  for (const sibling of pattern.properties) {
                    if (sibling.type === "RestElement") {
                      continue;
                    }
                    const siblingName = staticPropertyName(
                      sibling.key,
                      sibling.computed,
                    );
                    if (siblingName === null) {
                      return null;
                    }
                    excludedProperties.add(siblingName);
                  }
                  return {
                    type: "LocalObjectRestValue",
                    excludedProperties,
                    source,
                  } satisfies LocalObjectRestValue;
                }
                if (!isAstNode(property.value)) {
                  continue;
                }
                const containsTarget = target.identifiers.some(
                  (identifier) =>
                    identifier.range[0] >= property.value.range[0] &&
                    identifier.range[1] <= property.value.range[1],
                );
                if (!containsTarget) {
                  continue;
                }
                const propertyName = staticPropertyName(
                  property.key,
                  property.computed,
                );
                if (propertyName === null) {
                  return null;
                }
                const propertyResolution = this.propertyResolution(
                  source,
                  propertyName,
                  new Set(visitedVariables),
                  readPosition,
                );
                const propertyValue =
                  propertyResolution.type === "found"
                    ? propertyResolution.value
                    : propertyResolution.type === "absent"
                      ? LOCAL_ABSENT_VALUE
                      : LOCAL_OPAQUE_VALUE;
                return this.patternValue(
                  property.value,
                  propertyValue,
                  target,
                  visitedVariables,
                  readPosition,
                );
              }
              return null;
            }
            if (
              pattern.type === "ArrayPattern" &&
              Array.isArray(pattern.elements)
            ) {
              for (const [index, element] of pattern.elements.entries()) {
                if (!isAstNode(element)) {
                  continue;
                }
                const containsTarget = target.identifiers.some(
                  (identifier) =>
                    identifier.range[0] >= element.range[0] &&
                    identifier.range[1] <= element.range[1],
                );
                if (containsTarget) {
                  const propertyResolution = this.propertyResolution(
                    source,
                    String(index),
                    new Set(visitedVariables),
                    readPosition,
                  );
                  return this.patternValue(
                    element,
                    propertyResolution.type === "found"
                      ? propertyResolution.value
                      : propertyResolution.type === "absent"
                        ? LOCAL_ABSENT_VALUE
                        : LOCAL_OPAQUE_VALUE,
                    target,
                    visitedVariables,
                    readPosition,
                  );
                }
              }
            }
            return null;
          },
          propertyValue(
            source,
            propertyName,
            visitedVariables = new Set(),
            readPosition,
          ) {
            const resolution = this.propertyResolution(
              source,
              propertyName,
              visitedVariables,
              readPosition,
            );
            return resolution.type === "found" ? resolution.value : null;
          },
          propertyResolution(
            source,
            propertyName,
            visitedVariables = new Set(),
            readPosition = Number.POSITIVE_INFINITY,
          ) {
            if (isLocalAbsentValue(source)) {
              return { type: "absent" };
            }
            if (isLocalOpaqueValue(source)) {
              return { type: "opaque" };
            }
            if (isLocalObjectRestValue(source)) {
              return source.excludedProperties.has(propertyName)
                ? { type: "absent" }
                : this.propertyResolution(
                    source.source,
                    propertyName,
                    visitedVariables,
                    readPosition,
                  );
            }
            const expression = unwrapClassExpression(source);
            if (expression === null) {
              return { type: "opaque" };
            }
            let outcomes: LogicalOutcome[] | null = null;
            if (expression.type === "ConditionalExpression") {
              outcomes = [
                {
                  propertyAbsent: false,
                  value: expression.consequent,
                },
                {
                  propertyAbsent: false,
                  value: expression.alternate,
                },
              ];
            } else if (isLogicalExpression(expression)) {
              outcomes = logicalOutcomes(expression);
            }
            if (outcomes !== null) {
              const resolutions = outcomes.map((outcome) =>
                outcome.propertyAbsent || isProvablyNonObject(outcome.value)
                  ? { type: "absent" as const }
                  : this.propertyResolution(
                      outcome.value,
                      propertyName,
                      new Set(visitedVariables),
                      readPosition,
                    ),
              );
              if (resolutions.some((result) => result.type === "opaque")) {
                return { type: "opaque" };
              }
              if (resolutions.every((result) => result.type === "absent")) {
                return { type: "absent" };
              }
              return {
                type: "found",
                value: {
                  type: "LocalPossibleValues",
                  values: resolutions.flatMap((result) => {
                    if (result.type !== "found") {
                      return [LOCAL_ABSENT_VALUE];
                    }
                    return isLocalPossibleValues(result.value)
                      ? result.value.values
                      : [result.value];
                  }),
                } satisfies LocalPossibleValues,
              };
            }
            if (isIdentifier(expression)) {
              const variable = resolveVariable(expression);
              if (variable === null || visitedVariables.has(variable)) {
                return { type: "opaque" };
              }
              const stableValue = this.stableValue(
                expression,
                visitedVariables,
              );
              const memberWrites: Array<{
                context: "conditional" | "unconditional";
                opaque: boolean;
                position: number;
                value: unknown;
              }> = [];
              for (const ownerVariable of stableObjectAliases(
                variable,
                readPosition,
              )) {
                for (const reference of ownerVariable.references) {
                  if (reference.identifier.range[0] >= readPosition) {
                    continue;
                  }
                  const member = reference.identifier.parent;
                  if (
                    !isMemberExpression(member) ||
                    member.object !== reference.identifier
                  ) {
                    continue;
                  }
                  const owner = member.parent;
                  const isAssignment =
                    isAstNode(owner) &&
                    owner.type === "AssignmentExpression" &&
                    owner.left === member;
                  const isUpdate =
                    isAstNode(owner) &&
                    ((owner.type === "UpdateExpression" &&
                      owner.argument === member) ||
                      (owner.type === "UnaryExpression" &&
                        owner.operator === "delete" &&
                        owner.argument === member));
                  if (!isAssignment && !isUpdate) {
                    continue;
                  }
                  const writtenProperty = staticPropertyName(
                    member.property,
                    member.computed,
                  );
                  if (
                    writtenProperty !== null &&
                    writtenProperty !== propertyName
                  ) {
                    continue;
                  }
                  const writeContext = controlFlowContext(
                    reference.identifier,
                    variable.scope.block,
                  );
                  if (writeContext === null) {
                    continue;
                  }
                  memberWrites.push({
                    context: writeContext,
                    opaque:
                      writtenProperty === null ||
                      !isAssignment ||
                      owner.operator !== "=" ||
                      !isAstNode(owner.right),
                    position: reference.identifier.range[0],
                    value: isAssignment ? owner.right : null,
                  });
                }
              }
              memberWrites.sort(
                (left, right) => left.position - right.position,
              );

              const lastUnconditionalWrite = memberWrites.findLast(
                (write) => write.context === "unconditional" && !write.opaque,
              );
              const baseResolution =
                lastUnconditionalWrite === undefined
                  ? stableValue === null
                    ? { type: "opaque" as const }
                    : this.propertyResolution(
                        stableValue,
                        propertyName,
                        new Set([...visitedVariables, variable]),
                        readPosition,
                      )
                  : {
                      type: "found" as const,
                      value: lastUnconditionalWrite.value,
                    };
              const basePosition = lastUnconditionalWrite?.position ?? -1;
              if (
                memberWrites.some(
                  (write) => write.position > basePosition && write.opaque,
                )
              ) {
                return { type: "opaque" };
              }
              const conditionalWrites = memberWrites.filter(
                (write) =>
                  write.position > basePosition &&
                  write.context === "conditional" &&
                  !write.opaque,
              );
              if (conditionalWrites.length === 0) {
                return baseResolution;
              }
              if (baseResolution.type === "opaque") {
                return baseResolution;
              }
              return {
                type: "found",
                value: {
                  type: "LocalPossibleValues",
                  values: [
                    baseResolution.type === "found"
                      ? baseResolution.value
                      : LOCAL_ABSENT_VALUE,
                    ...conditionalWrites.map((write) => write.value),
                  ],
                } satisfies LocalPossibleValues,
              };
            }
            if (isMemberExpression(expression)) {
              const memberValue = this.memberValue(
                expression,
                visitedVariables,
              );
              return memberValue === null
                ? { type: "opaque" }
                : this.propertyResolution(
                    memberValue,
                    propertyName,
                    visitedVariables,
                    readPosition,
                  );
            }
            if (
              expression.type === "ArrayExpression" &&
              Array.isArray(expression.elements)
            ) {
              if (!/^(?:0|[1-9]\d*)$/.test(propertyName)) {
                return { type: "absent" };
              }
              const element = expression.elements.at(Number(propertyName));
              return isAstNode(element) && element.type !== "SpreadElement"
                ? { type: "found", value: element }
                : { type: "absent" };
            }
            if (!isObjectExpression(expression)) {
              return { type: "opaque" };
            }
            let objectResolution: LocalResolution = { type: "absent" };
            for (const property of expression.properties) {
              if (property.type === "SpreadElement") {
                const spreadResolution = this.propertyResolution(
                  property.argument,
                  propertyName,
                  new Set(visitedVariables),
                  property.range[1],
                );
                objectResolution = overlayResolution(
                  objectResolution,
                  spreadResolution,
                );
                continue;
              }
              const candidateName = staticPropertyName(
                property.key,
                property.computed,
              );
              if (candidateName === propertyName) {
                objectResolution = {
                  type: "found",
                  value: property.value,
                };
                continue;
              }
              if (property.computed === true && candidateName === null) {
                objectResolution = { type: "opaque" };
              }
            }
            return objectResolution;
          },
          stableValue(identifier, visitedVariables = new Set()) {
            const variable = resolveVariable(identifier);
            if (variable === null) {
              return null;
            }
            for (const definition of variable.defs) {
              if (
                definition.type === "FunctionName" &&
                isFunction(definition.node)
              ) {
                const reference = unwrapClassExpression(identifier);
                const wasReassigned =
                  isIdentifier(reference) &&
                  variable.references.some(
                    (candidate) =>
                      candidate.isWrite() &&
                      candidate.identifier.range[0] < reference.range[0],
                  );
                return wasReassigned ? null : definition.node;
              }
              if (
                definition.type === "Variable" &&
                isAstNode(definition.node) &&
                definition.node.type === "VariableDeclarator" &&
                isAstNode(definition.parent) &&
                definition.parent.type === "VariableDeclaration" &&
                definition.parent.kind === "const"
              ) {
                return this.patternValue(
                  definition.node.id,
                  definition.node.init,
                  variable,
                  visitedVariables,
                  definition.node.range[1],
                );
              }
            }
            return null;
          },
        };

        const localMemberValue = (
          value: unknown,
          visitedVariables = new Set<Variable>(),
        ): unknown => localValueResolver.memberValue(value, visitedVariables);

        const isClassNamePropertyName = (propertyName: string): boolean =>
          propertyName === "className" || propertyName.endsWith("ClassName");

        const localSpreadClassNameProperties = (
          value: unknown,
          readPosition: number,
          visitedVariables = new Set<Variable>(),
        ): Set<string> => {
          const propertyNames = new Set<string>(["className"]);
          const visit = (candidate: unknown): void => {
            if (isLocalObjectRestValue(candidate)) {
              const restProperties = localSpreadClassNameProperties(
                candidate.source,
                readPosition,
                new Set(visitedVariables),
              );
              for (const propertyName of restProperties) {
                if (!candidate.excludedProperties.has(propertyName)) {
                  propertyNames.add(propertyName);
                }
              }
              return;
            }
            if (isLocalPossibleValues(candidate)) {
              for (const possibleValue of candidate.values) {
                visit(possibleValue);
              }
              return;
            }
            const expression = unwrapClassExpression(candidate);
            if (expression === null) {
              return;
            }
            if (expression.type === "ConditionalExpression") {
              visit(expression.consequent);
              visit(expression.alternate);
              return;
            }
            if (isLogicalExpression(expression)) {
              for (const outcome of logicalOutcomes(expression)) {
                if (!outcome.propertyAbsent) {
                  visit(outcome.value);
                }
              }
              return;
            }
            if (isObjectExpression(expression)) {
              for (const property of expression.properties) {
                if (property.type === "SpreadElement") {
                  visit(property.argument);
                  continue;
                }
                const propertyName = staticPropertyName(
                  property.key,
                  property.computed,
                );
                if (
                  propertyName !== null &&
                  isClassNamePropertyName(propertyName)
                ) {
                  propertyNames.add(propertyName);
                }
              }
              return;
            }
            if (isMemberExpression(expression)) {
              const memberValue = localValueResolver.memberValue(
                expression,
                new Set(visitedVariables),
              );
              if (memberValue !== null) {
                visit(memberValue);
              }
              return;
            }
            if (!isIdentifier(expression)) {
              return;
            }
            const variable = resolveVariable(expression);
            if (variable === null || visitedVariables.has(variable)) {
              return;
            }
            visitedVariables.add(variable);
            for (const ownerVariable of stableObjectAliases(
              variable,
              readPosition,
            )) {
              for (const reference of ownerVariable.references) {
                if (reference.identifier.range[0] >= readPosition) {
                  continue;
                }
                const member = reference.identifier.parent;
                if (
                  !isMemberExpression(member) ||
                  member.object !== reference.identifier
                ) {
                  continue;
                }
                const propertyName = staticPropertyName(
                  member.property,
                  member.computed,
                );
                if (
                  propertyName !== null &&
                  isClassNamePropertyName(propertyName)
                ) {
                  propertyNames.add(propertyName);
                }
              }
            }
            const stableValue = localValueResolver.stableValue(
              expression,
              new Set(visitedVariables),
            );
            if (stableValue !== null) {
              visit(stableValue);
            }
          };
          visit(value);
          return propertyNames;
        };

        const isCanonicalCnComposition = (
          value: unknown,
          visitedVariables = new Set<Variable>(),
        ): boolean => {
          if (isLocalAbsentValue(value) || isLocalOpaqueValue(value)) {
            return false;
          }
          if (isLocalPossibleValues(value)) {
            return value.values.every((possibleValue) =>
              isCanonicalCnComposition(
                possibleValue,
                new Set(visitedVariables),
              ),
            );
          }
          const node = unwrapClassExpression(value);
          if (node === null) {
            return false;
          }
          if (node.type === "CallExpression") {
            return isCanonicalCn(node.callee);
          }
          if (isMemberExpression(node)) {
            const memberVariables = new Set(visitedVariables);
            const localValue = localMemberValue(node, memberVariables);
            return (
              localValue !== null &&
              isCanonicalCnComposition(localValue, memberVariables)
            );
          }
          if (!isIdentifier(node)) {
            return false;
          }
          const variable = resolveVariable(node);
          if (variable === null || visitedVariables.has(variable)) {
            return false;
          }
          const stableValue = localValueResolver.stableValue(
            node,
            visitedVariables,
          );
          if (stableValue === null) {
            return false;
          }
          visitedVariables.add(variable);
          return isCanonicalCnComposition(stableValue, visitedVariables);
        };

        const staticClassValue = (
          value: unknown,
          visitedVariables = new Set<Variable>(),
        ): string | null => {
          if (isLocalAbsentValue(value) || isLocalOpaqueValue(value)) {
            return null;
          }
          if (isLocalPossibleValues(value)) {
            const staticValues = value.values.map((possibleValue) =>
              staticClassValue(possibleValue, new Set(visitedVariables)),
            );
            return staticValues.every(
              (staticValue): staticValue is string => staticValue !== null,
            ) && new Set(staticValues).size === 1
              ? (staticValues.at(0) ?? null)
              : null;
          }
          const node = unwrapClassExpression(value);
          if (isStringLiteral(node)) {
            return node.value;
          }
          if (isTemplateLiteral(node) && node.expressions.length === 0) {
            const quasi = node.quasis.at(0);
            return quasi?.value.cooked ?? quasi?.value.raw ?? "";
          }
          if (isMemberExpression(node)) {
            const memberVariables = new Set(visitedVariables);
            const localValue = localMemberValue(node, memberVariables);
            return localValue === null
              ? null
              : staticClassValue(localValue, memberVariables);
          }
          if (!isIdentifier(node)) {
            return null;
          }
          const variable = resolveVariable(node);
          if (variable === null || visitedVariables.has(variable)) {
            return null;
          }
          const initializer = localValueResolver.stableValue(
            node,
            visitedVariables,
          );
          if (initializer === null) {
            return null;
          }
          visitedVariables.add(variable);
          return staticClassValue(initializer, visitedVariables);
        };

        const writeContextInside = (
          identifier: unknown,
          callback: ESTree.ArrowFunctionExpression | ESTree.Function,
        ): "conditional" | "unconditional" | null => {
          let current = identifier;
          let conditional = false;
          while (isAstNode(current)) {
            const parent = current.parent;
            if (parent === callback.body) {
              return conditional ? "conditional" : "unconditional";
            }
            if (!isAstNode(parent)) {
              return null;
            }
            if (
              (parent.type === "IfStatement" && current !== parent.test) ||
              (parent.type === "ConditionalExpression" &&
                current !== parent.test) ||
              parent.type === "SwitchCase" ||
              (parent.type === "LogicalExpression" &&
                current === parent.right) ||
              (parent.type === "CatchClause" && current === parent.body) ||
              parent.type === "ForStatement" ||
              parent.type === "ForInStatement" ||
              parent.type === "ForOfStatement" ||
              parent.type === "WhileStatement" ||
              parent.type === "DoWhileStatement"
            ) {
              conditional = true;
            }
            if (
              parent.type === "ArrowFunctionExpression" ||
              parent.type === "FunctionExpression" ||
              parent.type === "FunctionDeclaration"
            ) {
              return null;
            }
            current = parent;
          }
          return null;
        };

        const writtenValues = (
          value: unknown,
          callback: ESTree.ArrowFunctionExpression | ESTree.Function,
        ): unknown[] | null => {
          const node = unwrapClassExpression(value);
          if (!isIdentifier(node)) {
            return null;
          }
          const variable = resolveVariable(node);
          if (variable === null) {
            return null;
          }
          const writes = variable.references.filter(
            (reference) =>
              reference.init !== true &&
              reference.isWrite() &&
              reference.identifier.range[0] < node.range[0] &&
              writeContextInside(reference.identifier, callback) !== null,
          );
          if (writes.length === 0) {
            return null;
          }
          const lastUnconditionalWrite = writes.findLast(
            (reference) =>
              writeContextInside(reference.identifier, callback) ===
              "unconditional",
          );
          const baseValue =
            lastUnconditionalWrite?.writeExpr ??
            getVariableInitializer(variable);
          const basePosition =
            lastUnconditionalWrite?.identifier.range[0] ?? -1;
          return [
            baseValue,
            ...writes
              .filter(
                (reference) =>
                  reference.identifier.range[0] > basePosition &&
                  writeContextInside(reference.identifier, callback) ===
                    "conditional",
              )
              .map((reference) => reference.writeExpr),
          ];
        };

        const writeContextInVariableScope = (
          identifier: unknown,
          variable: Variable,
        ): "conditional" | "unconditional" | null => {
          let current = identifier;
          let conditional = false;
          while (isAstNode(current)) {
            const parent = current.parent;
            if (
              Object.is(current, variable.scope.block) ||
              Object.is(parent, variable.scope.block)
            ) {
              return conditional ? "conditional" : "unconditional";
            }
            if (!isAstNode(parent)) {
              return null;
            }
            if (
              (parent.type === "IfStatement" && current !== parent.test) ||
              (parent.type === "ConditionalExpression" &&
                current !== parent.test) ||
              parent.type === "SwitchCase" ||
              (parent.type === "LogicalExpression" &&
                current === parent.right) ||
              (parent.type === "CatchClause" && current === parent.body) ||
              parent.type === "ForStatement" ||
              parent.type === "ForInStatement" ||
              parent.type === "ForOfStatement" ||
              parent.type === "WhileStatement" ||
              parent.type === "DoWhileStatement"
            ) {
              conditional = true;
            }
            if (
              parent.type === "ArrowFunctionExpression" ||
              parent.type === "FunctionExpression" ||
              parent.type === "FunctionDeclaration"
            ) {
              return null;
            }
            current = parent;
          }
          return null;
        };

        const mutableLocalValues = (
          identifier: unknown,
          variable: Variable,
        ): unknown[] | null => {
          const node = unwrapClassExpression(identifier);
          if (!isIdentifier(node)) {
            return null;
          }
          const definition = variable.defs.find(
            (candidate) =>
              candidate.type === "Variable" &&
              isAstNode(candidate.node) &&
              candidate.node.type === "VariableDeclarator" &&
              isAstNode(candidate.parent) &&
              candidate.parent.type === "VariableDeclaration" &&
              candidate.parent.kind !== "const",
          );
          if (
            definition === undefined ||
            !isAstNode(definition.node) ||
            definition.node.type !== "VariableDeclarator"
          ) {
            return null;
          }
          const writes = variable.references.filter(
            (reference) =>
              reference.init !== true &&
              reference.isWrite() &&
              reference.identifier.range[0] < node.range[0] &&
              writeContextInVariableScope(reference.identifier, variable) !==
                null,
          );
          const lastUnconditionalWrite = writes.findLast(
            (reference) =>
              writeContextInVariableScope(reference.identifier, variable) ===
              "unconditional",
          );
          const baseValue =
            lastUnconditionalWrite?.writeExpr ?? definition.node.init;
          const basePosition =
            lastUnconditionalWrite?.identifier.range[0] ?? -1;
          return [
            baseValue,
            ...writes
              .filter(
                (reference) =>
                  reference.identifier.range[0] > basePosition &&
                  writeContextInVariableScope(
                    reference.identifier,
                    variable,
                  ) === "conditional",
              )
              .map((reference) => reference.writeExpr),
          ];
        };

        const canCompleteNormally = (statement: unknown): boolean => {
          if (!isAstNode(statement)) {
            return true;
          }
          if (
            statement.type === "ReturnStatement" ||
            statement.type === "ThrowStatement" ||
            statement.type === "BreakStatement" ||
            statement.type === "ContinueStatement"
          ) {
            return false;
          }
          if (
            statement.type === "BlockStatement" &&
            Array.isArray(statement.body)
          ) {
            let reachable = true;
            for (const child of statement.body) {
              if (!reachable) {
                break;
              }
              reachable = canCompleteNormally(child);
            }
            return reachable;
          }
          if (statement.type === "IfStatement") {
            return (
              statement.alternate == null ||
              canCompleteNormally(statement.consequent) ||
              canCompleteNormally(statement.alternate)
            );
          }
          if (
            statement.type === "SwitchStatement" &&
            Array.isArray(statement.cases)
          ) {
            const cases = statement.cases.filter(isAstNode);
            if (!cases.some((switchCase) => switchCase.test == null)) {
              return true;
            }
            const caseCanComplete = (startIndex: number): boolean => {
              for (let index = startIndex; index < cases.length; index++) {
                const switchCase = cases.at(index);
                if (
                  switchCase === undefined ||
                  !Array.isArray(switchCase.consequent)
                ) {
                  return true;
                }
                for (const consequent of switchCase.consequent) {
                  if (
                    isAstNode(consequent) &&
                    consequent.type === "BreakStatement"
                  ) {
                    return true;
                  }
                  if (!canCompleteNormally(consequent)) {
                    return false;
                  }
                }
              }
              return true;
            };
            return cases.some((_, index) => caseCanComplete(index));
          }
          if (statement.type === "TryStatement") {
            if (
              statement.finalizer != null &&
              !canCompleteNormally(statement.finalizer)
            ) {
              return false;
            }
            return (
              canCompleteNormally(statement.block) ||
              (isAstNode(statement.handler) &&
                canCompleteNormally(statement.handler.body))
            );
          }
          return true;
        };

        const isAllowedClassValue = (
          value: unknown,
          visitedVariables = new Set<Variable>(),
        ): boolean => {
          if (isLocalAbsentValue(value) || isLocalOpaqueValue(value)) {
            return true;
          }
          if (isLocalPossibleValues(value)) {
            const presentValues = value.values.filter(
              (possibleValue) => !isLocalAbsentValue(possibleValue),
            );
            if (
              presentValues.length > 0 &&
              presentValues.every((possibleValue) =>
                isCanonicalCnComposition(possibleValue),
              )
            ) {
              return true;
            }
            const valueKinds = new Set<string>();
            for (const possibleValue of value.values) {
              const staticValue = staticClassValue(possibleValue);
              if (staticValue !== null) {
                valueKinds.add(`static:${staticValue}`);
                continue;
              }
              if (
                !isAllowedClassValue(possibleValue, new Set(visitedVariables))
              ) {
                return false;
              }
              const possibleNode = unwrapClassExpression(possibleValue);
              valueKinds.add(
                isAstNode(possibleNode)
                  ? `dynamic:${context.sourceCode.getText(possibleNode)}`
                  : "dynamic:unknown",
              );
            }
            return valueKinds.size <= 1;
          }
          const node = unwrapClassExpression(value);
          if (node === null || isStaticLiteral(node)) {
            return true;
          }
          if (isIdentifier(node)) {
            const variable = resolveVariable(node);
            if (variable === null) {
              return true;
            }
            if (visitedVariables.has(variable)) {
              return true;
            }
            const stableValue = localValueResolver.stableValue(
              node,
              visitedVariables,
            );
            if (stableValue !== null) {
              visitedVariables.add(variable);
              return isAllowedClassValue(stableValue, visitedVariables);
            }
            const mutableValues = mutableLocalValues(node, variable);
            if (mutableValues === null) {
              return true;
            }
            if (
              mutableValues.every((mutableValue) =>
                isCanonicalCnComposition(mutableValue),
              )
            ) {
              return true;
            }
            const valueKinds = new Set<string>();
            for (const mutableValue of mutableValues) {
              const staticValue = staticClassValue(mutableValue);
              if (staticValue !== null) {
                valueKinds.add(`static:${staticValue}`);
                continue;
              }
              const nextVisited = new Set(visitedVariables);
              nextVisited.add(variable);
              if (!isAllowedClassValue(mutableValue, nextVisited)) {
                return false;
              }
              const mutableNode = unwrapClassExpression(mutableValue);
              valueKinds.add(
                isAstNode(mutableNode)
                  ? `dynamic:${context.sourceCode.getText(mutableNode)}`
                  : "dynamic:unknown",
              );
            }
            return valueKinds.size <= 1;
          }
          if (isMemberExpression(node)) {
            const memberVariables = new Set(visitedVariables);
            const localValue = localMemberValue(node, memberVariables);
            return (
              localValue === null ||
              isAllowedClassValue(localValue, memberVariables)
            );
          }
          if (isTemplateLiteral(node)) {
            return node.expressions.length === 0;
          }
          if (node.type === "CallExpression") {
            return isCanonicalCn(node.callee);
          }
          if (isFunction(node)) {
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

            const possibleValues = returnValues.flatMap((returnValue) => {
              const writes = writtenValues(returnValue, node);
              return writes ?? [returnValue];
            });
            if (canCompleteNormally(node.body)) {
              possibleValues.push(LOCAL_ABSENT_VALUE);
            }
            const presentValues = possibleValues.filter(
              (returnValue) => !isLocalAbsentValue(returnValue),
            );
            const allCanonical =
              presentValues.length > 0 &&
              presentValues.every((returnValue) =>
                isCanonicalCnComposition(returnValue),
              );
            if (allCanonical) {
              return true;
            }

            const returnKinds = new Set<string>();
            for (const returnValue of possibleValues) {
              const staticValue = staticClassValue(returnValue);
              if (staticValue !== null) {
                returnKinds.add(`static:${staticValue}`);
                continue;
              }
              if (
                !isAllowedClassValue(returnValue, new Set(visitedVariables))
              ) {
                return false;
              }
              const returned = unwrapClassExpression(returnValue);
              returnKinds.add(
                isAstNode(returned)
                  ? `dynamic:${context.sourceCode.getText(returned)}`
                  : "dynamic:unknown",
              );
            }
            return returnKinds.size <= 1;
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

        const reportLocalSpreadClassNames = (
          spread: unknown,
          owner: unknown,
        ) => {
          const readPosition = isAstNode(owner)
            ? owner.range[0]
            : Number.POSITIVE_INFINITY;
          for (const propertyName of localSpreadClassNameProperties(
            spread,
            readPosition,
          )) {
            const className = localValueResolver.propertyValue(
              spread,
              propertyName,
              new Set(),
              readPosition,
            );
            if (className !== null && !isAllowedClassValue(className)) {
              report(owner);
              return;
            }
          }
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
          JSXSpreadAttribute(node) {
            const argument = unwrapClassExpression(node.argument);
            if (!isIdentifier(argument)) {
              reportLocalSpreadClassNames(argument, node);
              return;
            }
            const variable = resolveVariable(argument);
            if (variable === null) {
              return;
            }
            const stableValue = localValueResolver.stableValue(argument);
            if (stableValue !== null) {
              reportLocalSpreadClassNames(argument, node);
              return;
            }
            const mutableValues = mutableLocalValues(argument, variable);
            if (mutableValues === null) {
              return;
            }
            for (const mutableValue of mutableValues) {
              reportLocalSpreadClassNames(mutableValue, node);
            }
          },
        };
      },
    },
  },
});
