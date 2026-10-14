import ts from "typescript";

import { literalMemberName, literalPropertyName } from "./test-gate-members";

const UNKNOWN = Symbol("unknown service condition");
// The runner requires a nonempty value, but does not pin its contents.
const PRESENT = Symbol("required service environment");
type ConditionValue =
  | string
  | boolean
  | number
  | undefined
  | typeof UNKNOWN
  | typeof PRESENT;

const truth = (value: ConditionValue) =>
  value === UNKNOWN ? UNKNOWN : Boolean(value);

const environmentName = (node: ts.Expression): string | undefined => {
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return undefined;
  }
  const environment = node.expression;
  if (
    !ts.isPropertyAccessExpression(environment) &&
    !ts.isElementAccessExpression(environment)
  ) {
    return undefined;
  }
  const process = environment.expression;
  return ts.isIdentifier(process) &&
    process.text === "process" &&
    literalMemberName(environment) === "env"
    ? literalMemberName(node)
    : undefined;
};

export const requiredServiceEnvironment = (
  source: ts.SourceFile,
): ReadonlySet<string> => {
  const required = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "runGatedTests"
    ) {
      const options = node.arguments.at(0);
      if (options !== undefined && ts.isObjectLiteralExpression(options)) {
        for (const property of options.properties) {
          if (
            !ts.isPropertyAssignment(property) ||
            literalPropertyName(property.name) !== "requiredEnv" ||
            !ts.isArrayLiteralExpression(property.initializer)
          ) {
            continue;
          }
          for (const element of property.initializer.elements) {
            if (ts.isStringLiteral(element)) {
              required.add(element.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return required;
};

type BinaryConditionOptions = {
  readonly left: ConditionValue;
  readonly right: ConditionValue;
  readonly operator: ts.SyntaxKind;
};
const binaryConditionValue = ({
  left,
  right,
  operator,
}: BinaryConditionOptions): ConditionValue => {
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
    return truth(left) === true ? right : left;
  }
  if (operator === ts.SyntaxKind.BarBarToken) {
    return truth(left) === false ? right : left;
  }
  if (left === UNKNOWN || right === UNKNOWN) {
    return UNKNOWN;
  }
  const strictEqual = operator === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const strictUnequal = operator === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!strictEqual && !strictUnequal) {
    return UNKNOWN;
  }
  if (
    (left === PRESENT && right !== undefined && right !== "") ||
    (right === PRESENT && left !== undefined && left !== "")
  ) {
    return UNKNOWN;
  }
  return strictEqual ? left === right : left !== right;
};

type ServiceConditionOptions = {
  readonly source: ts.SourceFile;
  readonly gate: string;
  readonly requiredEnvironment: ReadonlySet<string>;
};

export const serviceConditionEvaluator = ({
  source,
  gate,
  requiredEnvironment,
}: ServiceConditionOptions) => {
  const bindings = new Map<string, ts.Expression | undefined>();
  const discover = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const constant =
        ts.isVariableDeclarationList(node.parent) &&
        node.parent.getFirstToken()?.kind === ts.SyntaxKind.ConstKeyword;
      bindings.set(
        node.name.text,
        !constant || bindings.has(node.name.text)
          ? undefined
          : node.initializer,
      );
    }
    ts.forEachChild(node, discover);
  };
  discover(source);

  const evaluating = new Set<string>();
  const valueOf = (node: ts.Expression): ConditionValue => {
    const environment = environmentName(node);
    if (environment === gate) {
      return "true";
    }
    if (environment !== undefined) {
      return requiredEnvironment.has(environment) ? PRESENT : UNKNOWN;
    }
    if (ts.isParenthesizedExpression(node)) {
      return valueOf(node.expression);
    }
    if (ts.isStringLiteral(node)) {
      return node.text;
    }
    if (ts.isNumericLiteral(node)) {
      return Number(node.text);
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) {
      return true;
    }
    if (node.kind === ts.SyntaxKind.FalseKeyword) {
      return false;
    }
    if (ts.isIdentifier(node)) {
      if (node.text === "undefined") {
        return undefined;
      }
      const initializer = bindings.get(node.text);
      if (initializer === undefined || evaluating.has(node.text)) {
        return UNKNOWN;
      }
      evaluating.add(node.text);
      const value = valueOf(initializer);
      evaluating.delete(node.text);
      return value;
    }
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken
    ) {
      const value = truth(valueOf(node.operand));
      return value === UNKNOWN ? UNKNOWN : !value;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Boolean"
    ) {
      const argument = node.arguments.at(0);
      return argument === undefined ? false : truth(valueOf(argument));
    }
    if (!ts.isBinaryExpression(node)) {
      return UNKNOWN;
    }
    const left = valueOf(node.left);
    const right = valueOf(node.right);
    return binaryConditionValue({
      left,
      right,
      operator: node.operatorToken.kind,
    });
  };

  return {
    evaluate: (expression: ts.Expression) => truth(valueOf(expression)),
    bindings,
  };
};

export const registrationRunsWithService = (
  node: ts.CallExpression,
  { evaluate, bindings }: ReturnType<typeof serviceConditionEvaluator>,
): boolean => {
  const resolving = new Set<string>();
  const helpersActive = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression) && bindings.has(expression.text)) {
      const initializer = bindings.get(expression.text);
      if (initializer === undefined || resolving.has(expression.text)) {
        return false;
      }
      resolving.add(expression.text);
      const active = helpersActive(initializer);
      resolving.delete(expression.text);
      return active;
    }
    if (ts.isConditionalExpression(expression)) {
      const condition = evaluate(expression.condition);
      if (condition === true) {
        return helpersActive(expression.whenTrue);
      }
      if (condition === false) {
        return helpersActive(expression.whenFalse);
      }
      return false;
    }
    if (
      ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression)
    ) {
      const member = literalMemberName(expression);
      if (member === undefined) {
        return false;
      }
      if (["skip", "todo", "fixme"].includes(member)) {
        return false;
      }
      return helpersActive(expression.expression);
    }
    if (!ts.isCallExpression(expression)) {
      return true;
    }
    const helper = expression.expression;
    if (
      ts.isPropertyAccessExpression(helper) ||
      ts.isElementAccessExpression(helper)
    ) {
      const member = literalMemberName(helper);
      if (member === undefined) {
        return false;
      }
      if (["skipIf", "todoIf", "if"].includes(member)) {
        const condition = expression.arguments.at(0);
        if (
          condition === undefined ||
          evaluate(condition) !== (member === "if")
        ) {
          return false;
        }
      }
    }
    return helpersActive(helper);
  };
  if (!helpersActive(node.expression)) {
    return false;
  }
  let child: ts.Node = node;
  let ancestor = node.parent;
  while (!ts.isSourceFile(ancestor) && !ts.isFunctionLike(ancestor)) {
    if (
      ts.isIfStatement(ancestor) &&
      evaluate(ancestor.expression) !== (child === ancestor.thenStatement)
    ) {
      return false;
    }
    if (
      ts.isConditionalExpression(ancestor) &&
      evaluate(ancestor.condition) !== (child === ancestor.whenTrue)
    ) {
      return false;
    }
    // A right operand runs only when the left one lets it: `&&` needs a true
    // left side, `||` a false one; `??` depends on nullishness and fails closed.
    if (ts.isBinaryExpression(ancestor) && child === ancestor.right) {
      const operator = ancestor.operatorToken.kind;
      if (
        (operator === ts.SyntaxKind.AmpersandAmpersandToken &&
          evaluate(ancestor.left) !== true) ||
        (operator === ts.SyntaxKind.BarBarToken &&
          evaluate(ancestor.left) !== false) ||
        operator === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return false;
      }
    }
    child = ancestor;
    ancestor = ancestor.parent;
  }
  return true;
};
