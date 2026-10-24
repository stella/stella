import ts from "typescript6";

import {
  literalMemberName,
  literalPropertyName,
  unwrapTransparentExpression,
} from "./test-gate-members";

const UNKNOWN = Symbol("unknown service condition");
// The runner requires a nonempty value, but does not pin its contents.
const PRESENT = Symbol("required service environment");
type ConditionValue =
  string | boolean | number | undefined | typeof UNKNOWN | typeof PRESENT;

const truth = (value: ConditionValue) =>
  value === UNKNOWN ? UNKNOWN : Boolean(value);

type ServiceBinding =
  | { readonly type: "constant"; readonly initializer: ts.Expression }
  | { readonly type: "import" }
  | { readonly type: "shadow" };

type DeclareServiceBindingOptions = {
  readonly scope: ts.Node;
  readonly name: ts.BindingName;
  readonly binding: ServiceBinding;
};

const serviceBindings = (source: ts.SourceFile) => {
  const scopes = new Map<ts.Node, Map<string, ServiceBinding>>();
  const scopeFor = (input: ts.Node, functionScoped = false): ts.Node => {
    let node = input;
    while (
      !ts.isSourceFile(node) &&
      !ts.isFunctionLike(node) &&
      !ts.isModuleBlock(node) &&
      !ts.isClassStaticBlockDeclaration(node)
    ) {
      if (
        !functionScoped &&
        (ts.isBlock(node) ||
          ts.isCaseBlock(node) ||
          ts.isCatchClause(node) ||
          ts.isForStatement(node) ||
          ts.isForOfStatement(node) ||
          ts.isForInStatement(node) ||
          ts.isClassExpression(node))
      ) {
        return node;
      }
      node = node.parent;
    }
    return node;
  };
  const declare = ({
    scope,
    name,
    binding,
  }: DeclareServiceBindingOptions): void => {
    if (!ts.isIdentifier(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) {
          declare({ scope, name: element.name, binding: { type: "shadow" } });
        }
      }
      return;
    }
    const entries = scopes.get(scope) ?? new Map<string, ServiceBinding>();
    entries.set(
      name.text,
      entries.has(name.text) ? { type: "shadow" } : binding,
    );
    scopes.set(scope, entries);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const list = node.parent;
      const keyword = ts.isVariableDeclarationList(list)
        ? list.getFirstToken(source)?.kind
        : undefined;
      declare({
        scope: scopeFor(list, keyword === ts.SyntaxKind.VarKeyword),
        name: node.name,
        binding:
          keyword === ts.SyntaxKind.ConstKeyword &&
          node.initializer !== undefined
            ? { type: "constant", initializer: node.initializer }
            : { type: "shadow" },
      });
    }
    if (ts.isParameter(node)) {
      declare({
        scope: node.parent,
        name: node.name,
        binding: { type: "shadow" },
      });
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name !== undefined
    ) {
      declare({
        scope: scopeFor(node.parent),
        name: node.name,
        binding: { type: "shadow" },
      });
    }
    if (
      (ts.isFunctionExpression(node) || ts.isClassExpression(node)) &&
      node.name !== undefined
    ) {
      declare({ scope: node, name: node.name, binding: { type: "shadow" } });
    }
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword
    ) {
      const clause = node.importClause;
      if (clause?.name !== undefined) {
        declare({
          scope: source,
          name: clause.name,
          binding: { type: "import" },
        });
      }
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        declare({
          scope: source,
          name: bindings.name,
          binding: { type: "import" },
        });
      } else if (bindings !== undefined) {
        for (const binding of bindings.elements) {
          if (!binding.isTypeOnly) {
            declare({
              scope: source,
              name: binding.name,
              binding: { type: "import" },
            });
          }
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
      declare({
        scope: scopeFor(node.parent),
        name: node.name,
        binding: { type: "import" },
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return (identifier: ts.Identifier): ServiceBinding | undefined => {
    let node: ts.Node = identifier;
    while (true) {
      const binding = scopes.get(node)?.get(identifier.text);
      if (binding !== undefined || ts.isSourceFile(node)) {
        return binding;
      }
      node = node.parent;
    }
  };
};

type ServiceBindingResolver = ReturnType<typeof serviceBindings>;

const globalReferenceName = (
  input: ts.Expression,
  bindingFor: ServiceBindingResolver,
): string | undefined => {
  const node = unwrapTransparentExpression(input);
  if (ts.isIdentifier(node)) {
    return bindingFor(node) === undefined ? node.text : undefined;
  }
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return undefined;
  }
  const owner = unwrapTransparentExpression(node.expression);
  return ts.isIdentifier(owner) &&
    owner.text === "globalThis" &&
    bindingFor(owner) === undefined
    ? literalMemberName(node)
    : undefined;
};

const processEnvironmentMember = (
  input: ts.Expression,
  bindingFor: ServiceBindingResolver,
): "environment" | { readonly name: string | undefined } | undefined => {
  const node = unwrapTransparentExpression(input);
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return undefined;
  }
  if (
    globalReferenceName(node.expression, bindingFor) === "process" &&
    literalMemberName(node) === "env"
  ) {
    return "environment";
  }
  const owner = unwrapTransparentExpression(node.expression);
  return (ts.isPropertyAccessExpression(owner) ||
    ts.isElementAccessExpression(owner)) &&
    globalReferenceName(owner.expression, bindingFor) === "process" &&
    literalMemberName(owner) === "env"
    ? { name: literalMemberName(node) }
    : undefined;
};

const assignedGlobalNames = (
  source: ts.SourceFile,
  bindingFor: ServiceBindingResolver,
): ReadonlySet<string> => {
  const names = new Set<string>();
  const assigned = (input: ts.Expression): void => {
    const node = unwrapTransparentExpression(input);
    const global = globalReferenceName(node, bindingFor);
    if (global !== undefined) {
      names.add(global);
      return;
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      globalReferenceName(node.expression, bindingFor) === "globalThis"
    ) {
      names.add("globalThis");
      return;
    }
    const environment = processEnvironmentMember(node, bindingFor);
    if (environment !== undefined) {
      names.add(
        environment === "environment" || environment.name === undefined
          ? "process.env"
          : `process.env.${environment.name}`,
      );
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (!ts.isOmittedExpression(element)) {
          assigned(ts.isSpreadElement(element) ? element.expression : element);
        }
      }
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          assigned(property.name);
        } else if (ts.isPropertyAssignment(property)) {
          assigned(property.initializer);
        } else if (ts.isSpreadAssignment(property)) {
          assigned(property.expression);
        }
      }
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      assigned(node.left);
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      assigned(node.left);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      assigned(node.operand);
    }
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      assigned(node.initializer);
    }
    if (ts.isDeleteExpression(node)) {
      assigned(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
};

type GlobalServiceOwner = (identifier: ts.Identifier) => boolean;

type EnvironmentNameOptions = {
  readonly input: ts.Expression;
  readonly isGlobal: GlobalServiceOwner;
  readonly assignedGlobals: ReadonlySet<string>;
};

const environmentName = ({
  input,
  isGlobal,
  assignedGlobals,
}: EnvironmentNameOptions): string | undefined => {
  const node = unwrapTransparentExpression(input);
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return undefined;
  }
  const environment = unwrapTransparentExpression(node.expression);
  if (
    !ts.isPropertyAccessExpression(environment) &&
    !ts.isElementAccessExpression(environment)
  ) {
    return undefined;
  }
  const process = unwrapTransparentExpression(environment.expression);
  const name = literalMemberName(node);
  return name !== undefined &&
    ts.isIdentifier(process) &&
    process.text === "process" &&
    isGlobal(process) &&
    literalMemberName(environment) === "env" &&
    !assignedGlobals.has("process.env") &&
    !assignedGlobals.has(`process.env.${name}`)
    ? name
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
  const bindingFor = serviceBindings(source);
  const assignedGlobals = assignedGlobalNames(source, bindingFor);
  const isGlobal: GlobalServiceOwner = (identifier) =>
    bindingFor(identifier) === undefined &&
    !assignedGlobals.has("globalThis") &&
    !assignedGlobals.has(identifier.text);

  const evaluating = new Set<ts.Expression>();
  const valueOf = (input: ts.Expression): ConditionValue => {
    const node = unwrapTransparentExpression(input);
    const environment = environmentName({
      input: node,
      isGlobal,
      assignedGlobals,
    });
    if (environment === gate) {
      return "true";
    }
    if (environment !== undefined) {
      return requiredEnvironment.has(environment) ? PRESENT : UNKNOWN;
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
      const binding = bindingFor(node);
      if (node.text === "undefined" && isGlobal(node)) {
        return undefined;
      }
      if (binding?.type !== "constant" || evaluating.has(binding.initializer)) {
        return UNKNOWN;
      }
      evaluating.add(binding.initializer);
      const value = valueOf(binding.initializer);
      evaluating.delete(binding.initializer);
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
      node.expression.text === "Boolean" &&
      isGlobal(node.expression)
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
    bindingFor,
  };
};

export const registrationRunsWithService = (
  node: ts.CallExpression,
  { evaluate, bindingFor }: ReturnType<typeof serviceConditionEvaluator>,
): boolean => {
  const resolving = new Set<ts.Expression>();
  const helpersActive = (input: ts.Expression): boolean => {
    const expression = unwrapTransparentExpression(input);
    const binding = ts.isIdentifier(expression)
      ? bindingFor(expression)
      : undefined;
    if (binding?.type === "shadow") {
      return false;
    }
    if (binding?.type === "constant") {
      const { initializer } = binding;
      if (resolving.has(initializer)) {
        return false;
      }
      resolving.add(initializer);
      const active = helpersActive(initializer);
      resolving.delete(initializer);
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
    const helper = unwrapTransparentExpression(expression.expression);
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
