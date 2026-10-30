import { panic } from "better-result";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as ts from "tsrs/unstable/ast";
import {
  type Checker,
  IndexKind,
  type Program,
  type Type,
} from "tsrs/unstable/async";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

import {
  CODE_CHECK_LEGS,
  type CodeCheckLeg,
  ownsCodeCheckPath,
} from "./code-quality-partition";
import { createProgram } from "./typescript-program";

const asyncSome = async <T>(
  values: readonly T[],
  predicate: (value: T) => Promise<boolean>,
): Promise<boolean> => {
  for (const value of values) {
    if (await predicate(value)) {
      return true;
    }
  }
  return false;
};

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
  readonly program: Program;
  readonly checker: Checker;
  readonly repositoryRoot: string;
  readonly sourceFiles?: ReadonlySet<string>;
};

export const scanResultConsumption = async ({
  program,
  checker,
  repositoryRoot,
  sourceFiles,
}: ScanProgramOptions): Promise<ResultConsumptionDiagnostic[]> => {
  const diagnostics: ResultConsumptionDiagnostic[] = [];
  const reportedDiscardedExpressions = new Set<ts.Expression>();

  for (const fileName of await program.getSourceFileNames()) {
    if (
      !isProductSourcePath(repoRelativePath(repositoryRoot, fileName)) ||
      (sourceFiles !== undefined && !sourceFiles.has(fileName))
    ) {
      continue;
    }
    const sourceFile = await program.getSourceFile(fileName);
    if (sourceFile === undefined) {
      continue;
    }
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

    const inspect = async (node: ts.Node): Promise<void> => {
      if (ts.isExpressionStatement(node)) {
        await inspectDiscardedExpression({
          checker,
          expression: node.expression,
          report: reportDiscardedResult,
        });
      }

      if (isCommaExpression(node)) {
        // A comma expression always discards its non-final operand, even when
        // the surrounding expression is assigned, returned, or passed on.
        await inspectDiscardedExpression({
          checker,
          expression: node.left,
          report: reportDiscardedResult,
        });
      }

      if (
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)) &&
        !(await isConsumedInlineContainerMethod(node, checker))
      ) {
        // Constructing an ephemeral container evaluates every entry, even
        // when the selected value is retained by an assignment or return.
        await inspectDiscardedContainerSelection({
          checker,
          expression: node,
          report: reportDiscardedResult,
        });
      }

      if (ts.isCallExpression(node)) {
        const atSelection = inlineArrayAtSelection(node);
        if (atSelection !== null) {
          await inspectDiscardedContainerSelection({
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

      if (
        ts.isCallExpression(node) &&
        (await isUnwrapWithoutMessage(node, checker))
      ) {
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
    };
    const nodes: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      nodes.push(node);
      node.forEachChild(visit);
    };
    visit(sourceFile);
    for (const node of nodes) {
      await inspect(node);
    }
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

  if (!isPathInside(repositoryRoot, sourceFile.fileName)) {
    return false;
  }

  const relative = repoRelativePath(repositoryRoot, sourceFile.fileName);
  return isProductSourcePath(relative);
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
  readonly checker: Checker;
  readonly expression: ts.Expression;
  readonly report: (expression: ts.Expression) => void;
};

const inspectDiscardedExpression = async ({
  checker,
  expression: candidate,
  report,
}: InspectDiscardedExpressionOptions): Promise<void> => {
  const expression = unwrapDiscardedExpression(candidate);
  if (isAssignmentExpression(expression)) {
    return;
  }

  if (isCommaExpression(expression)) {
    await inspectDiscardedExpression({
      checker,
      expression: expression.left,
      report,
    });
    await inspectDiscardedExpression({
      checker,
      expression: expression.right,
      report,
    });
    return;
  }

  if (isLogicalExpression(expression)) {
    await inspectDiscardedExpression({
      checker,
      expression: expression.left,
      report,
    });
    await inspectDiscardedExpression({
      checker,
      expression: expression.right,
      report,
    });
    return;
  }

  if (ts.isConditionalExpression(expression)) {
    await inspectDiscardedExpression({
      checker,
      expression: expression.condition,
      report,
    });
    await inspectDiscardedExpression({
      checker,
      expression: expression.whenTrue,
      report,
    });
    await inspectDiscardedExpression({
      checker,
      expression: expression.whenFalse,
      report,
    });
    return;
  }

  if (ts.isObjectLiteralExpression(expression)) {
    for (const property of expression.properties) {
      if (ts.isPropertyAssignment(property)) {
        await inspectDiscardedExpression({
          checker,
          expression: property.initializer,
          report,
        });
      } else if (
        ts.isShorthandPropertyAssignment(property) &&
        ts.isIdentifier(property.name)
      ) {
        await inspectDiscardedExpression({
          checker,
          expression: property.name,
          report,
        });
      } else if (ts.isSpreadAssignment(property)) {
        await inspectDiscardedExpression({
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
        await inspectDiscardedExpression({
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
      await inspectDiscardedExpression({
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
    const handledInlineSelection = await inspectDiscardedContainerSelection({
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
      !(await isCollectionCallbackInvocation(expression, callee, checker))
    ) {
      const atSelection = inlineArrayAtSelection(expression);
      if (atSelection === null) {
        await inspectDiscardedContainerSelection({
          checker,
          expression: callee,
          report,
        });
      } else {
        await inspectDiscardedContainerSelection({
          checker,
          expression: callee,
          report,
          selectionOverride: { kind: "index", value: atSelection.index },
        });
      }
    }
  }

  if (
    await isBetterResultValueType(
      checker,
      await checker.getTypeAtLocation(expression),
    )
  ) {
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
  if (ts.isStringLiteralLikeNode(argument)) {
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
  if (ts.isIdentifier(name) || ts.isStringLiteralLikeNode(name)) {
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

const inspectDiscardedObjectEntries = async ({
  checker,
  object,
  report,
  retainedNode,
}: InspectDiscardedExpressionOptions & {
  readonly object: ts.ObjectLiteralExpression;
  readonly retainedNode: ts.Node | undefined;
}): Promise<void> => {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)) {
      if (property.initializer !== retainedNode) {
        await inspectDiscardedExpression({
          checker,
          expression: property.initializer,
          report,
        });
      }
    } else if (
      ts.isShorthandPropertyAssignment(property) &&
      ts.isIdentifier(property.name)
    ) {
      if (property.name !== retainedNode) {
        await inspectDiscardedExpression({
          checker,
          expression: property.name,
          report,
        });
      }
    } else if (ts.isSpreadAssignment(property)) {
      const spread = unwrapDiscardedExpression(property.expression);
      if (ts.isObjectLiteralExpression(spread)) {
        await inspectDiscardedObjectEntries({
          checker,
          expression: spread,
          object: spread,
          report,
          retainedNode,
        });
      } else {
        await inspectDiscardedExpression({
          checker,
          expression: property.expression,
          report,
        });
      }
    }
  }
};

const inspectDiscardedContainerSelection = async ({
  checker,
  expression,
  report,
  includeSelected = false,
  selectionOverride,
}: InspectDiscardedExpressionOptions & {
  readonly expression: ts.PropertyAccessExpression | ts.ElementAccessExpression;
  readonly includeSelected?: boolean;
  readonly selectionOverride?: ContainerSelection;
}): Promise<boolean> => {
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
    await inspectDiscardedObjectEntries({
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
    await inspectDiscardedExpression({
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

const isCollectionCallbackInvocation = async (
  call: ts.CallExpression,
  callee: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  checker: Checker,
): Promise<boolean> => {
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
  const parameterSymbol = await checker.getSymbolAtLocation(parameter);
  if (parameterSymbol === undefined) {
    return false;
  }

  const isTerminalConsume = async (
    candidate: ts.Expression,
  ): Promise<boolean> => {
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
      (await checker.getSymbolAtLocation(consumedValue)) !== parameterSymbol
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
    return await isTerminalConsume(callback.body);
  }
  for (const statement of callback.body.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      (await isTerminalConsume(statement.expression))
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

const isConsumedInlineContainerMethod = async (
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  checker: Checker,
): Promise<boolean> => {
  const parent = expression.parent;
  if (!ts.isCallExpression(parent) || parent.expression !== expression) {
    return false;
  }
  if (await isCollectionCallbackInvocation(parent, expression, checker)) {
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

const isBetterResultVariant = async (
  checker: Checker,
  type: Type,
): Promise<boolean> => {
  const symbol = (await type.getAliasSymbol()) ?? (await type.getSymbol());
  const expectedStatus =
    symbol === undefined ? undefined : RESULT_VARIANT_STATUS.get(symbol.name);
  if (symbol === undefined || expectedStatus === undefined) {
    return false;
  }

  if (
    !(
      await Promise.all(
        symbol.declarations.map(async (declaration) =>
          isBetterResultDeclaration(
            (await declaration.resolve()) ??
              panic("A Result declaration handle did not resolve"),
          ),
        ),
      )
    ).some(Boolean)
  ) {
    return false;
  }

  const statusProperty = await type.getProperty("status");
  const statusDeclaration = await (
    statusProperty?.valueDeclaration ?? statusProperty?.declarations.at(0)
  )?.resolve();
  if (statusProperty === undefined || statusDeclaration === undefined) {
    return false;
  }

  const statusType = await checker.getTypeOfSymbolAtLocation(
    statusProperty,
    statusDeclaration,
  );
  return (
    statusType.isStringLiteralType() && statusType.value === expectedStatus
  );
};

const isBetterResultType = async (
  checker: Checker,
  type: Type,
): Promise<boolean> => {
  if (type.isUnionType() || type.isIntersectionType()) {
    return asyncSome(
      await type.getTypes(),
      async (part) => await isBetterResultType(checker, part),
    );
  }

  // Require three independent signals before reporting: the public variant
  // name, a declaration owned by better-result, and its matching literal
  // status discriminant. Structural lookalikes and local Ok/Err classes can
  // satisfy at most two of those signals.
  return await isBetterResultVariant(checker, type);
};

const promiseFulfilledValueType = async (
  checker: Checker,
  type: Type,
): Promise<Type | undefined> => {
  if (type.isUnionType() || type.isIntersectionType()) {
    for (const part of await type.getTypes()) {
      const valueType = await promiseFulfilledValueType(checker, part);
      if (valueType !== undefined) {
        return valueType;
      }
    }
    return undefined;
  }

  const symbol = (await type.getAliasSymbol()) ?? (await type.getSymbol());
  if (
    symbol?.name !== "PromiseFulfilledResult" ||
    !(await asyncSome(symbol.declarations, async (handle) =>
      (
        (await handle.resolve()) ??
        panic("A promise declaration handle did not resolve")
      )
        .getSourceFile()
        .fileName.replaceAll("\\", "/")
        .endsWith("/lib.es2020.promise.d.ts"),
    ))
  ) {
    return undefined;
  }

  const value = await type.getProperty("value");
  const declaration = await (
    value?.valueDeclaration ?? value?.declarations.at(0)
  )?.resolve();
  return value === undefined || declaration === undefined
    ? undefined
    : await checker.getTypeOfSymbolAtLocation(value, declaration);
};

const isBetterResultValueType = async (
  checker: Checker,
  type: Type,
  seen = new Set<Type>(),
): Promise<boolean> => {
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);

  if (await isBetterResultType(checker, type)) {
    return true;
  }

  const awaitedType = await checker.getAwaitedType(type);
  if (
    awaitedType !== undefined &&
    awaitedType !== type &&
    (await isBetterResultValueType(checker, awaitedType, seen))
  ) {
    return true;
  }

  const fulfilledValueType = await promiseFulfilledValueType(checker, type);
  if (
    fulfilledValueType !== undefined &&
    fulfilledValueType !== type &&
    (await isBetterResultValueType(checker, fulfilledValueType, seen))
  ) {
    return true;
  }

  const elementType = await checker.getIndexTypeOfType(type, IndexKind.Number);
  return (
    elementType !== undefined &&
    elementType !== type &&
    (await isBetterResultValueType(checker, elementType, seen))
  );
};

const isBetterResultDeclaration = (declaration: ts.Declaration): boolean =>
  path
    .normalize(declaration.getSourceFile().fileName)
    .includes(BETTER_RESULT_PACKAGE);

const isUnwrapWithoutMessage = async (
  call: ts.CallExpression,
  checker: Checker,
): Promise<boolean> => {
  const signature = await checker.getResolvedSignature(call);
  if (
    signature.declaration === undefined ||
    !isBetterResultDeclaration(
      (await signature.declaration.resolve()) ??
        panic("A Result signature declaration handle did not resolve"),
    )
  ) {
    return false;
  }

  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "unwrap") {
    return false;
  }

  const messageArgumentIndex = signature.parameters.length === 2 ? 1 : 0;
  const message = call.arguments.at(messageArgumentIndex);
  return (
    message === undefined ||
    !ts.isStringLiteralLikeNode(message) ||
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
    file: repoRelativePath(repositoryRoot, sourceFile.fileName),
    line: position.line + 1,
    message,
    rule,
  };
};

type CliOptions = (
  { readonly mode: "all" } | { readonly base: string; readonly mode: "changed" }
) & { readonly leg?: CodeCheckLeg };

export const parseResultConsumptionArgs = (
  args: readonly string[],
): CliOptions => {
  const legIndex = args.indexOf("--leg");
  const requestedLeg = legIndex === -1 ? undefined : args.at(legIndex + 1);
  const leg = CODE_CHECK_LEGS.find((candidate) => candidate === requestedLeg);
  if (legIndex !== -1 && leg === undefined) {
    panic("--leg requires api, web or rest");
  }
  if (args.includes("--all")) {
    return { mode: "all", ...(leg === undefined ? {} : { leg }) };
  }

  const baseIndex = args.indexOf("--base");
  const explicitBase = baseIndex === -1 ? undefined : args.at(baseIndex + 1);
  if (baseIndex !== -1 && explicitBase === undefined) {
    panic("--base requires a git ref");
  }
  return {
    base: explicitBase ?? process.env["TURBO_SCM_BASE"] ?? "origin/main",
    mode: "changed",
    ...(leg === undefined ? {} : { leg }),
  };
};

const gitLines = (
  repositoryRoot: string,
  args: readonly string[],
): string[] => {
  const output = execFileSync("git", args, {
    maxBuffer: 2 ** 30,
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
    .toSorted();
};

const workspaceConfig = (
  repositoryRoot: string,
  sourceFile: string,
): string | null => {
  const [parent, workspace, directory] = repoRelativePath(
    repositoryRoot,
    sourceFile,
  ).split("/");
  if (parent === "scripts") {
    const config = path.join(repositoryRoot, "scripts", "tsconfig.json");
    return existsSync(config) ? config : null;
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
    if (existsSync(scriptsConfig)) {
      return scriptsConfig;
    }
  }

  const config = path.join(repositoryRoot, parent, workspace, "tsconfig.json");
  return existsSync(config) ? config : null;
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
    if (!existsSync(directory)) {
      return;
    }

    const eligibleSourceFiles = [
      ...new Bun.Glob("**/*.{ts,tsx}").scanSync({
        cwd: directory,
        absolute: true,
      }),
    ].filter((sourceFile) => {
      const relative = repoRelativePath(repositoryRoot, sourceFile);
      return isProductSourcePath(relative);
    });
    if (eligibleSourceFiles.length === 0) {
      return;
    }
    if (
      requireResultImport &&
      !eligibleSourceFiles.some((sourceFile) => {
        const source = readFileSync(sourceFile, "utf-8");
        return RESULT_IMPORT_PATTERN.test(source);
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
    if (!existsSync(parentDirectory)) {
      continue;
    }
    for (const workspace of readdirSync(parentDirectory, {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)) {
      const workspaceDirectory = path.join(parentDirectory, workspace);
      addDirectoryConfig(path.join(workspaceDirectory, "src"), true);
      addDirectoryConfig(path.join(workspaceDirectory, "scripts"), false);
    }
  }
  return configs;
};

type PartitionResultProjectsOptions = {
  projects: ReadonlyMap<string, string[] | undefined>;
  repositoryRoot: string;
  leg: CodeCheckLeg;
};

// Partition after the existing full/changed discovery. Keep each complete
// program (including imported source) and its original changed-file filter.
export const partitionResultProjects = ({
  projects,
  repositoryRoot,
  leg,
}: PartitionResultProjectsOptions): Map<string, string[] | undefined> =>
  new Map(
    [...projects].filter(([configPath]) =>
      ownsCodeCheckPath(repoRelativePath(repositoryRoot, configPath), leg),
    ),
  );

const run = async (): Promise<number> => {
  const repositoryRoot = path.resolve(import.meta.dir, "../../..");
  const cli = parseResultConsumptionArgs(process.argv.slice(2));
  const changedFiles =
    cli.mode === "changed"
      ? changedSourceFiles(repositoryRoot, cli.base)
      : undefined;
  if (changedFiles?.length === 0) {
    console.log("result-consumption: no changed product TypeScript files");
    return 0;
  }

  const diagnosticsByLocation = new Map<string, ResultConsumptionDiagnostic>();

  const discoveredProjects =
    changedFiles === undefined
      ? findResultWorkspaceConfigs(repositoryRoot)
      : groupChangedFilesByConfig(repositoryRoot, changedFiles);
  const projects =
    cli.leg === undefined
      ? discoveredProjects
      : partitionResultProjects({
          projects: discoveredProjects,
          repositoryRoot,
          leg: cli.leg,
        });

  for (const [configPath, rootNames] of projects) {
    const started = performance.now();
    const program =
      rootNames === undefined
        ? await createProgram({ configPath })
        : await createProgram({ configPath, rootNames });
    try {
      const diagnostics =
        rootNames === undefined
          ? await scanResultConsumption({ ...program, repositoryRoot })
          : await scanResultConsumption({
              ...program,
              repositoryRoot,
              sourceFiles: new Set(rootNames),
            });
      for (const diagnostic of diagnostics) {
        const key = `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${diagnostic.rule}`;
        diagnosticsByLocation.set(key, diagnostic);
      }
    } finally {
      await program.close();
    }
    console.log(
      `result-consumption: ${repoRelativePath(repositoryRoot, configPath)} checked in ${((performance.now() - started) / 1000).toFixed(1)}s`,
    );
  }

  const diagnostics = [...diagnosticsByLocation.values()].toSorted((a, b) =>
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
  process.exitCode = await run();
}
