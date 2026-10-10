import { panic } from "better-result";
import ts from "typescript";

import { parseSource } from "./parse-memo";
import { isExcludedSource } from "./source-globs";

// Stored/served data boundaries: UI rendering, optional metadata parsers and
// generic utilities are outside this metric's source surface.
export const UNSIGNALLED_SKIP_SOURCE_GLOBS = [
  "apps/api/src/handlers/case-law/ingestion/adapters/**/*.ts",
  "apps/api/src/handlers/case-law/decisions/{read*,get,by-slug,document-on-demand}.ts",
  "apps/api/src/handlers/legislation/{get,read,by-slug,provision*,version*,resolve}.ts",
  "apps/api/src/lib/legal-search/**/*.ts",
  "apps/api/src/lib/case-law/{decision-text,stored-payload,stored-analysis,published-decisions,analysis-store*}.ts",
  "apps/api/src/lib/chat/{projections,projection-schema,persisted-message-content,stream-message-capture,provider-tool-projection}.ts",
  "apps/api/src/handlers/chat/{stream-chat,export/**/*}.ts",
  "apps/api/src/mcp/**/*.ts",
  "apps/api/src/handlers/**/{import,export}.ts",
  "apps/api/src/lib/files/{extract*,export*,import*}.ts",
  "apps/web/src/features/case-law/**/*.ts",
  "packages/cli/src/**/*.ts",
  "packages/chat/src/**/*projection*.ts",
] as const;

export const isExcludedSkipSource = (file: string): boolean =>
  isExcludedSource(file) ||
  /\/(?:__fixtures__|fixtures|scripts|generated|specs|parsers|morphology)\//u.test(
    file,
  ) ||
  file.startsWith("apps/api/src/mcp/apps/") ||
  file.endsWith("/health-check.ts") ||
  file.endsWith("fixtures.ts") ||
  file.endsWith(".tsx") ||
  /\.generated\./u.test(file);

const parentNode = (node: ts.Node): ts.Node | undefined =>
  ts.isSourceFile(node) ? undefined : node.parent;

const unwrap = (node: ts.Expression): ts.Expression => {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAwaitExpression(node)
  ) {
    return unwrap(node.expression);
  }
  return node;
};

const callName = (expression: ts.Expression): string => {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  return "";
};

// Syntax-only inventory: these names belong to the repository's observation
// helpers. No type checker or application imports run during a ratchet scan.
const SIGNAL_CALLS = new Set([
  "panic",
  "observeFailure",
  "captureException",
  "captureMessage",
  "captureError",
  "captureRequestError",
  "captureObservedError",
  "captureRedactedException",
  "captureRouteErrorLifecycle",
  "recordRequestFailure",
  "reportEmitFailure",
  "reportFatalError",
  "emitAdmissionStorePolicyMetric",
  "emitRequestDurationMetric",
  "emitOpenRouterTokenExchange",
  "emitManagedCredentialUnavailable",
  "emitFailureMetric",
  "emitChatRunLogMetric",
  "emitPromptCacheMetric",
  "emitActionCostDropMetric",
  "emitChatTurnSettlementMetric",
  "emitAnonymizationRefusalMetric",
  "emitPublicCorpusAdmissionMetric",
  "emitActionResponseOversizeMetric",
]);
const LOG_METHODS = new Set([
  "debug",
  "info",
  "warn",
  "error",
  "log",
  "fatal",
  "request",
]);
const METRIC_METHODS = new Set([
  "increment",
  "inc",
  "add",
  "record",
  "observe",
]);

// A discriminant counts only when it names a failure: success payloads use the
// same keys (`kind: "windowed-text"`). A record collected into a failure list
// (`issues.push({ code: "unknown_source_id" })`, `failures.push({ reason })`)
// is a failure by its container.
const FAILURE_DISCRIMINANT =
  /fail|err|invalid|reject|skip|unavailable|missing|denied/iu;
const FAILURE_COLLECTION =
  /(?:issue|error|failure|reject|skip|warning|problem|diagnostic)s?$/iu;

const isTypedRecord = (
  expression: ts.Expression,
  { failureCollection = false } = {},
): boolean => {
  const node = unwrap(expression);
  if (!ts.isObjectLiteralExpression(node)) {
    return false;
  }
  return node.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) {
      return false;
    }
    const name =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : "";
    const value = unwrap(property.initializer);
    return (
      (name === "ok" && value.kind === ts.SyntaxKind.FalseKeyword) ||
      (["type", "status", "kind", "code", "reason"].includes(name) &&
        (ts.isStringLiteral(value) || ts.isPropertyAccessExpression(value)) &&
        (failureCollection || FAILURE_DISCRIMINANT.test(value.getText()))) ||
      (name.endsWith("Failures") && ts.isObjectLiteralExpression(value))
    );
  });
};

const declarationValue = (
  identifier: ts.Identifier,
): ts.Expression | undefined => {
  for (
    let scope: ts.Node | undefined = identifier.parent;
    scope;
    scope = parentNode(scope)
  ) {
    if (
      ts.isFunctionLike(scope) &&
      scope.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) &&
          parameter.name.text === identifier.text,
      )
    ) {
      return undefined;
    }
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) {
      continue;
    }
    for (const statement of scope.statements.toReversed()) {
      if (
        statement.getStart() >= identifier.getStart() ||
        !ts.isVariableStatement(statement)
      ) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === identifier.text
        ) {
          return declaration.initializer;
        }
      }
    }
  }
  return undefined;
};

const localFunctionBody = (
  identifier: ts.Identifier,
): ts.ConciseBody | undefined => {
  const value = declarationValue(identifier);
  if (value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
    return value.body;
  }
  for (
    let scope: ts.Node | undefined = identifier.parent;
    scope;
    scope = parentNode(scope)
  ) {
    if (
      ts.isFunctionLike(scope) &&
      scope.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) &&
          parameter.name.text === identifier.text,
      )
    ) {
      return undefined;
    }
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) {
      continue;
    }
    for (const statement of scope.statements) {
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === identifier.text
      ) {
        return statement.body;
      }
    }
  }
  return undefined;
};

const unwrapExpression = (node: ts.Node): ts.Expression => {
  if (ts.isExpression(node)) {
    return unwrap(node);
  }
  // Only block bodies and expression bodies reach this helper.
  return panic("Expected a callback expression body");
};

const LOCAL_HELPER_DEPTH = 4;

function isSignalCall(node: ts.CallExpression, depth: number): boolean {
  const callee = unwrap(node.expression);
  if (SIGNAL_CALLS.has(callName(callee))) {
    return true;
  }
  if (ts.isIdentifier(callee)) {
    const source = callee.getSourceFile();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some(
          (binding) =>
            binding.name.text === callee.text &&
            SIGNAL_CALLS.has(binding.propertyName?.text ?? binding.name.text),
        )
      ) {
        return true;
      }
    }
  }
  if (ts.isIdentifier(callee) && depth < LOCAL_HELPER_DEPTH) {
    const body = localFunctionBody(callee);
    if (body && !dropsWithoutSignal(body, depth + 1, "observe")) {
      return true;
    }
  }
  if (!ts.isPropertyAccessExpression(callee)) {
    return false;
  }
  const receiver = callee.expression.getText();
  return (
    (LOG_METHODS.has(callee.name.text) &&
      /(?:logger|log|console)$/iu.test(receiver)) ||
    (METRIC_METHODS.has(callee.name.text) &&
      /(?:metric|counter|skip|reject|fail)/iu.test(receiver)) ||
    (callee.name.text === "push" &&
      node.arguments.some(
        (argument) =>
          isTypedRecord(argument, {
            failureCollection: FAILURE_COLLECTION.test(receiver),
          }) || isTypedReturn(argument, depth),
      ))
  );
}

// Building a typed outcome observes nothing: it counts only where the outcome
// is returned or collected.
const TYPED_OUTCOME_METHODS = new Set(["err", "try", "tryPromise"]);

function isTypedOutcomeCall(node: ts.CallExpression, depth: number): boolean {
  const callee = unwrap(node.expression);
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.expression.getText() === "Result" &&
    TYPED_OUTCOME_METHODS.has(callee.name.text)
  ) {
    return true;
  }
  if (!ts.isIdentifier(callee) || depth >= LOCAL_HELPER_DEPTH) {
    return false;
  }
  const body = localFunctionBody(callee);
  return body !== undefined && !dropsWithoutSignal(body, depth + 1, "outcome");
}

function hasSignal(node: ts.Node, depth = 0): boolean {
  if (ts.isFunctionLike(node)) {
    return false;
  }
  if (ts.isConditionalExpression(node)) {
    return (
      hasSignal(node.condition, depth) ||
      (hasSignal(node.whenTrue, depth) && hasSignal(node.whenFalse, depth))
    );
  }
  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(node.operatorToken.kind)
  ) {
    return hasSignal(node.left, depth);
  }
  if (
    ts.isCallExpression(node) &&
    (node.questionDotToken ||
      (ts.isPropertyAccessExpression(node.expression) &&
        node.expression.questionDotToken))
  ) {
    return false;
  }
  if (ts.isCallExpression(node) && isSignalCall(node, depth)) {
    return true;
  }
  if (
    (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
    [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
      node.operator,
    ) &&
    /(?:skip|reject|fail|counter)/iu.test(node.operand.getText())
  ) {
    return true;
  }
  // Assigning a typed outcome hands it on to the enclosing code.
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    isTypedReturn(node.right, depth)
  ) {
    return true;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
    /(?:skip|reject|fail|counter)/iu.test(node.left.getText())
  ) {
    return true;
  }
  return node.getChildren().some((child) => hasSignal(child, depth));
}

function isTypedReturn(expression: ts.Expression, depth = 0): boolean {
  const node = unwrap(expression);
  if (isTypedRecord(node)) {
    return true;
  }
  if (ts.isConditionalExpression(node)) {
    return (
      isTypedReturn(node.whenTrue, depth) &&
      isTypedReturn(node.whenFalse, depth)
    );
  }
  if (ts.isCallExpression(node)) {
    return isTypedOutcomeCall(node, depth) || hasSignal(node, depth);
  }
  if (ts.isIdentifier(node) && depth < LOCAL_HELPER_DEPTH) {
    const value = declarationValue(node);
    return value !== undefined && isTypedReturn(value, depth + 1);
  }
  return false;
}

// `switchExits` holds the states of paths that leave the innermost switch with
// an unlabelled break: they continue after the switch, not out of the body.
type Flow = {
  live: boolean[];
  unsignalledExit: boolean;
  switchExits: boolean[];
};

// Track whether each reachable path has observed the failure. A signal in a
// sibling branch or deferred callback does not cover an empty return.
// "outcome": a returned typed outcome counts as handled (catch bodies, item
// callbacks). "observe": only an observation counts (a helper called for its
// effect, whose return value may be discarded).
type FlowMode = "outcome" | "observe";

type FlowOptions = {
  signalled?: boolean;
  depth?: number;
  mode?: FlowMode;
  inSwitch?: boolean;
};

const unique = (states: boolean[]): boolean[] => [...new Set(states)];

function flowSequence(
  statements: readonly ts.Statement[],
  options: Required<FlowOptions>,
): Flow {
  let live = [options.signalled];
  let unsignalledExit = false;
  const switchExits: boolean[] = [];
  for (const child of statements) {
    const next = live.map((state) =>
      flow(child, { ...options, signalled: state }),
    );
    live = unique(next.flatMap((item) => item.live));
    switchExits.push(...next.flatMap((item) => item.switchExits));
    unsignalledExit ||= next.some((item) => item.unsignalledExit);
  }
  return { live, unsignalledExit, switchExits: unique(switchExits) };
}

function flow(
  statement: ts.Node,
  {
    signalled = false,
    depth = 0,
    mode = "outcome",
    inSwitch = false,
  }: FlowOptions = {},
): Flow {
  const options = { signalled, depth, mode, inSwitch };
  if (ts.isBlock(statement)) {
    return flowSequence(statement.statements, options);
  }
  if (ts.isIfStatement(statement)) {
    const state = signalled || hasSignal(statement.expression, depth);
    const yes = flow(statement.thenStatement, { ...options, signalled: state });
    const no =
      statement.elseStatement === undefined
        ? { live: [state], unsignalledExit: false, switchExits: [] }
        : flow(statement.elseStatement, { ...options, signalled: state });
    return {
      live: unique([...yes.live, ...no.live]),
      unsignalledExit: yes.unsignalledExit || no.unsignalledExit,
      switchExits: unique([...yes.switchExits, ...no.switchExits]),
    };
  }
  if (ts.isThrowStatement(statement)) {
    return { live: [], unsignalledExit: false, switchExits: [] };
  }
  if (ts.isSwitchStatement(statement)) {
    // Case fallthrough is conservative: a case must carry its own signal.
    const outcomes = statement.caseBlock.clauses.map((clause) =>
      flowSequence(clause.statements, { ...options, inSwitch: true }),
    );
    if (!statement.caseBlock.clauses.some(ts.isDefaultClause)) {
      outcomes.push({
        live: [signalled],
        unsignalledExit: false,
        switchExits: [],
      });
    }
    return {
      live: unique(
        outcomes.flatMap((item) => [...item.live, ...item.switchExits]),
      ),
      unsignalledExit: outcomes.some((item) => item.unsignalledExit),
      switchExits: [],
    };
  }
  if (ts.isReturnStatement(statement)) {
    return {
      live: [],
      unsignalledExit:
        !signalled &&
        (statement.expression === undefined ||
          (mode === "observe"
            ? !hasSignal(statement.expression, depth)
            : !isTypedReturn(statement.expression, depth))),
      switchExits: [],
    };
  }
  if (
    ts.isBreakStatement(statement) &&
    statement.label === undefined &&
    inSwitch
  ) {
    return { live: [], unsignalledExit: false, switchExits: [signalled] };
  }
  if (ts.isContinueStatement(statement) || ts.isBreakStatement(statement)) {
    return { live: [], unsignalledExit: !signalled, switchExits: [] };
  }
  // Signals within control structures are conditional. Only direct statements
  // establish observation for the following statement.
  const observed =
    ts.isExpressionStatement(statement) || ts.isVariableStatement(statement)
      ? hasSignal(statement, depth)
      : false;
  return {
    live: [signalled || observed],
    unsignalledExit: false,
    switchExits: [],
  };
}

function dropsWithoutSignal(
  body: ts.Node,
  depth = 0,
  mode: FlowMode = "outcome",
): boolean {
  if (!ts.isBlock(body)) {
    const expression = unwrapExpression(body);
    return mode === "observe"
      ? !hasSignal(expression, depth)
      : !isTypedReturn(expression, depth);
  }
  const result = flow(body, { depth, mode });
  return result.unsignalledExit || result.live.includes(false);
}

const isLoop = (node: ts.Node): boolean =>
  ts.isForOfStatement(node) ||
  ts.isForInStatement(node) ||
  ts.isForStatement(node) ||
  ts.isWhileStatement(node) ||
  ts.isDoStatement(node);

const isLookupOrParse = (node: ts.Node): boolean => {
  if (ts.isFunctionLike(node)) {
    return false;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText() === "Result" &&
    ["try", "tryPromise"].includes(node.expression.name.text)
  ) {
    return true;
  }
  if (
    ts.isCallExpression(node) &&
    /^(?:(?:parse|safeParse|decode|lookup|find)(?:[A-Z_]|$)|get$|exec$|match$|valueAtPath$|fieldOf$|asString$|sentenceHeadPattern$|extractId$)/u.test(
      callName(node.expression),
    )
  ) {
    return true;
  }
  return node.getChildren().some(isLookupOrParse);
};

// Resolve only preceding declarations in enclosing blocks; unrelated functions
// and shadowed names cannot supply a parse/lookup origin.

const refersToFailure = (node: ts.Node, seen = new Set<ts.Node>()): boolean => {
  if (ts.isFunctionLike(node)) {
    return false;
  }
  if (seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (isLookupOrParse(node)) {
    return true;
  }
  if (ts.isIdentifier(node)) {
    if (
      (ts.isCallExpression(node.parent) && node.parent.expression === node) ||
      (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      return false;
    }
    const value = declarationValue(node);
    return (
      value !== undefined &&
      (isLookupOrParse(value) || refersToFailure(value, seen))
    );
  }
  return node.getChildren().some((child) => refersToFailure(child, seen));
};

const ERROR_PREDICATES = new Set(["isErr", "isError", "isFailure"]);

const isAbsent = (node: ts.Expression): boolean => {
  const value = unwrap(node);
  return (
    value.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(value) && value.text === "undefined") ||
    ts.isVoidExpression(value)
  );
};

const failureArm = (expression: ts.Expression): "then" | "else" => {
  const node = unwrap(expression);
  if (
    ts.isCallExpression(node) &&
    ERROR_PREDICATES.has(callName(node.expression))
  ) {
    return "then";
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return failureArm(node.operand) === "then" ? "else" : "then";
  }
  if (ts.isBinaryExpression(node)) {
    if (
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
      ].includes(node.operatorToken.kind)
    ) {
      if (refersToFailure(node.left)) {
        return failureArm(node.left);
      }
      if (refersToFailure(node.right)) {
        return failureArm(node.right);
      }
    }
    const equality = [
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken,
    ].includes(node.operatorToken.kind);
    const inequality = [
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(node.operatorToken.kind);
    if (equality || inequality) {
      if (isAbsent(node.left) || isAbsent(node.right)) {
        return equality ? "then" : "else";
      }
      // Equality is symmetric: the boolean literal may sit on either side.
      const sides = [node.left.kind, node.right.kind];
      if (sides.includes(ts.SyntaxKind.FalseKeyword)) {
        return equality ? "then" : "else";
      }
      if (sides.includes(ts.SyntaxKind.TrueKeyword)) {
        return equality ? "else" : "then";
      }
    }
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    ["error", "isError"].includes(node.name.text)
  ) {
    return "then";
  }
  return "else";
};

const isEmptyFallback = (node: ts.Expression): boolean => {
  const value = unwrap(node);
  return (
    (ts.isStringLiteral(value) && value.text === "") ||
    (ts.isArrayLiteralExpression(value) && value.elements.length === 0) ||
    (ts.isObjectLiteralExpression(value) && value.properties.length === 0)
  );
};

const EXTRACTION_CALLS = new Set([
  "valueAtPath",
  "asString",
  "fieldOf",
  "sentenceHeadPattern",
  "extractId",
]);

const isMapLookup = (node: ts.CallExpression): boolean => {
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    !["get", "has"].includes(node.expression.name.text)
  ) {
    return false;
  }
  const receiver = unwrap(node.expression.expression);
  const value = ts.isIdentifier(receiver)
    ? declarationValue(receiver)
    : receiver;
  if (value === undefined) {
    return false;
  }
  const constructor = unwrap(value);
  return (
    ts.isNewExpression(constructor) &&
    callName(constructor.expression) === "Map"
  );
};

const isExtractionCall = (expression: ts.Expression): boolean => {
  const node = unwrap(expression);
  if (!ts.isCallExpression(node)) {
    return false;
  }
  const name = callName(node.expression);
  return (
    isMapLookup(node) ||
    EXTRACTION_CALLS.has(name) ||
    /^(?:parse|find|lookup)(?:[A-Z_]|$)/u.test(name)
  );
};

// Predicate roots matter: calling a date parser somewhere in a year-selection
// predicate does not turn selection into a failed-record rejection.
const isFailureFilter = (expression: ts.Expression, depth = 0): boolean => {
  if (depth >= LOCAL_HELPER_DEPTH) {
    return false;
  }
  const node = unwrap(expression);
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const operand = unwrap(node.operand);
    return (
      refersToFailure(operand) &&
      ((ts.isPropertyAccessExpression(operand) &&
        operand.name.text === "error") ||
        (ts.isCallExpression(operand) &&
          ERROR_PREDICATES.has(callName(operand.expression))))
    );
  }
  if (ts.isIdentifier(node)) {
    const value = declarationValue(node);
    return value !== undefined && isFailureFilter(value, depth + 1);
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === "success" && refersToFailure(node.expression);
  }
  if (ts.isCallExpression(node)) {
    const name = callName(node.expression);
    if (name === "Boolean") {
      const argument = node.arguments.at(0);
      return argument !== undefined && isFailureFilter(argument, depth + 1);
    }
    return isExtractionCall(node) || name === "get";
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return (
        isFailureFilter(node.left, depth + 1) ||
        isFailureFilter(node.right, depth + 1)
      );
    }
    return (
      [
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(node.operatorToken.kind) &&
      ((isAbsent(node.right) && refersToFailure(node.left)) ||
        (isAbsent(node.left) && refersToFailure(node.right)))
    );
  }
  return false;
};

type ItemSkipContext =
  | { type: "none" }
  | { type: "loop" | "filter"; failureBranch: ts.Statement | undefined };

const itemSkipContext = (node: ts.Node): ItemSkipContext => {
  let child: ts.Node = node;
  let failureBranch: ts.Statement | undefined;
  for (
    let parent = parentNode(node);
    parent;
    child = parent, parent = parentNode(parent)
  ) {
    if (ts.isCatchClause(parent)) {
      break;
    } // The catch clause owns this site.
    if (ts.isIfStatement(parent) && refersToFailure(parent.expression)) {
      const arm =
        failureArm(parent.expression) === "then"
          ? parent.thenStatement
          : parent.elseStatement;
      if (arm === child) {
        failureBranch ??= arm;
      }
    }
    if (isLoop(parent)) {
      return { type: "loop", failureBranch };
    }
    if (ts.isFunctionLike(parent)) {
      if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
        const call = parent.parent;
        if (
          ts.isCallExpression(call) &&
          ts.isPropertyAccessExpression(call.expression) &&
          call.expression.name.text === "filter"
        ) {
          return { type: "filter", failureBranch };
        }
      }
      break;
    }
  }
  return { type: "none" };
};

const isUnsignalledItemSkip = (node: ts.Node): boolean => {
  if (
    !ts.isContinueStatement(node) &&
    (!ts.isReturnStatement(node) || node.expression === undefined)
  ) {
    return false;
  }
  const context = itemSkipContext(node);
  if (context.type === "none") {
    return false;
  }
  if (
    ts.isReturnStatement(node) &&
    context.type === "filter" &&
    node.expression &&
    node.expression.kind !== ts.SyntaxKind.FalseKeyword &&
    isFailureFilter(node.expression) &&
    !hasSignal(node.expression)
  ) {
    return true;
  }
  if (context.failureBranch === undefined) {
    return false;
  }
  const dropsItem =
    (ts.isContinueStatement(node) && context.type === "loop") ||
    (ts.isReturnStatement(node) &&
      context.type === "filter" &&
      node.expression?.kind === ts.SyntaxKind.FalseKeyword);
  return dropsItem && flow(context.failureBranch).unsignalledExit;
};

type SkipSite = {
  shape: "catch-outcome" | "item-skip" | "empty-extraction-fallback";
  line: number;
};

export const unsignalledSkipSites = (
  content: string,
  { file }: { file: string },
): SkipSite[] => {
  const source = parseSource({ fileName: file, text: content });
  const allowanceLines = new Set<number>();
  const collectComments = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      if (
        range.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
        /^\/\/\s*unsignalled-skip-allow:[\t ]*\S[^\r\n]*$/u.test(
          content.slice(range.pos, range.end),
        )
      ) {
        allowanceLines.add(
          source.getLineAndCharacterOfPosition(range.pos).line,
        );
      }
    }
  };
  const collect = (node: ts.Node) => {
    collectComments(ts.getLeadingCommentRanges(content, node.pos));
    collectComments(ts.getTrailingCommentRanges(content, node.end));
    for (const child of node.getChildren(source)) {
      collect(child);
    }
  };
  collect(source);
  const siteLine = (node: ts.Node): number => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      return source.getLineAndCharacterOfPosition(
        node.expression.name.getStart(),
      ).line;
    }
    const location = ts.isBinaryExpression(node) ? node.operatorToken : node;
    return source.getLineAndCharacterOfPosition(location.getStart()).line;
  };
  const sites: SkipSite[] = [];
  const charge = (node: ts.Node, shape: SkipSite["shape"]) => {
    const line = siteLine(node);
    if (!allowanceLines.has(line)) {
      sites.push({ shape, line: line + 1 });
    }
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
        node.operatorToken.kind,
      ) &&
      isEmptyFallback(node.right) &&
      isExtractionCall(node.left)
    ) {
      charge(node, "empty-extraction-fallback");
    }
    if (ts.isCatchClause(node) && dropsWithoutSignal(node.block)) {
      charge(node, "catch-outcome");
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const argument = node.arguments.at(0);
      const callback = argument === undefined ? undefined : unwrap(argument);
      if (
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ) {
        if (
          node.expression.name.text === "catch" &&
          dropsWithoutSignal(callback.body)
        ) {
          charge(node, "catch-outcome");
        }
        if (
          node.expression.name.text === "filter" &&
          !ts.isBlock(callback.body) &&
          isFailureFilter(callback.body) &&
          !hasSignal(callback.body)
        ) {
          charge(node, "item-skip");
        }
      }
    }
    if (isUnsignalledItemSkip(node)) {
      charge(node, "item-skip");
    }
    node.forEachChild(visit);
  };
  visit(source);
  return sites;
};

export const countUnsignalledSkips = (
  content: string,
  context: { file: string },
): number => unsignalledSkipSites(content, context).length;
