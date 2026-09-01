import { panic } from "better-result";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";

import { withoutTsgoOnlyOptionDiagnostics } from "./tsgo-compiler-options";

const BETTER_RESULT_PACKAGE = `${path.sep}node_modules${path.sep}better-result${path.sep}`;
const RESULT_VARIANT_STATUS = new Map([
  ["Err", "error"],
  ["Ok", "ok"],
]);
const PRODUCT_SOURCE_PATTERN =
  /^(?:(?:apps|packages)\/[^/]+\/(?:src|scripts)\/.*|scripts\/.*)\.tsx?$/u;
const TEST_FILE_PATTERN =
  /(?:\.test\.|\.spec\.|\/tests\/|\/__tests__\/|\/e2e\/)/u;
const GENERATED_OR_EXTERNAL_PATTERN =
  /(?:\.d\.ts$|\.gen\.tsx?$|\/generated\/|\/node_modules\/|routeTree\.gen)/u;
const RESULT_IMPORT_PATTERN =
  /import\s+(?:type\s+)?\{[^}]*\bResult\b[^}]*\}\s*from\s*["']better-result["']/su;

export type ResultConsumptionDiagnostic = {
  readonly column: number;
  readonly file: string;
  readonly line: number;
  readonly message: string;
  readonly rule: "result-unwrap-requires-message" | "unused-result";
};

type ScanProgramOptions = {
  readonly program: ts.Program;
  readonly repositoryRoot: string;
  readonly sourceFiles?: ReadonlySet<string>;
};

export const scanResultConsumption = ({
  program,
  repositoryRoot,
  sourceFiles,
}: ScanProgramOptions): ResultConsumptionDiagnostic[] => {
  const checker = program.getTypeChecker();
  const diagnostics: ResultConsumptionDiagnostic[] = [];
  const reportedDiscardedExpressions = new Set<ts.Expression>();

  for (const sourceFile of program.getSourceFiles()) {
    if (
      !isProductSourceFile(sourceFile, repositoryRoot) ||
      (sourceFiles !== undefined && !sourceFiles.has(sourceFile.fileName))
    ) {
      continue;
    }

    const reportDiscardedResult = (expression: ts.Expression): void => {
      if (reportedDiscardedExpressions.has(expression)) {
        return;
      }
      reportedDiscardedExpressions.add(expression);
      diagnostics.push(
        createDiagnostic({
          node: expression,
          repositoryRoot,
          rule: "unused-result",
          message:
            "This better-result Result is discarded. Return, assign, yield, or explicitly consume it.",
        }),
      );
    };

    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node)) {
        inspectDiscardedExpression({
          checker,
          expression: node.expression,
          report: reportDiscardedResult,
        });
      }

      if (isCommaExpression(node)) {
        // A comma expression always discards its non-final operand, even when
        // the surrounding expression is assigned, returned, or passed on.
        inspectDiscardedExpression({
          checker,
          expression: node.left,
          report: reportDiscardedResult,
        });
      }

      if (
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)) &&
        !isConsumedInlineContainerMethod(node, checker)
      ) {
        // Constructing an ephemeral container evaluates every entry, even
        // when the selected value is retained by an assignment or return.
        inspectDiscardedContainerSelection({
          checker,
          expression: node,
          report: reportDiscardedResult,
        });
      }

      if (ts.isCallExpression(node)) {
        const atSelection = inlineArrayAtSelection(node);
        if (atSelection !== null) {
          inspectDiscardedContainerSelection({
            checker,
            expression: atSelection.callee,
            report: reportDiscardedResult,
            selectionOverride: {
              kind: "index",
              value: atSelection.index,
            },
          });
        }
      }

      if (ts.isCallExpression(node) && isUnwrapWithoutMessage(node, checker)) {
        diagnostics.push(
          createDiagnostic({
            node,
            repositoryRoot,
            rule: "result-unwrap-requires-message",
            message:
              "Unwrapping a Result requires a non-empty literal invariant message.",
          }),
        );
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return diagnostics;
};

const isAssignmentExpression = (expression: ts.Expression): boolean =>
  ts.isBinaryExpression(expression) &&
  expression.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
  expression.operatorToken.kind <= ts.SyntaxKind.LastAssignment;

const isProductSourcePath = (file: string): boolean =>
  PRODUCT_SOURCE_PATTERN.test(file) &&
  !TEST_FILE_PATTERN.test(file) &&
  !GENERATED_OR_EXTERNAL_PATTERN.test(file);

const isProductSourceFile = (
  sourceFile: ts.SourceFile,
  repositoryRoot: string,
): boolean => {
  if (sourceFile.isDeclarationFile) {
    return false;
  }

  const relative = path.relative(repositoryRoot, sourceFile.fileName);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }

  return isProductSourcePath(relative.replaceAll(path.sep, "/"));
};

const isCommaExpression = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) &&
  node.operatorToken.kind === ts.SyntaxKind.CommaToken;

const isLogicalExpression = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) &&
  (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken);

const COLLECTION_CALLBACK_METHODS = new Set([
  "filter",
  "flatMap",
  "forEach",
  "map",
]);

const unwrapDiscardedExpression = (
  expression: ts.Expression,
): ts.Expression => {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrapDiscardedExpression(expression.expression);
  }

  if (ts.isVoidExpression(expression)) {
    return unwrapDiscardedExpression(expression.expression);
  }

  return expression;
};

type InspectDiscardedExpressionOptions = {
  readonly checker: ts.TypeChecker;
  readonly expression: ts.Expression;
  readonly report: (expression: ts.Expression) => void;
};

const inspectDiscardedExpression = ({
  checker,
  expression: candidate,
  report,
}: InspectDiscardedExpressionOptions): void => {
  const expression = unwrapDiscardedExpression(candidate);
  if (isAssignmentExpression(expression)) {
    return;
  }

  if (isCommaExpression(expression)) {
    inspectDiscardedExpression({
      checker,
      expression: expression.left,
      report,
    });
    inspectDiscardedExpression({
      checker,
      expression: expression.right,
      report,
    });
    return;
  }

  if (isLogicalExpression(expression)) {
    inspectDiscardedExpression({
      checker,
      expression: expression.left,
      report,
    });
    inspectDiscardedExpression({
      checker,
      expression: expression.right,
      report,
    });
    return;
  }

  if (ts.isConditionalExpression(expression)) {
    inspectDiscardedExpression({
      checker,
      expression: expression.condition,
      report,
    });
    inspectDiscardedExpression({
      checker,
      expression: expression.whenTrue,
      report,
    });
    inspectDiscardedExpression({
      checker,
      expression: expression.whenFalse,
      report,
    });
    return;
  }

  if (ts.isCommaListExpression(expression)) {
    for (const element of expression.elements) {
      inspectDiscardedExpression({
        checker,
        expression: element,
        report,
      });
    }
    return;
  }

  if (ts.isObjectLiteralExpression(expression)) {
    for (const property of expression.properties) {
      if (ts.isPropertyAssignment(property)) {
        inspectDiscardedExpression({
          checker,
          expression: property.initializer,
          report,
        });
      } else if (ts.isShorthandPropertyAssignment(property)) {
        inspectDiscardedExpression({
          checker,
          expression: property.name,
          report,
        });
      } else if (ts.isSpreadAssignment(property)) {
        inspectDiscardedExpression({
          checker,
          expression: property.expression,
          report,
        });
      }
    }
    return;
  }

  if (ts.isArrayLiteralExpression(expression)) {
    for (const element of expression.elements) {
      if (!ts.isOmittedExpression(element)) {
        inspectDiscardedExpression({
          checker,
          expression: ts.isSpreadElement(element)
            ? element.expression
            : element,
          report,
        });
      }
    }
    return;
  }

  if (ts.isTemplateExpression(expression)) {
    for (const { expression: interpolation } of expression.templateSpans) {
      inspectDiscardedExpression({
        checker,
        expression: interpolation,
        report,
      });
    }
    return;
  }

  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    const handledInlineSelection = inspectDiscardedContainerSelection({
      checker,
      expression,
      includeSelected: true,
      report,
    });
    if (handledInlineSelection) {
      return;
    }
  }

  if (ts.isCallExpression(expression)) {
    const callee = unwrapDiscardedExpression(expression.expression);
    if (
      (ts.isPropertyAccessExpression(callee) ||
        ts.isElementAccessExpression(callee)) &&
      !isCollectionCallbackInvocation(expression, callee, checker)
    ) {
      const atSelection = inlineArrayAtSelection(expression);
      if (atSelection === null) {
        inspectDiscardedContainerSelection({
          checker,
          expression: callee,
          report,
        });
      } else {
        inspectDiscardedContainerSelection({
          checker,
          expression: callee,
          report,
          selectionOverride: { kind: "index", value: atSelection.index },
        });
      }
    }
  }

  if (isBetterResultValueType(checker, checker.getTypeAtLocation(expression))) {
    report(expression);
  }
};

type ContainerSelection =
  | { readonly kind: "index"; readonly value: number }
  | { readonly kind: "property"; readonly value: string }
  | { readonly kind: "unknown" };

const containerSelection = (
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): ContainerSelection => {
  if (ts.isPropertyAccessExpression(expression)) {
    return { kind: "property", value: expression.name.text };
  }
  const argument = expression.argumentExpression;
  if (ts.isNumericLiteral(argument)) {
    return { kind: "index", value: Number(argument.text) };
  }
  if (ts.isStringLiteralLike(argument)) {
    const numericIndex = Number(argument.text);
    return Number.isInteger(numericIndex) &&
      String(numericIndex) === argument.text
      ? { kind: "index", value: numericIndex }
      : { kind: "property", value: argument.text };
  }
  return { kind: "unknown" };
};

const propertyName = (property: ts.ObjectLiteralElementLike): string | null => {
  if (
    !ts.isPropertyAssignment(property) &&
    !ts.isShorthandPropertyAssignment(property) &&
    !ts.isMethodDeclaration(property) &&
    !ts.isGetAccessorDeclaration(property) &&
    !ts.isSetAccessorDeclaration(property)
  ) {
    return null;
  }
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  return ts.isNumericLiteral(name) ? name.text : null;
};

type StaticObjectProvider =
  | { readonly kind: "absent" }
  | { readonly kind: "found"; readonly node: ts.Node }
  | { readonly kind: "opaque" };

const staticObjectProvider = (
  object: ts.ObjectLiteralExpression,
  selectedName: string,
): StaticObjectProvider => {
  for (const property of object.properties.toReversed()) {
    if (ts.isSpreadAssignment(property)) {
      const spread = unwrapDiscardedExpression(property.expression);
      if (!ts.isObjectLiteralExpression(spread)) {
        return { kind: "opaque" };
      }
      const nested = staticObjectProvider(spread, selectedName);
      if (nested.kind !== "absent") {
        return nested;
      }
      continue;
    }
    if (propertyName(property) !== selectedName) {
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      return { kind: "found", node: property.initializer };
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      return { kind: "found", node: property.name };
    }
    return { kind: "found", node: property };
  }
  return { kind: "absent" };
};

const inspectDiscardedObjectEntries = ({
  checker,
  object,
  report,
  retainedNode,
}: InspectDiscardedExpressionOptions & {
  readonly object: ts.ObjectLiteralExpression;
  readonly retainedNode: ts.Node | undefined;
}): void => {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)) {
      if (property.initializer !== retainedNode) {
        inspectDiscardedExpression({
          checker,
          expression: property.initializer,
          report,
        });
      }
    } else if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name !== retainedNode) {
        inspectDiscardedExpression({
          checker,
          expression: property.name,
          report,
        });
      }
    } else if (ts.isSpreadAssignment(property)) {
      const spread = unwrapDiscardedExpression(property.expression);
      if (ts.isObjectLiteralExpression(spread)) {
        inspectDiscardedObjectEntries({
          checker,
          expression: spread,
          object: spread,
          report,
          retainedNode,
        });
      } else {
        inspectDiscardedExpression({
          checker,
          expression: property.expression,
          report,
        });
      }
    }
  }
};

const inspectDiscardedContainerSelection = ({
  checker,
  expression,
  report,
  includeSelected = false,
  selectionOverride,
}: InspectDiscardedExpressionOptions & {
  readonly expression: ts.PropertyAccessExpression | ts.ElementAccessExpression;
  readonly includeSelected?: boolean;
  readonly selectionOverride?: ContainerSelection;
}): boolean => {
  const host = unwrapDiscardedExpression(expression.expression);
  const parentAtSelection = ts.isCallExpression(expression.parent)
    ? inlineArrayAtSelection(expression.parent)
    : null;
  const selection =
    selectionOverride ??
    (parentAtSelection?.callee === expression
      ? { kind: "index", value: parentAtSelection.index }
      : containerSelection(expression));
  if (ts.isObjectLiteralExpression(host)) {
    if (!includeSelected && selection.kind === "unknown") {
      return true;
    }
    const selectedName =
      selection.kind === "unknown" ? null : String(selection.value);
    const provider =
      includeSelected || selectedName === null
        ? { kind: "absent" as const }
        : staticObjectProvider(host, selectedName);
    if (provider.kind === "opaque") {
      return true;
    }
    inspectDiscardedObjectEntries({
      checker,
      expression: host,
      object: host,
      report,
      retainedNode: provider.kind === "found" ? provider.node : undefined,
    });
    return true;
  }
  if (!ts.isArrayLiteralExpression(host)) {
    return false;
  }
  const selectedIndex =
    selection.kind === "index" ? selection.value : undefined;
  for (const [index, element] of host.elements.entries()) {
    if (
      (!includeSelected && index === selectedIndex) ||
      ts.isOmittedExpression(element)
    ) {
      continue;
    }
    inspectDiscardedExpression({
      checker,
      expression: ts.isSpreadElement(element) ? element.expression : element,
      report,
    });
  }
  return true;
};

const constantInteger = (expression: ts.Expression): number | null => {
  const candidate = unwrapDiscardedExpression(expression);
  if (ts.isNumericLiteral(candidate)) {
    const value = Number(candidate.text);
    return Number.isInteger(value) ? value : null;
  }
  if (
    ts.isPrefixUnaryExpression(candidate) &&
    candidate.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(candidate.operand)
  ) {
    const value = -Number(candidate.operand.text);
    return Number.isInteger(value) ? value : null;
  }
  return null;
};

const inlineArrayAtSelection = (
  call: ts.CallExpression,
): {
  readonly callee: ts.PropertyAccessExpression | ts.ElementAccessExpression;
  readonly index: number;
} | null => {
  const callee = unwrapDiscardedExpression(call.expression);
  if (
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return null;
  }
  const selection = containerSelection(callee);
  if (selection.kind !== "property" || selection.value !== "at") {
    return null;
  }
  const host = unwrapDiscardedExpression(callee.expression);
  if (!ts.isArrayLiteralExpression(host)) {
    return null;
  }
  const argument = call.arguments.at(0);
  if (argument === undefined) {
    return null;
  }
  const requestedIndex = constantInteger(argument);
  if (requestedIndex === null) {
    return null;
  }
  return {
    callee,
    index:
      requestedIndex < 0
        ? host.elements.length + requestedIndex
        : requestedIndex,
  };
};

const isCollectionCallbackInvocation = (
  call: ts.CallExpression,
  callee: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  checker: ts.TypeChecker,
): boolean => {
  const host = unwrapDiscardedExpression(callee.expression);
  if (!ts.isArrayLiteralExpression(host) || call.arguments.length === 0) {
    return false;
  }
  const selection = containerSelection(callee);
  if (
    selection.kind !== "property" ||
    !COLLECTION_CALLBACK_METHODS.has(selection.value)
  ) {
    return false;
  }
  const callbackArgument = call.arguments.at(0);
  if (callbackArgument === undefined) {
    return false;
  }
  const callback = unwrapDiscardedExpression(callbackArgument);
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
    return false;
  }
  const parameter = callback.parameters.at(0)?.name;
  if (parameter === undefined || !ts.isIdentifier(parameter)) {
    return false;
  }
  const parameterSymbol = checker.getSymbolAtLocation(parameter);
  if (parameterSymbol === undefined) {
    return false;
  }

  const isTerminalConsume = (candidate: ts.Expression): boolean => {
    const expression = unwrapDiscardedExpression(candidate);
    if (!ts.isCallExpression(expression)) {
      return false;
    }
    const consumedMember = unwrapDiscardedExpression(expression.expression);
    if (
      !ts.isPropertyAccessExpression(consumedMember) &&
      !ts.isElementAccessExpression(consumedMember)
    ) {
      return false;
    }
    const consumedValue = unwrapDiscardedExpression(consumedMember.expression);
    if (
      !ts.isIdentifier(consumedValue) ||
      checker.getSymbolAtLocation(consumedValue) !== parameterSymbol
    ) {
      return false;
    }
    const method = containerSelection(consumedMember);
    return (
      method.kind === "property" &&
      (method.value === "match" || method.value === "unwrap")
    );
  };

  if (!ts.isBlock(callback.body)) {
    return isTerminalConsume(callback.body);
  }
  for (const statement of callback.body.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      isTerminalConsume(statement.expression)
    ) {
      return true;
    }
    if (
      ts.isIfStatement(statement) ||
      ts.isSwitchStatement(statement) ||
      ts.isTryStatement(statement) ||
      ts.isWhileStatement(statement) ||
      ts.isDoStatement(statement) ||
      ts.isForStatement(statement) ||
      ts.isForInStatement(statement) ||
      ts.isForOfStatement(statement) ||
      ts.isReturnStatement(statement) ||
      ts.isThrowStatement(statement) ||
      ts.isBlock(statement)
    ) {
      return false;
    }
  }
  return false;
};

const isConsumedInlineContainerMethod = (
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  checker: ts.TypeChecker,
): boolean => {
  const parent = expression.parent;
  if (!ts.isCallExpression(parent) || parent.expression !== expression) {
    return false;
  }
  if (isCollectionCallbackInvocation(parent, expression, checker)) {
    return true;
  }
  const host = unwrapDiscardedExpression(expression.expression);
  const selection = containerSelection(expression);
  return (
    ts.isArrayLiteralExpression(host) &&
    selection.kind === "property" &&
    selection.value === "at" &&
    inlineArrayAtSelection(parent) !== null
  );
};

const isBetterResultVariant = (
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean => {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const expectedStatus =
    symbol === undefined
      ? undefined
      : RESULT_VARIANT_STATUS.get(symbol.getName());
  if (symbol === undefined || expectedStatus === undefined) {
    return false;
  }

  if (symbol.declarations?.some(isBetterResultDeclaration) !== true) {
    return false;
  }

  const statusProperty = type.getProperty("status");
  const statusDeclaration =
    statusProperty?.valueDeclaration ?? statusProperty?.declarations?.at(0);
  if (statusProperty === undefined || statusDeclaration === undefined) {
    return false;
  }

  const statusType = checker.getTypeOfSymbolAtLocation(
    statusProperty,
    statusDeclaration,
  );
  return statusType.isStringLiteral() && statusType.value === expectedStatus;
};

const isBetterResultType = (
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean => {
  if (type.isUnionOrIntersection()) {
    return type.types.some((part) => isBetterResultType(checker, part));
  }

  // Require three independent signals before reporting: the public variant
  // name, a declaration owned by better-result, and its matching literal
  // status discriminant. Structural lookalikes and local Ok/Err classes can
  // satisfy at most two of those signals.
  return isBetterResultVariant(checker, type);
};

const promiseFulfilledValueType = (
  checker: ts.TypeChecker,
  type: ts.Type,
): ts.Type | undefined => {
  if (type.isUnionOrIntersection()) {
    for (const part of type.types) {
      const valueType = promiseFulfilledValueType(checker, part);
      if (valueType !== undefined) {
        return valueType;
      }
    }
    return undefined;
  }

  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (
    symbol?.getName() !== "PromiseFulfilledResult" ||
    symbol.declarations?.some((declaration) =>
      declaration
        .getSourceFile()
        .fileName.replaceAll("\\", "/")
        .endsWith("/lib.es2020.promise.d.ts"),
    ) !== true
  ) {
    return undefined;
  }

  const value = type.getProperty("value");
  const declaration = value?.valueDeclaration ?? value?.declarations?.at(0);
  return value === undefined || declaration === undefined
    ? undefined
    : checker.getTypeOfSymbolAtLocation(value, declaration);
};

const isBetterResultValueType = (
  checker: ts.TypeChecker,
  type: ts.Type,
  seen = new Set<ts.Type>(),
): boolean => {
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);

  if (isBetterResultType(checker, type)) {
    return true;
  }

  const awaitedType = checker.getAwaitedType(type);
  if (
    awaitedType !== undefined &&
    awaitedType !== type &&
    isBetterResultValueType(checker, awaitedType, seen)
  ) {
    return true;
  }

  const fulfilledValueType = promiseFulfilledValueType(checker, type);
  if (
    fulfilledValueType !== undefined &&
    fulfilledValueType !== type &&
    isBetterResultValueType(checker, fulfilledValueType, seen)
  ) {
    return true;
  }

  const elementType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  return (
    elementType !== undefined &&
    elementType !== type &&
    isBetterResultValueType(checker, elementType, seen)
  );
};

const isBetterResultDeclaration = (declaration: ts.Declaration): boolean =>
  path
    .normalize(declaration.getSourceFile().fileName)
    .includes(BETTER_RESULT_PACKAGE);

const isUnwrapWithoutMessage = (
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean => {
  const signature = checker.getResolvedSignature(call);
  if (
    signature?.declaration === undefined ||
    !isBetterResultDeclaration(signature.declaration)
  ) {
    return false;
  }

  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "unwrap") {
    return false;
  }

  const messageArgumentIndex = signature.getParameters().length === 2 ? 1 : 0;
  const message = call.arguments.at(messageArgumentIndex);
  return (
    message === undefined ||
    !ts.isStringLiteralLike(message) ||
    message.text.trim().length === 0
  );
};

type CreateDiagnosticOptions = {
  readonly message: string;
  readonly node: ts.Node;
  readonly repositoryRoot: string;
  readonly rule: ResultConsumptionDiagnostic["rule"];
};

const createDiagnostic = ({
  message,
  node,
  repositoryRoot,
  rule,
}: CreateDiagnosticOptions): ResultConsumptionDiagnostic => {
  const sourceFile = node.getSourceFile();
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return {
    column: position.character + 1,
    file: path.relative(repositoryRoot, sourceFile.fileName),
    line: position.line + 1,
    message,
    rule,
  };
};

type CreateProgramOptions = {
  readonly configPath: string;
  readonly rootNames?: readonly string[];
};

const createProgram = ({
  configPath,
  rootNames,
}: CreateProgramOptions): ts.Program => {
  const configFile = ts.readConfigFile(configPath, (file) =>
    ts.sys.readFile(file),
  );
  if (configFile.error !== undefined) {
    panic(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  const errors = withoutTsgoOnlyOptionDiagnostics(parsed.errors);
  if (errors.length > 0) {
    panic(
      errors
        .map(({ messageText }) =>
          ts.flattenDiagnosticMessageText(messageText, "\n"),
        )
        .join("\n"),
    );
  }

  const options = {
    rootNames:
      rootNames === undefined
        ? parsed.fileNames
        : [
            ...rootNames,
            ...parsed.fileNames.filter((file) => file.endsWith(".d.ts")),
          ],
    options: parsed.options,
  };
  if (parsed.projectReferences === undefined) {
    return ts.createProgram(options);
  }
  return ts.createProgram({
    ...options,
    projectReferences: parsed.projectReferences,
  });
};

type CliOptions =
  | { readonly mode: "all" }
  | { readonly base: string; readonly mode: "changed" };

const parseCliOptions = (): CliOptions => {
  if (process.argv.includes("--all")) {
    return { mode: "all" };
  }

  const baseIndex = process.argv.indexOf("--base");
  const explicitBase =
    baseIndex === -1 ? undefined : process.argv.at(baseIndex + 1);
  if (baseIndex !== -1 && explicitBase === undefined) {
    panic("--base requires a git ref");
  }
  return {
    base: explicitBase ?? process.env["TURBO_SCM_BASE"] ?? "origin/main",
    mode: "changed",
  };
};

const gitLines = (
  repositoryRoot: string,
  args: readonly string[],
): string[] => {
  const output = execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf-8",
  });
  return output.split("\n").filter(Boolean);
};

const changedSourceFiles = (repositoryRoot: string, base: string): string[] => {
  const files = new Set([
    ...gitLines(repositoryRoot, [
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      `${base}...HEAD`,
    ]),
    ...gitLines(repositoryRoot, [
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      "HEAD",
    ]),
    ...gitLines(repositoryRoot, ["ls-files", "--others", "--exclude-standard"]),
  ]);

  return [...files]
    .filter(isProductSourcePath)
    .map((file) => path.join(repositoryRoot, file))
    .sort();
};

const workspaceConfig = (
  repositoryRoot: string,
  sourceFile: string,
): string | null => {
  const [parent, workspace, directory] = path
    .relative(repositoryRoot, sourceFile)
    .split(path.sep);
  if (parent === "scripts") {
    const config = path.join(repositoryRoot, "scripts", "tsconfig.json");
    return ts.sys.fileExists(config) ? config : null;
  }
  if ((parent !== "apps" && parent !== "packages") || workspace === undefined) {
    return null;
  }

  if (directory === "scripts") {
    const scriptsConfig = path.join(
      repositoryRoot,
      parent,
      workspace,
      directory,
      "tsconfig.json",
    );
    if (ts.sys.fileExists(scriptsConfig)) {
      return scriptsConfig;
    }
  }

  const config = path.join(repositoryRoot, parent, workspace, "tsconfig.json");
  return ts.sys.fileExists(config) ? config : null;
};

const groupChangedFilesByConfig = (
  repositoryRoot: string,
  files: readonly string[],
): Map<string, string[]> => {
  const grouped = new Map<string, string[]>();
  for (const file of files) {
    const config = workspaceConfig(repositoryRoot, file);
    if (config === null) {
      continue;
    }
    const group = grouped.get(config) ?? [];
    group.push(file);
    grouped.set(config, group);
  }
  return grouped;
};

export const findResultWorkspaceConfigs = (
  repositoryRoot: string,
): Map<string, undefined> => {
  const configs = new Map<string, undefined>();

  const addDirectoryConfig = (
    directory: string,
    requireResultImport: boolean,
  ): void => {
    if (!ts.sys.directoryExists(directory)) {
      return;
    }

    const eligibleSourceFiles = ts.sys
      .readDirectory(directory, [".ts", ".tsx"])
      .filter((sourceFile) => {
        const relative = path
          .relative(repositoryRoot, sourceFile)
          .replaceAll(path.sep, "/");
        return isProductSourcePath(relative);
      });
    if (eligibleSourceFiles.length === 0) {
      return;
    }
    if (
      requireResultImport &&
      !eligibleSourceFiles.some((sourceFile) => {
        const source = ts.sys.readFile(sourceFile);
        return source !== undefined && RESULT_IMPORT_PATTERN.test(source);
      })
    ) {
      return;
    }

    const config = workspaceConfig(
      repositoryRoot,
      path.join(directory, "result-consumption-discovery.ts"),
    );
    if (config !== null) {
      configs.set(config, undefined);
    }
  };

  addDirectoryConfig(path.join(repositoryRoot, "scripts"), false);

  for (const parent of ["apps", "packages"]) {
    const parentDirectory = path.join(repositoryRoot, parent);
    for (const workspace of ts.sys.getDirectories(parentDirectory)) {
      const workspaceDirectory = path.join(parentDirectory, workspace);
      addDirectoryConfig(path.join(workspaceDirectory, "src"), true);
      addDirectoryConfig(path.join(workspaceDirectory, "scripts"), false);
    }
  }
  return configs;
};

const run = (): number => {
  const repositoryRoot = path.resolve(import.meta.dir, "../../..");
  const cli = parseCliOptions();
  const changedFiles =
    cli.mode === "changed"
      ? changedSourceFiles(repositoryRoot, cli.base)
      : undefined;
  if (changedFiles?.length === 0) {
    console.log("result-consumption: no changed product TypeScript files");
    return 0;
  }

  const diagnosticsByLocation = new Map<string, ResultConsumptionDiagnostic>();

  const projects =
    changedFiles === undefined
      ? findResultWorkspaceConfigs(repositoryRoot)
      : groupChangedFilesByConfig(repositoryRoot, changedFiles);

  for (const [configPath, rootNames] of projects) {
    const program =
      rootNames === undefined
        ? createProgram({ configPath })
        : createProgram({ configPath, rootNames });
    const diagnostics =
      rootNames === undefined
        ? scanResultConsumption({ program, repositoryRoot })
        : scanResultConsumption({
            program,
            repositoryRoot,
            sourceFiles: new Set(rootNames),
          });
    for (const diagnostic of diagnostics) {
      const key = `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${diagnostic.rule}`;
      diagnosticsByLocation.set(key, diagnostic);
    }
  }

  const diagnostics = [...diagnosticsByLocation.values()].sort((a, b) =>
    `${a.file}:${a.line}:${a.column}`.localeCompare(
      `${b.file}:${b.line}:${b.column}`,
    ),
  );
  for (const diagnostic of diagnostics) {
    console.error(
      `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message} [${diagnostic.rule}]`,
    );
  }

  if (diagnostics.length > 0) {
    console.error(
      `result-consumption: ${diagnostics.length} violation(s) found.`,
    );
    return 1;
  }

  console.log(`result-consumption: OK (${projects.size} project(s) checked)`);
  return 0;
};

if (import.meta.main) {
  process.exitCode = run();
}
