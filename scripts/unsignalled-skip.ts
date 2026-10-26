import { panic } from "better-result";

import {
  type CallExpression,
  type Node,
  type ObjectProperty,
  type ParsedSource,
  type Statement,
  walk,
} from "../packages/scripts/src/syntax-tree.ts";
import { parseSyntax } from "./parse-memo";
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
  file.startsWith("packages/mcp-apps/src/") ||
  file.endsWith("/health-check.ts") ||
  file.endsWith("fixtures.ts") ||
  file.endsWith(".tsx") ||
  /\.generated\./u.test(file);

// oxc nodes carry no parent links or source; each tree is indexed once when
// it is read, and the parse memo shares trees between the ratchet's counters.
const PARENTS = new WeakMap<Node, Node>();
const SOURCES = new WeakMap<Node, ParsedSource>();
const INDEXED = new WeakSet<ParsedSource>();

const indexSource = (source: ParsedSource): void => {
  if (INDEXED.has(source)) {
    return;
  }
  INDEXED.add(source);
  walk(source.program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (parent !== undefined) {
      PARENTS.set(node, parent);
    }
    SOURCES.set(node, source);
  });
};

const parentNode = (node: Node): Node | undefined => PARENTS.get(node);

const sourceOf = (node: Node): ParsedSource =>
  SOURCES.get(node) ?? panic("Expected a node of an indexed source");

const textOf = (node: Node): string =>
  sourceOf(node).sourceText.slice(node.start, node.end);

const childNodes = (node: Node): Node[] => {
  const children: Node[] = [];
  walk(node, (child) => {
    if (child === node) {
      return undefined;
    }
    children.push(child);
    return "skip-children";
  });
  return children;
};

// Functions and the signatures that declare parameters.
const FUNCTION_LIKE = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "TSConstructorType",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
  "TSFunctionType",
  "TSMethodSignature",
]);

const isFunctionLike = (node: Node): boolean => FUNCTION_LIKE.has(node.type);

const parameterName = (parameter: Node): string | undefined => {
  if (parameter.type === "Identifier") {
    return parameter.name;
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.left.type === "Identifier"
      ? parameter.left.name
      : undefined;
  }
  if (parameter.type === "RestElement") {
    return parameter.argument.type === "Identifier"
      ? parameter.argument.name
      : undefined;
  }
  return parameter.type === "TSParameterProperty"
    ? parameterName(parameter.parameter)
    : undefined;
};

const declaresParameter = (scope: Node, name: string): boolean =>
  "params" in scope &&
  Array.isArray(scope.params) &&
  scope.params.some((parameter: Node) => parameterName(parameter) === name);

// The statements of a block or the module; others hold no declarations.
const scopeStatements = (scope: Node): readonly Node[] | undefined => {
  if (scope.type === "Program") {
    return scope.body.map((statement) =>
      (statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportDefaultDeclaration") &&
      statement.declaration !== null
        ? statement.declaration
        : statement,
    );
  }
  return scope.type === "BlockStatement" || scope.type === "StaticBlock"
    ? scope.body
    : undefined;
};

// A module statement starts at its `export` keyword.
const statementStart = (statement: Node): number => {
  const parent = parentNode(statement);
  return parent?.type === "ExportNamedDeclaration" ||
    parent?.type === "ExportDefaultDeclaration"
    ? parent.start
    : statement.start;
};

const unwrap = (node: Node): Node => {
  if (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "ChainExpression"
  ) {
    return unwrap(node.expression);
  }
  if (node.type === "AwaitExpression") {
    return unwrap(node.argument);
  }
  return node;
};

// `object.name`, as the compiler's property access: not computed.
const memberName = (node: Node): string | undefined => {
  if (node.type !== "MemberExpression" || node.computed) {
    return undefined;
  }
  return node.property.type === "PrivateIdentifier"
    ? `#${node.property.name}`
    : node.property.name;
};

const callName = (expression: Node): string => {
  const node = unwrap(expression);
  if (node.type === "Identifier") {
    return node.name;
  }
  return memberName(node) ?? "";
};

const isLiteral = (node: Node, value: boolean | null): boolean =>
  node.type === "Literal" && node.value === value;

const isStringLiteral = (node: Node): node is Node & { value: string } =>
  node.type === "Literal" && typeof node.value === "string";

// Syntax-only inventory: these names belong to the repository's observation
// helpers. No type checker or application imports run during a ratchet scan.
const SIGNAL_CALLS = new Set([
  "panic",
  "observeFailure",
  "logDocumentParseFailure",
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

// A `key: value` entry of an object literal.
const isPropertyAssignment = (property: Node): property is ObjectProperty =>
  property.type === "Property" &&
  property.kind === "init" &&
  !property.method &&
  !property.shorthand;

const propertyKeyText = (property: ObjectProperty): string => {
  if (property.computed) {
    return "";
  }
  if (property.key.type === "Identifier") {
    return property.key.name;
  }
  return isStringLiteral(property.key) ? property.key.value : "";
};

const isTypedRecord = (
  expression: Node,
  { failureCollection = false } = {},
): boolean => {
  const node = unwrap(expression);
  if (node.type !== "ObjectExpression") {
    return false;
  }
  return node.properties.some((property) => {
    if (!isPropertyAssignment(property)) {
      return false;
    }
    const name = propertyKeyText(property);
    const value = unwrap(property.value);
    return (
      (name === "ok" && isLiteral(value, false)) ||
      (["type", "status", "kind", "code", "reason"].includes(name) &&
        (isStringLiteral(value) || memberName(value) !== undefined) &&
        (failureCollection || FAILURE_DISCRIMINANT.test(textOf(value)))) ||
      (name.endsWith("Failures") && value.type === "ObjectExpression")
    );
  });
};

const declarationValue = (identifier: Node & { name: string }) => {
  for (
    let scope: Node | undefined = parentNode(identifier);
    scope;
    scope = parentNode(scope)
  ) {
    if (isFunctionLike(scope) && declaresParameter(scope, identifier.name)) {
      return undefined;
    }
    const statements = scopeStatements(scope);
    if (statements === undefined) {
      continue;
    }
    for (const statement of statements.toReversed()) {
      if (
        statementStart(statement) >= identifier.start ||
        statement.type !== "VariableDeclaration"
      ) {
        continue;
      }
      for (const declaration of statement.declarations) {
        if (
          declaration.id.type === "Identifier" &&
          declaration.id.name === identifier.name
        ) {
          return declaration.init ?? undefined;
        }
      }
    }
  }
  return undefined;
};

const localFunctionBody = (
  identifier: Node & { name: string },
): Node | undefined => {
  const value = declarationValue(identifier);
  if (
    value &&
    (value.type === "ArrowFunctionExpression" ||
      value.type === "FunctionExpression")
  ) {
    return value.body ?? undefined;
  }
  for (
    let scope: Node | undefined = parentNode(identifier);
    scope;
    scope = parentNode(scope)
  ) {
    if (isFunctionLike(scope) && declaresParameter(scope, identifier.name)) {
      return undefined;
    }
    for (const statement of scopeStatements(scope) ?? []) {
      // An overload signature comes first and has no body.
      if (
        (statement.type === "FunctionDeclaration" ||
          statement.type === "TSDeclareFunction") &&
        statement.id?.name === identifier.name
      ) {
        return statement.body ?? undefined;
      }
    }
  }
  return undefined;
};

const LOCAL_HELPER_DEPTH = 4;

const importsSignal = (callee: Node & { name: string }): boolean =>
  sourceOf(callee).program.body.some(
    (statement) =>
      statement.type === "ImportDeclaration" &&
      statement.specifiers.some((binding) => {
        if (
          binding.type !== "ImportSpecifier" ||
          binding.local.name !== callee.name
        ) {
          return false;
        }
        const imported =
          binding.imported.type === "Identifier"
            ? binding.imported.name
            : binding.imported.value;
        return SIGNAL_CALLS.has(imported);
      }),
  );

function isSignalCall(node: CallExpression, depth: number): boolean {
  const callee = unwrap(node.callee);
  if (SIGNAL_CALLS.has(callName(callee))) {
    return true;
  }
  if (callee.type === "Identifier" && importsSignal(callee)) {
    return true;
  }
  if (callee.type === "Identifier" && depth < LOCAL_HELPER_DEPTH) {
    const body = localFunctionBody(callee);
    if (body && !dropsWithoutSignal(body, depth + 1, "observe")) {
      return true;
    }
  }
  const name = memberName(callee);
  if (callee.type !== "MemberExpression" || name === undefined) {
    return false;
  }
  const receiver = textOf(callee.object);
  return (
    (LOG_METHODS.has(name) && /(?:logger|log|console)$/iu.test(receiver)) ||
    (METRIC_METHODS.has(name) &&
      /(?:metric|counter|skip|reject|fail)/iu.test(receiver)) ||
    (name === "push" &&
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

const isResultCall = (callee: Node, methods: ReadonlySet<string>): boolean =>
  callee.type === "MemberExpression" &&
  methods.has(memberName(callee) ?? "") &&
  textOf(callee.object) === "Result";

function isTypedOutcomeCall(node: CallExpression, depth: number): boolean {
  const callee = unwrap(node.callee);
  if (isResultCall(callee, TYPED_OUTCOME_METHODS)) {
    return true;
  }
  if (callee.type !== "Identifier" || depth >= LOCAL_HELPER_DEPTH) {
    return false;
  }
  const body = localFunctionBody(callee);
  return body !== undefined && !dropsWithoutSignal(body, depth + 1, "outcome");
}

const COUNTER_TEXT = /(?:skip|reject|fail|counter)/iu;

function hasSignal(node: Node, depth = 0): boolean {
  if (isFunctionLike(node)) {
    return false;
  }
  if (node.type === "ConditionalExpression") {
    return (
      hasSignal(node.test, depth) ||
      (hasSignal(node.consequent, depth) && hasSignal(node.alternate, depth))
    );
  }
  if (node.type === "LogicalExpression") {
    return hasSignal(node.left, depth);
  }
  if (
    node.type === "CallExpression" &&
    (node.optional ||
      (node.callee.type === "MemberExpression" && node.callee.optional))
  ) {
    return false;
  }
  if (node.type === "CallExpression" && isSignalCall(node, depth)) {
    return true;
  }
  if (
    node.type === "UpdateExpression" &&
    COUNTER_TEXT.test(textOf(node.argument))
  ) {
    return true;
  }
  // Assigning a typed outcome hands it on to the enclosing code.
  if (
    node.type === "AssignmentExpression" &&
    node.operator === "=" &&
    isTypedReturn(node.right, depth)
  ) {
    return true;
  }
  if (
    node.type === "AssignmentExpression" &&
    node.operator === "+=" &&
    COUNTER_TEXT.test(textOf(node.left))
  ) {
    return true;
  }
  return childNodes(node).some((child) => hasSignal(child, depth));
}

function isTypedReturn(expression: Node, depth = 0): boolean {
  const node = unwrap(expression);
  if (isTypedRecord(node)) {
    return true;
  }
  if (node.type === "ConditionalExpression") {
    return (
      isTypedReturn(node.consequent, depth) &&
      isTypedReturn(node.alternate, depth)
    );
  }
  if (node.type === "CallExpression") {
    return isTypedOutcomeCall(node, depth) || hasSignal(node, depth);
  }
  if (node.type === "Identifier" && depth < LOCAL_HELPER_DEPTH) {
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
  statements: readonly Statement[],
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
  statement: Node,
  {
    signalled = false,
    depth = 0,
    mode = "outcome",
    inSwitch = false,
  }: FlowOptions = {},
): Flow {
  const options = { signalled, depth, mode, inSwitch };
  if (statement.type === "BlockStatement") {
    return flowSequence(statement.body, options);
  }
  if (statement.type === "IfStatement") {
    const state = signalled || hasSignal(statement.test, depth);
    const yes = flow(statement.consequent, { ...options, signalled: state });
    const no =
      statement.alternate === null
        ? { live: [state], unsignalledExit: false, switchExits: [] }
        : flow(statement.alternate, { ...options, signalled: state });
    return {
      live: unique([...yes.live, ...no.live]),
      unsignalledExit: yes.unsignalledExit || no.unsignalledExit,
      switchExits: unique([...yes.switchExits, ...no.switchExits]),
    };
  }
  if (statement.type === "ThrowStatement") {
    return { live: [], unsignalledExit: false, switchExits: [] };
  }
  if (statement.type === "SwitchStatement") {
    // Case fallthrough is conservative: a case must carry its own signal.
    const outcomes = statement.cases.map((clause) =>
      flowSequence(clause.consequent, { ...options, inSwitch: true }),
    );
    if (!statement.cases.some((clause) => clause.test === null)) {
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
  if (statement.type === "ReturnStatement") {
    return {
      live: [],
      unsignalledExit:
        !signalled &&
        (statement.argument === null ||
          (mode === "observe"
            ? !hasSignal(statement.argument, depth)
            : !isTypedReturn(statement.argument, depth))),
      switchExits: [],
    };
  }
  if (
    statement.type === "BreakStatement" &&
    statement.label === null &&
    inSwitch
  ) {
    return { live: [], unsignalledExit: false, switchExits: [signalled] };
  }
  if (
    statement.type === "ContinueStatement" ||
    statement.type === "BreakStatement"
  ) {
    return { live: [], unsignalledExit: !signalled, switchExits: [] };
  }
  // Signals within control structures are conditional. Only direct statements
  // establish observation for the following statement.
  const observed =
    statement.type === "ExpressionStatement" ||
    statement.type === "VariableDeclaration"
      ? hasSignal(statement, depth)
      : false;
  return {
    live: [signalled || observed],
    unsignalledExit: false,
    switchExits: [],
  };
}

function dropsWithoutSignal(
  body: Node,
  depth = 0,
  mode: FlowMode = "outcome",
): boolean {
  if (body.type !== "BlockStatement") {
    const expression = unwrap(body);
    return mode === "observe"
      ? !hasSignal(expression, depth)
      : !isTypedReturn(expression, depth);
  }
  const result = flow(body, { depth, mode });
  return result.unsignalledExit || result.live.includes(false);
}

const isLoop = (node: Node): boolean =>
  node.type === "ForOfStatement" ||
  node.type === "ForInStatement" ||
  node.type === "ForStatement" ||
  node.type === "WhileStatement" ||
  node.type === "DoWhileStatement";

const LOOKUP_OR_PARSE =
  /^(?:(?:parse|safeParse|decode|lookup|find)(?:[A-Z_]|$)|get$|exec$|match$|valueAtPath$|fieldOf$|asString$|sentenceHeadPattern$|extractId$)/u;
const RESULT_CAPTURES = new Set(["try", "tryPromise"]);

const isLookupOrParse = (node: Node): boolean => {
  if (isFunctionLike(node)) {
    return false;
  }
  if (
    node.type === "CallExpression" &&
    (isResultCall(node.callee, RESULT_CAPTURES) ||
      LOOKUP_OR_PARSE.test(callName(node.callee)))
  ) {
    return true;
  }
  return childNodes(node).some(isLookupOrParse);
};

// Resolve only preceding declarations in enclosing blocks; unrelated functions
// and shadowed names cannot supply a parse/lookup origin.

const refersToFailure = (node: Node, seen = new Set<Node>()): boolean => {
  if (isFunctionLike(node)) {
    return false;
  }
  if (seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (isLookupOrParse(node)) {
    return true;
  }
  if (node.type === "Identifier") {
    const parent = parentNode(node);
    if (
      (parent?.type === "CallExpression" && parent.callee === node) ||
      (parent?.type === "MemberExpression" &&
        !parent.computed &&
        parent.property === node)
    ) {
      return false;
    }
    const value = declarationValue(node);
    return (
      value !== undefined &&
      (isLookupOrParse(value) || refersToFailure(value, seen))
    );
  }
  return childNodes(node).some((child) => refersToFailure(child, seen));
};

const ERROR_PREDICATES = new Set(["isErr", "isError", "isFailure"]);

const isAbsent = (node: Node): boolean => {
  const value = unwrap(node);
  return (
    isLiteral(value, null) ||
    (value.type === "Identifier" && value.name === "undefined") ||
    (value.type === "UnaryExpression" && value.operator === "void")
  );
};

const isNegation = (
  node: Node,
): node is Node & { type: "UnaryExpression"; argument: Node } =>
  node.type === "UnaryExpression" && node.operator === "!";

const failureArm = (expression: Node): "then" | "else" => {
  const node = unwrap(expression);
  if (
    node.type === "CallExpression" &&
    ERROR_PREDICATES.has(callName(node.callee))
  ) {
    return "then";
  }
  if (isNegation(node)) {
    return failureArm(node.argument) === "then" ? "else" : "then";
  }
  if (
    node.type === "LogicalExpression" &&
    (node.operator === "&&" || node.operator === "||")
  ) {
    if (refersToFailure(node.left)) {
      return failureArm(node.left);
    }
    if (refersToFailure(node.right)) {
      return failureArm(node.right);
    }
  }
  if (node.type === "BinaryExpression") {
    const equality = node.operator === "==" || node.operator === "===";
    const inequality = node.operator === "!=" || node.operator === "!==";
    if (equality || inequality) {
      if (isAbsent(node.left) || isAbsent(node.right)) {
        return equality ? "then" : "else";
      }
      // Equality is symmetric: the boolean literal may sit on either side.
      const sides = [node.left, node.right];
      if (sides.some((side) => isLiteral(side, false))) {
        return equality ? "then" : "else";
      }
      if (sides.some((side) => isLiteral(side, true))) {
        return equality ? "else" : "then";
      }
    }
  }
  if (["error", "isError"].includes(memberName(node) ?? "")) {
    return "then";
  }
  return "else";
};

const isEmptyFallback = (node: Node): boolean => {
  const value = unwrap(node);
  return (
    (isStringLiteral(value) && value.value === "") ||
    (value.type === "ArrayExpression" && value.elements.length === 0) ||
    (value.type === "ObjectExpression" && value.properties.length === 0)
  );
};

const EXTRACTION_CALLS = new Set([
  "valueAtPath",
  "asString",
  "fieldOf",
  "sentenceHeadPattern",
  "extractId",
]);

const isMapLookup = (node: CallExpression): boolean => {
  const { callee } = node;
  if (
    callee.type !== "MemberExpression" ||
    !["get", "has"].includes(memberName(callee) ?? "")
  ) {
    return false;
  }
  const receiver = unwrap(callee.object);
  const value =
    receiver.type === "Identifier" ? declarationValue(receiver) : receiver;
  if (value === undefined) {
    return false;
  }
  const constructor = unwrap(value);
  return (
    constructor.type === "NewExpression" &&
    callName(constructor.callee) === "Map"
  );
};

const isExtractionCall = (expression: Node): boolean => {
  const node = unwrap(expression);
  if (node.type !== "CallExpression") {
    return false;
  }
  const name = callName(node.callee);
  return (
    isMapLookup(node) ||
    EXTRACTION_CALLS.has(name) ||
    /^(?:parse|find|lookup)(?:[A-Z_]|$)/u.test(name)
  );
};

// Predicate roots matter: calling a date parser somewhere in a year-selection
// predicate does not turn selection into a failed-record rejection.
const isFailureFilter = (expression: Node, depth = 0): boolean => {
  if (depth >= LOCAL_HELPER_DEPTH) {
    return false;
  }
  const node = unwrap(expression);
  if (isNegation(node)) {
    const operand = unwrap(node.argument);
    return (
      refersToFailure(operand) &&
      (memberName(operand) === "error" ||
        (operand.type === "CallExpression" &&
          ERROR_PREDICATES.has(callName(operand.callee))))
    );
  }
  if (node.type === "Identifier") {
    const value = declarationValue(node);
    return value !== undefined && isFailureFilter(value, depth + 1);
  }
  if (node.type === "MemberExpression" && memberName(node) !== undefined) {
    return memberName(node) === "success" && refersToFailure(node.object);
  }
  if (node.type === "CallExpression") {
    const name = callName(node.callee);
    if (name === "Boolean") {
      const argument = node.arguments.at(0);
      return argument !== undefined && isFailureFilter(argument, depth + 1);
    }
    return isExtractionCall(node) || name === "get";
  }
  if (node.type === "LogicalExpression" && node.operator === "&&") {
    return (
      isFailureFilter(node.left, depth + 1) ||
      isFailureFilter(node.right, depth + 1)
    );
  }
  return (
    node.type === "BinaryExpression" &&
    (node.operator === "!=" || node.operator === "!==") &&
    ((isAbsent(node.right) && refersToFailure(node.left)) ||
      (isAbsent(node.left) && refersToFailure(node.right)))
  );
};

type ItemSkipContext =
  | { type: "none" }
  | { type: "loop" | "filter"; failureBranch: Node | undefined };

const itemSkipContext = (node: Node): ItemSkipContext => {
  let child: Node = node;
  let failureBranch: Node | undefined;
  for (
    let parent = parentNode(node);
    parent;
    child = parent, parent = parentNode(parent)
  ) {
    if (parent.type === "CatchClause") {
      break;
    } // The catch clause owns this site.
    if (parent.type === "IfStatement" && refersToFailure(parent.test)) {
      const arm =
        failureArm(parent.test) === "then"
          ? parent.consequent
          : (parent.alternate ?? undefined);
      if (arm === child) {
        failureBranch ??= arm;
      }
    }
    if (isLoop(parent)) {
      return { type: "loop", failureBranch };
    }
    if (isFunctionLike(parent)) {
      if (
        parent.type === "ArrowFunctionExpression" ||
        parent.type === "FunctionExpression"
      ) {
        const call = parentNode(parent);
        if (
          call?.type === "CallExpression" &&
          memberName(call.callee) === "filter"
        ) {
          return { type: "filter", failureBranch };
        }
      }
      break;
    }
  }
  return { type: "none" };
};

const isUnsignalledItemSkip = (node: Node): boolean => {
  if (
    node.type !== "ContinueStatement" &&
    (node.type !== "ReturnStatement" || node.argument === null)
  ) {
    return false;
  }
  const context = itemSkipContext(node);
  if (context.type === "none") {
    return false;
  }
  if (
    node.type === "ReturnStatement" &&
    context.type === "filter" &&
    node.argument !== null &&
    !isLiteral(node.argument, false) &&
    isFailureFilter(node.argument) &&
    !hasSignal(node.argument)
  ) {
    return true;
  }
  if (context.failureBranch === undefined) {
    return false;
  }
  const dropsItem =
    (node.type === "ContinueStatement" && context.type === "loop") ||
    (node.type === "ReturnStatement" &&
      context.type === "filter" &&
      node.argument !== null &&
      isLiteral(node.argument, false));
  return dropsItem && flow(context.failureBranch).unsignalledExit;
};

type SkipSite = {
  shape: "catch-outcome" | "item-skip" | "empty-extraction-fallback";
  line: number;
};

const ALLOWANCE = /^\/\/\s*unsignalled-skip-allow:[\t ]*\S[^\r\n]*$/u;

// The operator between a logical expression's operands, past any comments.
const operatorStart = (
  source: ParsedSource,
  node: Node & { left: Node; right: Node; operator: string },
): number => {
  for (
    let index = source.sourceText.indexOf(node.operator, node.left.end);
    index !== -1 && index < node.right.start;
    index = source.sourceText.indexOf(node.operator, index + 1)
  ) {
    if (
      !source.comments.some(
        (comment) => comment.start <= index && index < comment.end,
      )
    ) {
      return index;
    }
  }
  return node.start;
};

export const unsignalledSkipSites = (
  content: string,
  { file }: { file: string },
): SkipSite[] => {
  const source = parseSyntax({ fileName: file, text: content });
  indexSource(source);
  // 0-based lines, as the sites are charged.
  const lineOf = (offset: number) => source.locate(offset).line - 1;
  const allowanceLines = new Set(
    source.comments
      .filter(
        (comment) =>
          comment.type === "Line" &&
          ALLOWANCE.test(content.slice(comment.start, comment.end)),
      )
      .map((comment) => lineOf(comment.start)),
  );
  const siteLine = (node: Node): number => {
    if (
      node.type === "CallExpression" &&
      memberName(node.callee) !== undefined
    ) {
      return node.callee.type === "MemberExpression"
        ? lineOf(node.callee.property.start)
        : lineOf(node.start);
    }
    return node.type === "LogicalExpression"
      ? lineOf(operatorStart(source, node))
      : lineOf(node.start);
  };
  const sites: SkipSite[] = [];
  const charge = (node: Node, shape: SkipSite["shape"]) => {
    const line = siteLine(node);
    if (!allowanceLines.has(line)) {
      sites.push({ shape, line: line + 1 });
    }
  };
  walk(source.program, (node) => {
    if (
      node.type === "LogicalExpression" &&
      (node.operator === "??" || node.operator === "||") &&
      isEmptyFallback(node.right) &&
      isExtractionCall(node.left)
    ) {
      charge(node, "empty-extraction-fallback");
    }
    if (node.type === "CatchClause" && dropsWithoutSignal(node.body)) {
      charge(node, "catch-outcome");
    }
    const method =
      node.type === "CallExpression" ? memberName(node.callee) : undefined;
    if (node.type === "CallExpression" && method !== undefined) {
      const argument = node.arguments.at(0);
      const callback = argument === undefined ? undefined : unwrap(argument);
      if (
        callback?.type === "ArrowFunctionExpression" ||
        callback?.type === "FunctionExpression"
      ) {
        const { body } = callback;
        if (method === "catch" && body !== null && dropsWithoutSignal(body)) {
          charge(node, "catch-outcome");
        }
        if (
          method === "filter" &&
          body !== null &&
          body.type !== "BlockStatement" &&
          isFailureFilter(body) &&
          !hasSignal(body)
        ) {
          charge(node, "item-skip");
        }
      }
    }
    if (isUnsignalledItemSkip(node)) {
      charge(node, "item-skip");
    }
  });
  return sites;
};

export const countUnsignalledSkips = (
  content: string,
  context: { file: string },
): number => unsignalledSkipSites(content, context).length;
