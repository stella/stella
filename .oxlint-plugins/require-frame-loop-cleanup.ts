// Require frame loops and interval timers to stop when their owner goes away.
//
// A `setInterval` timer, and a `requestAnimationFrame` callback that schedules
// itself again, keep running until something cancels them. When the component
// or helper that started one unmounts without cancelling, the loop keeps
// calling into detached state on every tick; when a frame loop reschedules
// unconditionally, it renders every frame even while nothing changes.
//
// Flagged (`unownedLoop`):
//   - A `setInterval(...)` whose handle is discarded, or never passed to
//     `clearInterval` outside the timer's own callback. A clear inside the
//     callback is a stop condition, not an owner cancel.
//   - A self-scheduling `requestAnimationFrame` loop (the callback is the
//     enclosing function, or an inline function that calls it) whose handle
//     is discarded or never passed to `cancelAnimationFrame` outside the loop.
//   - Either loop started inside an effect callback (`useMountEffect`,
//     `useExternalSyncEffect`, `useLayoutEffect`, `useInsertionEffect`,
//     `useEffect`) whose only cancel is outside that effect's returned
//     cleanup, so unmount does not stop it.
//
// Flagged (`idleFrameLoop`):
//   - A frame loop whose reschedule is unconditional: no branch, early return
//     or loop guard decides whether another frame is needed.
//
// Accepted:
//   - One-shot `requestAnimationFrame` deferrals (the callback never
//     reschedules); they finish within one frame.
//   - Bounded retries: a frame loop whose reschedule is guarded by a
//     comparison against a counter the loop itself advances
//     (`attempts += 1; if (attempts < 10) requestAnimationFrame(read)`). The
//     loop ends on its own within a fixed number of frames.
//   - A handle returned to the caller or passed to another function, which
//     transfers ownership (a factory returning `stop`, an `onFrame(frame)`
//     callback storing it in a ref).
//   - A handle held in a member (`frameRef.current = ...`) and cancelled
//     through the same member anywhere outside the loop.
//
// Global functions resolve by binding: a local `setInterval` or a shadowed
// `window` is not the browser API. One-shot timers (`setTimeout`) and loops
// driven by `await` are outside this rule.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Variable } from "@oxlint/plugins";

import {
  everyNode,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isSingleAssignment,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode, ScopeContext } from "./utils.ts";

const RULE_NAME = "require-frame-loop-cleanup";

const GLOBAL_HOSTS = new Set(["globalThis", "self", "window"]);
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);
const EFFECT_HOOKS = new Set([
  "useEffect",
  "useExternalSyncEffect",
  "useInsertionEffect",
  "useLayoutEffect",
  "useMountEffect",
]);
const VALUE_WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);
const CONDITIONAL_PARENTS = new Set([
  "CatchClause",
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "SwitchCase",
  "WhileStatement",
]);

type LoopKind = "frame" | "interval";

const START_NAMES: Record<LoopKind, string> = {
  frame: "requestAnimationFrame",
  interval: "setInterval",
};
const CANCEL_NAMES: Record<LoopKind, string> = {
  frame: "cancelAnimationFrame",
  interval: "clearInterval",
};

type Handle =
  | { kind: "binding"; variable: Variable }
  | { kind: "member"; text: string; rootVariable: Variable }
  | {
      kind: "transferred";
      transfer: "using" | "closed" | "argument" | "returned";
    };

type Cancel = { argument: AstNode | null; node: AstNode };

const parentOf = (node: AstNode): AstNode | null =>
  isAstNode(node.parent) ? node.parent : null;

const isFunctionNode = (node: unknown): node is AstNode =>
  isAstNode(node) && FUNCTION_TYPES.has(node.type);

const callArguments = (call: AstNode): unknown[] =>
  Array.isArray(call.arguments) ? call.arguments : [];

// Whether `node` lies inside `ancestor` (or is it).
const isWithin = (node: AstNode, ancestor: AstNode): boolean => {
  let current: AstNode | null = node;
  while (current !== null) {
    if (current === ancestor) {
      return true;
    }
    current = parentOf(current);
  }
  return false;
};

const enclosingFunctions = (node: AstNode): AstNode[] => {
  const functions: AstNode[] = [];
  let current = parentOf(node);
  while (current !== null) {
    if (isFunctionNode(current)) {
      functions.push(current);
    }
    current = parentOf(current);
  }
  return functions;
};

// Inline and named hook callbacks share one resolved ownership boundary.
const enclosingEffect = (
  context: LoopContext,
  node: AstNode,
): AstNode | null => {
  for (const candidate of enclosingFunctions(node)) {
    if (context.effectCallbacks.has(candidate)) {
      return candidate;
    }
  }
  return null;
};

// Statements before `node` in each enclosing block, up to `boundary`, that
// can leave the function early (a guard before the reschedule).
const precedingExits = (node: AstNode, boundary: AstNode): AstNode[] => {
  const guards: AstNode[] = [];
  let current = node;
  let parent = parentOf(current);
  while (parent !== null && current !== boundary) {
    if (
      (parent.type === "BlockStatement" || parent.type === "Program") &&
      Array.isArray(parent.body)
    ) {
      const index = parent.body.indexOf(current);
      for (const statement of parent.body.slice(0, Math.max(index, 0))) {
        if (exitsEarly(statement)) {
          guards.push(statement);
        }
      }
    }
    if (parent === boundary) {
      break;
    }
    current = parent;
    parent = parentOf(current);
  }
  return guards;
};

const exitsEarly = (statement: unknown): boolean => {
  const pending: unknown[] = [statement];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!isAstNode(current) || FUNCTION_TYPES.has(current.type)) {
      continue;
    }
    if (
      current.type === "ReturnStatement" ||
      current.type === "ThrowStatement"
    ) {
      return true;
    }
    for (const [key, value] of Object.entries(current)) {
      if (key !== "parent" && typeof value === "object") {
        pending.push(...(Array.isArray(value) ? value : [value]));
      }
    }
  }
  return false;
};

// The guard expressions a reschedule depends on inside `loop`, or an empty
// list when it runs unconditionally on every frame.
type Guard = { expression: AstNode; outcome: "truthy" | "falsy" };

const alwaysExits = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (node.type === "ReturnStatement" || node.type === "ThrowStatement") {
    return true;
  }
  if (node.type === "BlockStatement" && Array.isArray(node.body)) {
    return node.body.some(alwaysExits);
  }
  return (
    node.type === "IfStatement" &&
    alwaysExits(node.consequent) &&
    alwaysExits(node.alternate)
  );
};

const rescheduleGuards = (call: AstNode, loop: AstNode): Guard[] | null => {
  const guards: Guard[] = [];
  let conditional = false;
  let current = call;
  let parent = parentOf(current);
  while (parent !== null && current !== loop) {
    if (parent.type === "IfStatement" && parent.test !== current) {
      conditional = true;
      if (isAstNode(parent.test)) {
        guards.push({
          expression: parent.test,
          outcome: parent.consequent === current ? "truthy" : "falsy",
        });
      }
    } else if (
      parent.type === "ConditionalExpression" &&
      parent.test !== current
    ) {
      conditional = true;
      if (isAstNode(parent.test)) {
        guards.push({
          expression: parent.test,
          outcome: parent.consequent === current ? "truthy" : "falsy",
        });
      }
    } else if (
      parent.type === "LogicalExpression" &&
      parent.right === current
    ) {
      conditional = true;
      if (
        isAstNode(parent.left) &&
        (parent.operator === "&&" || parent.operator === "||")
      ) {
        guards.push({
          expression: parent.left,
          outcome: parent.operator === "&&" ? "truthy" : "falsy",
        });
      }
    } else if (CONDITIONAL_PARENTS.has(parent.type)) {
      conditional = true;
    }
    if (parent === loop) {
      break;
    }
    current = parent;
    parent = parentOf(current);
  }
  for (const exit of precedingExits(call, loop)) {
    conditional = true;
    if (exit.type === "IfStatement" && isAstNode(exit.test)) {
      if (alwaysExits(exit.consequent)) {
        guards.push({ expression: exit.test, outcome: "falsy" });
      }
      if (alwaysExits(exit.alternate)) {
        guards.push({ expression: exit.test, outcome: "truthy" });
      }
    }
  }
  return conditional ? guards : null;
};

type LoopContext = ScopeContext & {
  sourceCode: { text: string };
  effectCallbacks: ReadonlySet<AstNode>;
  effectRegistrations: ReadonlyMap<AstNode, AstNode>;
  functionCallers: ReadonlyMap<AstNode, ReadonlySet<AstNode>>;
  reachingFunctions: Map<AstNode, ReadonlySet<AstNode>>;
};

type LoopStart = { kind: LoopKind; node: AstNode };

type LoopCalls = {
  invocations: AstNode[];
  effectInvocations: AstNode[];
  cancels: Record<LoopKind, Cancel[]>;
  starts: LoopStart[];
};

type Report = {
  kind: LoopKind;
  messageId: "idleFrameLoop" | "unownedLoop";
  node: AstNode;
};

const isGlobalName = (
  context: LoopContext,
  node: unknown,
  name: string,
): boolean => {
  if (!isIdentifierReference(node) || node.name !== name) {
    return false;
  }
  const variable = resolveVariable(context, node);
  return variable === null || variable.defs.length === 0;
};

// `fn(...)`, `window.fn(...)`, `globalThis.fn(...)`, `self.fn(...)`.
const isGlobalCall = (
  context: LoopContext,
  call: AstNode,
  name: string,
): boolean => {
  const callee = unwrapExpression(call.callee);
  if (callee === null) {
    return false;
  }
  if (isIdentifier(callee)) {
    return isGlobalName(context, callee, name);
  }
  if (
    callee.type !== "MemberExpression" ||
    callee.computed === true ||
    getPropertyName(callee.property) !== name
  ) {
    return false;
  }
  const host = unwrapExpression(callee.object);
  return (
    isIdentifier(host) &&
    GLOBAL_HOSTS.has(host.name) &&
    isGlobalName(context, host, host.name)
  );
};

const sourceText = (context: LoopContext, node: AstNode): string =>
  context.sourceCode.text
    .slice(node.range[0], node.range[1])
    .replaceAll(/\s+/gu, "");

// The function a callback expression names: an inline function, a function
// declaration, or a never-reassigned function binding.
const functionFor = (context: LoopContext, node: unknown): AstNode | null => {
  let expression = unwrapExpression(node);
  const visited = new Set<Variable>();
  while (expression !== null) {
    if (FUNCTION_TYPES.has(expression.type)) {
      return expression;
    }
    if (!isIdentifierReference(expression)) {
      return null;
    }
    const variable = resolveVariable(context, expression);
    if (
      variable === null ||
      visited.has(variable) ||
      !isSingleAssignment(variable)
    ) {
      return null;
    }
    visited.add(variable);
    const definition = variable.defs.at(0);
    if (
      variable.defs.length === 1 &&
      definition?.type === "FunctionName" &&
      isFunctionNode(definition.node)
    ) {
      return definition.node;
    }
    expression = unwrapExpression(stableInitializer(variable));
  }
  return null;
};

const effectCallbackFor = (context: LoopContext, call: AstNode) => {
  const callee = unwrapExpression(call.callee);
  const name = isIdentifier(callee)
    ? callee.name
    : callee?.type === "MemberExpression"
      ? getPropertyName(callee.property)
      : null;
  return name !== null && EFFECT_HOOKS.has(name)
    ? functionFor(context, callArguments(call).at(0))
    : null;
};

// The function a named call invokes, or null for any other call.
const namedCallTarget = (
  context: LoopContext,
  node: AstNode,
): AstNode | null =>
  node.type === "CallExpression" && isIdentifier(unwrapExpression(node.callee))
    ? functionFor(context, node.callee)
    : null;

const startupTarget = (context: LoopContext, invocation: AstNode) =>
  context.effectRegistrations.get(invocation) ??
  namedCallTarget(context, invocation);

const indexFunctionCallers = (
  context: LoopContext,
  invocations: readonly AstNode[],
): Map<AstNode, Set<AstNode>> => {
  const callers = new Map<AstNode, Set<AstNode>>();
  for (const invocation of invocations) {
    const owner = enclosingFunctions(invocation).at(0);
    const target = startupTarget(context, invocation);
    if (owner === undefined || target === null) {
      continue;
    }
    const incoming = callers.get(target) ?? new Set<AstNode>();
    incoming.add(owner);
    callers.set(target, incoming);
  }
  return callers;
};

// Reachability only prunes unrelated calls; ownership still needs the bounded
// execution-path proof. Each function enters this reverse walk at most once.
const functionsReaching = (context: LoopContext, target: AstNode) => {
  const cached = context.reachingFunctions.get(target);
  if (cached !== undefined) {
    return cached;
  }
  const reachable = new Set([target]);
  const pending = [target];
  for (const current of pending) {
    for (const caller of context.functionCallers.get(current) ?? []) {
      if (!reachable.has(caller)) {
        reachable.add(caller);
        pending.push(caller);
      }
    }
  }
  context.reachingFunctions.set(target, reachable);
  return reachable;
};

const directFunctionCalls = (callback: AstNode): AstNode[] =>
  everyNode(callback).filter(
    (node) =>
      node.type === "CallExpression" &&
      enclosingFunctions(node).at(0) === callback,
  );

// The enclosing function a frame callback re-enters, if any.
const frameLoopFunction = (
  context: LoopContext,
  call: AstNode,
): AstNode | null => {
  const callback = callArguments(call).at(0);
  const named = functionFor(context, callback);
  const enclosing = enclosingFunctions(call);
  if (named !== null && enclosing.includes(named)) {
    return named;
  }
  const inline = unwrapExpression(callback);
  if (!isFunctionNode(inline)) {
    return null;
  }
  const called = new Set(
    directFunctionCalls(inline).map((node) => namedCallTarget(context, node)),
  );
  return enclosing.find((candidate) => called.has(candidate)) ?? null;
};

// A handle handed to another function transfers ownership only when that
// handoff executes. A reference inside a dormant closure does not own it.
const bindingTransfers = (context: LoopContext, variable: Variable): Cancel[] =>
  variable.references.flatMap((reference) => {
    const identifier: unknown = reference.identifier;
    if (!isAstNode(identifier)) {
      return [];
    }
    const parent = parentOf(identifier);
    return parent?.type === "ReturnStatement" ||
      (parent?.type === "CallExpression" &&
        callArguments(parent).includes(identifier) &&
        !isGlobalCall(context, parent, CANCEL_NAMES.frame) &&
        !isGlobalCall(context, parent, CANCEL_NAMES.interval))
      ? [{ argument: identifier, node: parent }]
      : [];
  });

const memberRootVariable = (context: LoopContext, member: AstNode) => {
  let root: AstNode | null = member;
  while (root?.type === "MemberExpression") {
    root = unwrapExpression(root.object);
  }
  return isIdentifierReference(root) ? resolveVariable(context, root) : null;
};

const assignedHandle = (
  context: LoopContext,
  target: AstNode | null,
): Handle | null => {
  if (isIdentifierReference(target)) {
    const variable = resolveVariable(context, target);
    return variable === null ? null : { kind: "binding", variable };
  }
  if (
    target?.type !== "MemberExpression" ||
    target.computed === true ||
    !isIdentifierReference(unwrapExpression(target.object))
  ) {
    return null;
  }
  const rootVariable = memberRootVariable(context, target);
  if (
    rootVariable === null ||
    !isSingleAssignment(rootVariable) ||
    rootVariable.references.some((reference) => {
      const identifier: unknown = reference.identifier;
      if (!isAstNode(identifier)) {
        return true;
      }
      if (reference.init && reference.isWrite()) {
        return false;
      }
      const parent = parentOf(identifier);
      return (
        parent?.type !== "MemberExpression" || parent.object !== identifier
      );
    })
  ) {
    return null;
  }
  return { kind: "member", text: sourceText(context, target), rootVariable };
};

const handleOf = (context: LoopContext, call: AstNode): Handle | null => {
  let current = call;
  let parent = parentOf(current);
  while (parent !== null && VALUE_WRAPPERS.has(parent.type)) {
    current = parent;
    parent = parentOf(current);
  }
  if (parent === null) {
    return null;
  }
  if (parent.type === "VariableDeclarator" && parent.init === current) {
    const declaration = parentOf(parent);
    if (
      declaration?.type === "VariableDeclaration" &&
      (declaration.kind === "using" || declaration.kind === "await using") &&
      isGlobalCall(context, call, START_NAMES.interval)
    ) {
      return { kind: "transferred", transfer: "using" };
    }
    return assignedHandle(context, unwrapExpression(parent.id));
  }
  if (
    parent.type === "AssignmentExpression" &&
    parent.operator === "=" &&
    parent.right === current
  ) {
    return assignedHandle(context, unwrapExpression(parent.left));
  }
  // Bun/Node timer handles can also be closed immediately at creation.
  const closeCall = parentOf(parent);
  if (
    parent.type === "MemberExpression" &&
    parent.computed !== true &&
    parent.optional !== true &&
    parent.object === current &&
    getPropertyName(parent.property) === "close" &&
    closeCall?.type === "CallExpression" &&
    closeCall.optional !== true &&
    closeCall.callee === parent &&
    callArguments(closeCall).length === 0
  ) {
    return { kind: "transferred", transfer: "closed" };
  }
  const handedOver =
    parent.type === "ReturnStatement" ||
    (parent.type === "ArrowFunctionExpression" && parent.body === current) ||
    (parent.type === "CallExpression" &&
      callArguments(parent).includes(current));
  return handedOver
    ? {
        kind: "transferred",
        transfer: parent.type === "CallExpression" ? "argument" : "returned",
      }
    : null;
};

const cancelsHandle = (
  context: LoopContext,
  cancel: Cancel,
  handle: Handle,
): boolean => {
  const argument = unwrapExpression(cancel.argument);
  if (argument === null) {
    return false;
  }
  if (handle.kind === "binding") {
    return (
      isIdentifierReference(argument) &&
      resolveVariable(context, argument) === handle.variable
    );
  }
  return (
    handle.kind === "member" &&
    argument.type === "MemberExpression" &&
    sourceText(context, argument) === handle.text &&
    memberRootVariable(context, argument) === handle.rootVariable
  );
};

type CleanupProof = {
  context: LoopContext;
  handle: Handle;
  cancels: Cancel[];
  visiting: ReadonlySet<AstNode>;
  completed: Map<AstNode, ReadonlySet<UncancelledPath>>;
  origin?: { start: AstNode; invocationPath: AstNode[] };
  setup?: {
    effect: AstNode;
    start: AstNode;
    returns: Set<AstNode>;
  };
};
type CleanupTruth = "truthy" | "falsy" | "unknown";
type UncancelledPath =
  "continues" | "returns" | "throws" | "blocks" | "suspends";

const handleTruth = (proof: CleanupProof, node: unknown): CleanupTruth => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return "unknown";
  }
  const matchesHandle = (argument: AstNode) =>
    cancelsHandle(proof.context, { argument, node: argument }, proof.handle);
  if (matchesHandle(expression)) {
    return "truthy";
  }
  if (expression.type === "Literal" && typeof expression.value === "boolean") {
    return expression.value ? "truthy" : "falsy";
  }
  if (expression.type === "UnaryExpression" && expression.operator === "!") {
    const truth = handleTruth(proof, expression.argument);
    return truth === "unknown"
      ? truth
      : truth === "truthy"
        ? "falsy"
        : "truthy";
  }
  if (expression.type === "BinaryExpression") {
    const left = unwrapExpression(expression.left);
    const right = unwrapExpression(expression.right);
    const absent = (value: AstNode | null) =>
      value !== null &&
      ((value.type === "Literal" &&
        (value.value === 0 || value.value === null)) ||
        isGlobalName(proof.context, value, "undefined"));
    if (
      (left !== null && matchesHandle(left) && absent(right)) ||
      (right !== null && matchesHandle(right) && absent(left))
    ) {
      if (expression.operator === "!==" || expression.operator === "!=") {
        return "truthy";
      }
      if (expression.operator === "===" || expression.operator === "==") {
        return "falsy";
      }
    }
  }
  return "unknown";
};

const continueCleanupPaths = (
  paths: Set<UncancelledPath>,
  evaluate: () => Set<UncancelledPath>,
): Set<UncancelledPath> => {
  if (!paths.has("continues")) {
    return paths;
  }
  const remaining = new Set(paths);
  remaining.delete("continues");
  for (const path of evaluate()) {
    remaining.add(path);
  }
  return remaining;
};

const cleanupExpressionPaths = (
  proof: CleanupProof,
  node: unknown,
): Set<UncancelledPath> => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return new Set(["continues"]);
  }
  if (
    proof.setup !== undefined &&
    expression.range[1] < proof.setup.start.range[0]
  ) {
    return new Set(["continues"]);
  }
  if (expression.type === "CallExpression") {
    let paths = new Set<UncancelledPath>(["continues"]);
    for (const argument of callArguments(expression)) {
      paths = continueCleanupPaths(paths, () =>
        cleanupExpressionPaths(proof, argument),
      );
    }
    return continueCleanupPaths(paths, () => {
      if (proof.cancels.some((cancel) => cancel.node === expression)) {
        return new Set();
      }
      const called = functionFor(proof.context, expression.callee);
      // A call after creation executes its helper now, regardless of where
      // that helper was declared. Cleanup bodies use the ordinary proof too.
      const { setup: _setup, ...activeProof } = proof;
      const calledProof =
        proof.setup !== undefined &&
        expression.range[0] > proof.setup.start.range[1]
          ? activeProof
          : proof;
      if (called === null) {
        return proof.origin !== undefined &&
          ownsReturnedCleanup({
            proof: calledProof,
            expression: expression.callee,
            start: proof.origin.start,
            budget: { remaining: MAX_LOOP_INVOCATION_PATHS },
          })
          ? new Set()
          : new Set(["continues"]);
      }
      return new Set(
        [...cleanupFunctionPaths(calledProof, called)].map((path) =>
          path === "returns" ||
          (called.async === true && (path === "suspends" || path === "throws"))
            ? "continues"
            : path,
        ),
      );
    });
  }
  if (expression.type === "ConditionalExpression") {
    return continueCleanupPaths(
      cleanupExpressionPaths(proof, expression.test),
      () => {
        const truth = handleTruth(proof, expression.test);
        if (truth !== "unknown") {
          return cleanupExpressionPaths(
            proof,
            truth === "truthy" ? expression.consequent : expression.alternate,
          );
        }
        return new Set([
          ...cleanupExpressionPaths(proof, expression.consequent),
          ...cleanupExpressionPaths(proof, expression.alternate),
        ]);
      },
    );
  }
  if (expression.type === "LogicalExpression") {
    return continueCleanupPaths(
      cleanupExpressionPaths(proof, expression.left),
      () => {
        const truth = handleTruth(proof, expression.left);
        const right = () => cleanupExpressionPaths(proof, expression.right);
        if (truth === "unknown") {
          return new Set(["continues", ...right()]);
        }
        return (expression.operator === "&&" && truth === "truthy") ||
          (expression.operator === "||" && truth === "falsy")
          ? right()
          : new Set(["continues"]);
      },
    );
  }
  if (
    expression.type === "SequenceExpression" &&
    Array.isArray(expression.expressions)
  ) {
    let paths = new Set<UncancelledPath>(["continues"]);
    for (const part of expression.expressions) {
      paths = continueCleanupPaths(paths, () =>
        cleanupExpressionPaths(proof, part),
      );
    }
    return paths;
  }
  if (expression.type === "AwaitExpression") {
    return new Set(
      [...cleanupExpressionPaths(proof, expression.argument)].map((path) =>
        path === "continues" ? "suspends" : path,
      ),
    );
  }
  if (
    expression.type === "UnaryExpression" ||
    expression.type === "SpreadElement"
  ) {
    return cleanupExpressionPaths(proof, expression.argument);
  }
  if (expression.type === "AssignmentExpression") {
    return cleanupExpressionPaths(proof, expression.right);
  }
  return new Set(["continues"]);
};

const cleanupCompletionPaths = (
  proof: CleanupProof,
  node: AstNode,
): Set<UncancelledPath> => {
  if (proof.cancels.some((cancel) => cancel.node === node)) {
    return new Set();
  }
  if (
    proof.setup !== undefined &&
    enclosingFunctions(node).at(0) === proof.setup.effect
  ) {
    if (
      node.range[0] < proof.setup.start.range[0] &&
      !isWithin(proof.setup.start, node)
    ) {
      return new Set();
    }
    if (node.type === "ReturnStatement") {
      proof.setup.returns.add(node);
    }
  }
  return new Set(
    [...cleanupExpressionPaths(proof, node.argument)].map((path) =>
      path === "continues"
        ? node.type === "ReturnStatement"
          ? "returns"
          : "throws"
        : path,
    ),
  );
};

// Only uncancelled paths remain. Safe branches disappear; returns, throws,
// loops and suspension cannot be repaired by a later unreachable cancel.
const cleanupPaths = (
  proof: CleanupProof,
  node: unknown,
): Set<UncancelledPath> => {
  if (!isAstNode(node)) {
    return new Set(["continues"]);
  }
  if (node.type === "BlockStatement" && Array.isArray(node.body)) {
    let paths = new Set<UncancelledPath>(["continues"]);
    for (const statement of node.body) {
      paths = continueCleanupPaths(paths, () => cleanupPaths(proof, statement));
    }
    return paths;
  }
  if (node.type === "IfStatement") {
    // Reaching this start establishes its enclosing branch. The other branch
    // creates no handle and imposes no cleanup obligation for this start.
    if (proof.setup !== undefined) {
      for (const branch of [node.consequent, node.alternate]) {
        if (isAstNode(branch) && isWithin(proof.setup.start, branch)) {
          return cleanupPaths(proof, branch);
        }
      }
    }
    return continueCleanupPaths(
      cleanupExpressionPaths(proof, node.test),
      () => {
        const truth = handleTruth(proof, node.test);
        if (truth !== "unknown") {
          return cleanupPaths(
            proof,
            truth === "truthy" ? node.consequent : node.alternate,
          );
        }
        return new Set([
          ...cleanupPaths(proof, node.consequent),
          ...cleanupPaths(proof, node.alternate),
        ]);
      },
    );
  }
  if (node.type === "TryStatement") {
    let paths = cleanupPaths(proof, node.block);
    if (paths.has("throws") && isAstNode(node.handler)) {
      paths.delete("throws");
      paths = new Set([...paths, ...cleanupPaths(proof, node.handler.body)]);
    }
    if (isAstNode(node.finalizer)) {
      const final = cleanupPaths(proof, node.finalizer);
      paths = new Set(
        [...paths].flatMap((path) =>
          path === "blocks" || path === "suspends"
            ? [path]
            : [...final].map((after) => (after === "continues" ? path : after)),
        ),
      );
    }
    return paths;
  }
  if (node.type === "ReturnStatement" || node.type === "ThrowStatement") {
    return cleanupCompletionPaths(proof, node);
  }

  if (proof.setup !== undefined && finiteForLoop(proof.context, node)) {
    return continueCleanupPaths(
      cleanupExpressionPaths(proof, node.test),
      () =>
        new Set([
          "continues",
          ...continueCleanupPaths(cleanupPaths(proof, node.body), () =>
            cleanupExpressionPaths(proof, node.update),
          ),
        ]),
    );
  }
  if (
    CONDITIONAL_PARENTS.has(node.type) ||
    node.type === "SwitchStatement" ||
    node.type === "BreakStatement" ||
    node.type === "ContinueStatement"
  ) {
    return new Set(["continues", "blocks"]);
  }
  const expressions =
    node.type === "ExpressionStatement"
      ? [node.expression]
      : node.type === "VariableDeclaration" && Array.isArray(node.declarations)
        ? node.declarations.flatMap((declaration) =>
            isAstNode(declaration) ? [declaration.init] : [],
          )
        : [];
  let paths = new Set<UncancelledPath>(["continues"]);
  for (const expression of expressions) {
    paths = continueCleanupPaths(paths, () =>
      cleanupExpressionPaths(proof, expression),
    );
  }
  return paths;
};

const cleanupFunctionPaths = (
  proof: CleanupProof,
  fn: AstNode,
): Set<UncancelledPath> => {
  if (proof.visiting.has(fn)) {
    return new Set(["blocks"]);
  }
  if (fn.generator === true) {
    return new Set(["continues"]);
  }
  const cached = proof.completed.get(fn);
  if (cached !== undefined) {
    return new Set(cached);
  }
  const nested = { ...proof, visiting: new Set([...proof.visiting, fn]) };
  const paths =
    isAstNode(fn.body) && fn.body.type === "BlockStatement"
      ? cleanupPaths(nested, fn.body)
      : cleanupExpressionPaths(nested, fn.body);
  proof.completed.set(fn, new Set(paths));
  return paths;
};

const cancelledBeforeWrite = ({
  proof,
  write,
  start,
}: {
  proof: CleanupProof;
  write: AstNode;
  start: AstNode;
}): boolean => {
  const statement = parentOf(write);
  const block = statement === null ? null : parentOf(statement);
  if (block?.type !== "BlockStatement" || !Array.isArray(block.body)) {
    return false;
  }
  const owner = enclosingFunctions(write).at(0);
  const anchoredProof =
    owner !== undefined &&
    enclosingFunctions(start).at(0) === owner &&
    start.range[1] < write.range[0]
      ? {
          ...proof,
          completed: new Map(),
          setup: { effect: owner, start, returns: new Set<AstNode>() },
        }
      : proof;
  const index = block.body.indexOf(statement);
  let paths = new Set<UncancelledPath>(["continues"]);
  for (const preceding of block.body.slice(0, Math.max(index, 0))) {
    paths = continueCleanupPaths(paths, () =>
      cleanupPaths(anchoredProof, preceding),
    );
  }
  return paths.size === 0;
};

// A shared binding cannot prove ownership when another write replaces its
// handle. Frame loops retain one kick-off and their own pending-frame updates.
type AmbiguousHandleOptions = {
  cancels: Cancel[];
  context: LoopContext;
  handle: Handle;
  start: AstNode;
  loopBody: AstNode | null;
};

const emptyHandleValue = (context: LoopContext, value: AstNode | null) =>
  value !== null &&
  ((value.type === "Literal" && (value.value === 0 || value.value === null)) ||
    isGlobalName(context, value, "undefined"));

type StartsFrameLoopOptions = {
  context: LoopContext;
  value: AstNode | null;
  loopBody: AstNode | null;
};

const startsFrameLoop = ({
  context,
  value,
  loopBody,
}: StartsFrameLoopOptions) => {
  if (
    value?.type !== "CallExpression" ||
    loopBody === null ||
    !isGlobalCall(context, value, START_NAMES.frame)
  ) {
    return false;
  }
  const callback = unwrapExpression(callArguments(value).at(0));
  return (
    functionFor(context, callback) === loopBody ||
    (isFunctionNode(callback) &&
      directFunctionCalls(callback).some(
        (node) => namedCallTarget(context, node) === loopBody,
      ))
  );
};

const resetsConsumedFrame = ({
  context,
  write,
  loop,
}: {
  context: LoopContext;
  write: AstNode;
  loop: AstNode;
}): boolean => {
  const reschedules = directFunctionCalls(loop).filter((call) =>
    isGlobalCall(context, call, START_NAMES.frame),
  );
  return (
    enclosingFunctions(write).at(0) === loop &&
    reschedules.length > 0 &&
    reschedules.every((call) => write.range[1] < call.range[0])
  );
};

const mutuallyExclusiveBranches = (left: AstNode, right: AstNode): boolean => {
  if (enclosingFunctions(left).at(0) !== enclosingFunctions(right).at(0)) {
    return false;
  }
  if (left.range[0] > right.range[0]) {
    return mutuallyExclusiveBranches(right, left);
  }
  const owner = enclosingFunctions(left).at(0);
  let returnsBeforeRight = false;
  let crossesTry = false;
  for (
    let parent = parentOf(left);
    parent !== null && parent !== owner;
    parent = parentOf(parent)
  ) {
    if (parent.type === "TryStatement") {
      crossesTry = true;
    }
    if (parent.type === "IfStatement" && right.range[0] >= parent.range[1]) {
      const branch =
        isAstNode(parent.consequent) && isWithin(left, parent.consequent)
          ? parent.consequent
          : parent.alternate;
      if (
        isAstNode(branch) &&
        isWithin(left, branch) &&
        branch.type === "BlockStatement" &&
        Array.isArray(branch.body)
      ) {
        const last = branch.body.at(-1);
        if (isAstNode(last) && last.type === "ReturnStatement") {
          returnsBeforeRight = true;
        }
      }
    }
    if (
      (parent.type === "IfStatement" ||
        parent.type === "ConditionalExpression") &&
      isAstNode(parent.consequent) &&
      isAstNode(parent.alternate) &&
      ((isWithin(left, parent.consequent) &&
        isWithin(right, parent.alternate)) ||
        (isWithin(left, parent.alternate) &&
          isWithin(right, parent.consequent)))
    ) {
      return true;
    }
  }
  return returnsBeforeRight && !crossesTry;
};

const sameHandle = (left: Handle, right: Handle | null): boolean => {
  if (left.kind === "binding") {
    return right?.kind === "binding" && left.variable === right.variable;
  }
  return (
    left.kind === "member" &&
    right?.kind === "member" &&
    left.rootVariable === right.rootVariable &&
    left.text === right.text
  );
};

type FrameWriteOptions = {
  proof: CleanupProof;
  write: AstNode;
  value: AstNode;
  loopBody: AstNode;
};

const preservesPendingFrame = ({
  proof,
  write,
  value,
  loopBody,
}: FrameWriteOptions): boolean => {
  for (
    let parent = parentOf(write);
    parent !== null && parent !== loopBody;
    parent = parentOf(parent)
  ) {
    if (
      [
        "ForStatement",
        "ForInStatement",
        "ForOfStatement",
        "WhileStatement",
        "DoWhileStatement",
      ].includes(parent.type) &&
      !cancelledBeforeWrite({ proof, write, start: value })
    ) {
      return false;
    }
  }
  return directFunctionCalls(loopBody)
    .filter(
      (call) =>
        call.range[1] < value.range[0] &&
        startsFrameLoop({ context: proof.context, value: call, loopBody }) &&
        sameHandle(proof.handle, handleOf(proof.context, call)),
    )
    .every(
      (earlier) =>
        mutuallyExclusiveBranches(earlier, value) ||
        cancelledBeforeWrite({ proof, write, start: earlier }),
    );
};

const isSafeFrameLoopWrite = ({
  proof,
  start,
  write,
  value,
  loopBody,
}: {
  proof: CleanupProof;
  start: AstNode;
  write: AstNode | null;
  value: AstNode | null;
  loopBody: AstNode | null;
}): boolean => {
  const { context } = proof;
  if (
    write === null ||
    loopBody === null ||
    !isGlobalCall(context, start, START_NAMES.frame) ||
    !isWithin(write, loopBody)
  ) {
    return false;
  }
  return (
    (value !== null &&
      startsFrameLoop({ context, value, loopBody }) &&
      preservesPendingFrame({ proof, write, value, loopBody })) ||
    (emptyHandleValue(context, value) &&
      resetsConsumedFrame({ context, write, loop: loopBody }))
  );
};

const startsInFinally = (start: AstNode, owner: AstNode) => {
  for (
    let parent = parentOf(start);
    parent !== null && parent !== owner;
    parent = parentOf(parent)
  ) {
    if (
      parent.type === "TryStatement" &&
      isAstNode(parent.finalizer) &&
      isWithin(start, parent.finalizer)
    ) {
      return true;
    }
  }
  return false;
};

const precedesCreation = (write: AstNode, start: AstNode): boolean =>
  write.range[1] < start.range[0] &&
  enclosingFunctions(write).at(0) === enclosingFunctions(start).at(0);

type RepeatedIntervalWriteOptions = {
  context: LoopContext;
  write: AstNode;
  start: AstNode;
};

const repeatsMutableIntervalWrite = ({
  context,
  write,
  start,
}: RepeatedIntervalWriteOptions): boolean => {
  if (!isGlobalCall(context, start, START_NAMES.interval)) {
    return false;
  }
  if (write.type === "VariableDeclarator" && parentOf(write)?.kind !== "var") {
    return false;
  }
  const owner = enclosingFunctions(write).at(0);
  for (
    let parent = parentOf(write);
    parent !== null && parent !== owner;
    parent = parentOf(parent)
  ) {
    if (
      parent.type === "ForStatement" &&
      isAstNode(parent.init) &&
      isWithin(write, parent.init)
    ) {
      continue;
    }
    if (
      [
        "ForStatement",
        "ForInStatement",
        "ForOfStatement",
        "WhileStatement",
        "DoWhileStatement",
      ].includes(parent.type)
    ) {
      return true;
    }
  }
  return false;
};

const hasAmbiguousMemberWrites = ({
  context,
  cancels,
  handle,
  start,
  loopBody,
}: AmbiguousHandleOptions) => {
  if (handle.kind !== "member") {
    return false;
  }
  let root = start;
  while (parentOf(root) !== null) {
    const parent = parentOf(root);
    if (parent === null) {
      break;
    }
    root = parent;
  }
  const proof: CleanupProof = {
    context,
    handle,
    cancels: cancels.filter((cancel) => cancelsHandle(context, cancel, handle)),
    visiting: new Set(),
    completed: new Map(),
  };
  const frame = isGlobalCall(context, start, START_NAMES.frame);
  let kickOffs = 0;
  for (const node of everyNode(root)) {
    const target = unwrapExpression(
      node.type === "AssignmentExpression"
        ? node.left
        : node.type === "UpdateExpression" ||
            (node.type === "UnaryExpression" && node.operator === "delete")
          ? node.argument
          : null,
    );
    if (
      target?.type !== "MemberExpression" ||
      !cancelsHandle(context, { argument: target, node }, handle)
    ) {
      continue;
    }
    if (
      precedesCreation(node, start) ||
      mutuallyExclusiveBranches(start, node)
    ) {
      continue;
    }
    const value = unwrapExpression(
      node.type === "AssignmentExpression" && node.operator === "="
        ? node.right
        : null,
    );
    if (cancelledBeforeWrite({ proof, write: node, start })) {
      continue;
    }
    if (repeatsMutableIntervalWrite({ context, write: node, start })) {
      return true;
    }
    if (value === start && (loopBody === null || !isWithin(node, loopBody))) {
      continue;
    }
    const insideLoop = loopBody !== null && isWithin(node, loopBody);
    const startsLoop = frame && startsFrameLoop({ context, value, loopBody });
    if (isSafeFrameLoopWrite({ proof, start, write: node, value, loopBody })) {
      continue;
    }
    if (startsLoop && !insideLoop && ++kickOffs <= 1) {
      continue;
    }
    return true;
  }
  return false;
};

const assignedValue = (write: AstNode | null) => {
  if (write?.type === "VariableDeclarator") {
    return unwrapExpression(write.init);
  }
  return write?.type === "AssignmentExpression" && write.operator === "="
    ? unwrapExpression(write.right)
    : null;
};

const hasAmbiguousHandleWrites = ({
  cancels,
  context,
  handle,
  start,
  loopBody,
}: AmbiguousHandleOptions): boolean => {
  if (handle.kind !== "binding") {
    return hasAmbiguousMemberWrites({
      context,
      cancels,
      handle,
      start,
      loopBody,
    });
  }
  const proof: CleanupProof = {
    context,
    handle,
    cancels: cancels.filter((cancel) => cancelsHandle(context, cancel, handle)),
    visiting: new Set(),
    completed: new Map(),
  };
  let frameKickOffs = 0;
  for (const reference of handle.variable.references) {
    if (!reference.isWrite()) {
      continue;
    }
    const identifier: unknown = reference.identifier;
    const write = isAstNode(identifier) ? parentOf(identifier) : null;
    if (
      write !== null &&
      (precedesCreation(write, start) ||
        mutuallyExclusiveBranches(start, write))
    ) {
      continue;
    }
    const value = assignedValue(write);
    const empty =
      (value === null && write?.type === "VariableDeclarator") ||
      emptyHandleValue(context, value);
    if (write !== null && cancelledBeforeWrite({ proof, write, start })) {
      continue;
    }
    if (
      write !== null &&
      repeatsMutableIntervalWrite({ context, write, start })
    ) {
      return true;
    }
    if (empty && reference.init) {
      continue;
    }
    const frame = isGlobalCall(context, start, START_NAMES.frame);
    const insideLoop =
      loopBody !== null && write !== null && isWithin(write, loopBody);
    const startsLoop = frame && startsFrameLoop({ context, value, loopBody });
    if (isSafeFrameLoopWrite({ proof, start, write, value, loopBody })) {
      continue;
    }
    if (startsLoop && !insideLoop) {
      frameKickOffs += 1;
      if (frameKickOffs <= 1) {
        continue;
      }
    } else if (value === start && !insideLoop) {
      continue;
    }
    return true;
  }
  return false;
};

type LoopOwner =
  | { type: "factory-contract" }
  | {
      type: "effect-startup" | "async-frame-callback";
      effectAnchor: AstNode;
      invocationPath: AstNode[];
    };

type OwnedLoop = {
  owner: LoopOwner;
  loopBody: AstNode | null;
  start: AstNode;
};

type ReturnedHandleOptions = {
  context: LoopContext;
  expression: unknown;
  expected: AstNode;
  budget: { remaining: number };
};

const returnsHandleValue = ({
  context,
  expression: raw,
  expected,
  budget,
}: ReturnedHandleOptions): boolean => {
  if (budget.remaining <= 0) {
    return false;
  }
  budget.remaining -= 1;
  const expression = unwrapExpression(raw);
  if (expression === expected) {
    return true;
  }
  if (!isIdentifierReference(expression)) {
    return false;
  }
  const variable = resolveVariable(context, expression);
  return (
    variable !== null &&
    isSingleAssignment(variable) &&
    returnsHandleValue({
      context,
      expression: stableInitializer(variable),
      expected,
      budget,
    })
  );
};

type FactoryHandleFlowOptions = {
  context: LoopContext;
  invocationPath: AstNode[];
  start: AstNode;
};

const returnsCreatedHandle = ({
  context,
  invocationPath,
  start,
}: FactoryHandleFlowOptions): boolean => {
  const budget = { remaining: MAX_LOOP_INVOCATION_PATHS };
  const valuePath = invocationPath.filter(
    (call) => !context.effectRegistrations.has(call),
  );
  return (
    valuePath.length > 0 &&
    valuePath.every((call, index) => {
      const factory = namedCallTarget(context, call);
      const expected = valuePath.at(index + 1) ?? start;
      if (
        factory === null ||
        factory.async === true ||
        factory.generator === true ||
        !isAstNode(factory.body)
      ) {
        return false;
      }
      const returnsValue = (expression: unknown) =>
        returnsHandleValue({ context, expression, expected, budget });
      if (factory.body.type !== "BlockStatement") {
        return returnsValue(factory.body);
      }
      const returns = new Set<AstNode>();
      const exits = cleanupPaths(
        {
          context,
          handle: { kind: "transferred", transfer: "returned" },
          cancels: [],
          visiting: new Set(),
          completed: new Map(),
          setup: { effect: factory, start: expected, returns },
        },
        factory.body,
      );
      return (
        [...exits].every((exit) => exit === "returns") &&
        returns.size > 0 &&
        [...returns].every((node) => returnsValue(node.argument))
      );
    })
  );
};

type ReturnedCleanupOptions = {
  proof: CleanupProof;
  expression: unknown;
  start: AstNode;
  budget: { remaining: number };
  visiting?: ReadonlySet<AstNode>;
};

const ownsReturnedCleanup = ({
  proof,
  expression: raw,
  start,
  budget,
  visiting = new Set(),
}: ReturnedCleanupOptions): boolean => {
  if (budget.remaining <= 0) {
    return false;
  }
  budget.remaining -= 1;
  const expression = unwrapExpression(raw);
  const cleanup = functionFor(proof.context, expression);
  if (cleanup !== null) {
    return cleanupFunctionPaths(proof, cleanup).size === 0;
  }
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(proof.context, expression);
    return (
      variable !== null &&
      isSingleAssignment(variable) &&
      ownsReturnedCleanup({
        proof,
        expression: stableInitializer(variable),
        start,
        budget,
        visiting,
      })
    );
  }
  if (expression?.type !== "CallExpression") {
    return false;
  }
  const factory = namedCallTarget(proof.context, expression);
  if (
    factory === null ||
    factory.async === true ||
    factory.generator === true ||
    visiting.has(factory)
  ) {
    return false;
  }
  const originatingCall = proof.origin?.invocationPath.find(
    (call) => namedCallTarget(proof.context, call) === factory,
  );
  if (originatingCall !== undefined && expression !== originatingCall) {
    return false;
  }
  const active = new Set([...visiting, factory]);
  if (!isAstNode(factory.body)) {
    return false;
  }
  if (factory.body.type !== "BlockStatement") {
    return ownsReturnedCleanup({
      proof,
      expression: factory.body,
      start,
      budget,
      visiting: active,
    });
  }
  const creator = enclosingFunctions(start).at(0);
  let anchor = isWithin(start, factory) ? start : factory;
  if (anchor === factory && creator !== undefined) {
    for (const call of directFunctionCalls(factory)) {
      const paths = loopInvocationPaths({
        context: proof.context,
        invocation: call,
        target: creator,
        budget,
      });
      if (paths === null) {
        return false;
      }
      if (paths.length > 0) {
        anchor = call;
        break;
      }
    }
  }
  const returns = new Set<AstNode>();
  const exits = cleanupPaths(
    {
      ...proof,
      completed: new Map(),
      setup: { effect: factory, start: anchor, returns },
    },
    factory.body,
  );
  if (exits.size === 0) {
    return true;
  }
  return (
    [...exits].every((path) => path === "returns") &&
    returns.size > 0 &&
    [...returns].every((node) =>
      ownsReturnedCleanup({
        proof,
        expression: node.argument,
        start,
        budget,
        visiting: active,
      }),
    )
  );
};

type OwnerCleanupOptions = {
  proof: CleanupProof;
  effect: AstNode | null;
  owner: AstNode;
  start: AstNode;
  effectAnchor: AstNode;
  loopBody: AstNode | null;
  transfers: Cancel[];
  matching: Cancel[];
};

const ownsOwnerCleanup = ({
  proof,
  effect,
  owner,
  start,
  effectAnchor,
  loopBody,
  transfers,
  matching,
}: OwnerCleanupOptions): boolean => {
  const { context, handle } = proof;
  const startupTransfers = transfers.filter(
    (transfer) =>
      cancelsHandle(context, transfer, handle) &&
      (effect === null || transfer.node.type === "CallExpression") &&
      transfer.node.range[0] > start.range[1] &&
      (effect === null ||
        loopBody === null ||
        !isWithin(transfer.node, loopBody)),
  );
  if (
    effect !== null &&
    isAstNode(owner.body) &&
    owner.body.type !== "BlockStatement"
  ) {
    return ownsReturnedCleanup({
      proof,
      expression: owner.body,
      start,
      budget: { remaining: MAX_LOOP_INVOCATION_PATHS },
    });
  }
  const returns = new Set<AstNode>();
  const exits = cleanupPaths(
    {
      ...proof,
      cancels: [...matching, ...startupTransfers],
      completed: new Map(),
      setup: {
        effect: owner,
        start: effect === null ? start : effectAnchor,
        returns,
      },
    },
    owner.body,
  );
  if (exits.size === 0) {
    return true;
  }
  if ([...exits].some((path) => path !== "returns")) {
    return false;
  }
  return (
    returns.size > 0 &&
    [...returns].every((node) => {
      const argument = unwrapExpression(node.argument);
      if (
        ownsReturnedCleanup({
          proof,
          expression: argument,
          start,
          budget: { remaining: MAX_LOOP_INVOCATION_PATHS },
        })
      ) {
        return true;
      }
      // A factory may explicitly return an object that owns the cancel method.
      // Merely defining a dormant closure elsewhere does not hand ownership out.
      if (
        effect === null &&
        argument?.type === "ObjectExpression" &&
        Array.isArray(argument.properties)
      ) {
        return argument.properties.some((property) => {
          const method = isAstNode(property)
            ? functionFor(context, property.value)
            : null;
          return (
            method !== null && cleanupFunctionPaths(proof, method).size === 0
          );
        });
      }
      return false;
    })
  );
};

const resolveLoopHandle = (
  context: LoopContext,
  { owner: origin, start }: Pick<OwnedLoop, "owner" | "start">,
) => {
  const effectAnchor =
    origin.type === "factory-contract" ? start : origin.effectAnchor;
  const invocationPath =
    origin.type === "factory-contract" ? undefined : origin.invocationPath;
  const effect =
    origin.type === "factory-contract"
      ? null
      : enclosingEffect(context, effectAnchor);
  let ownershipStart = start;
  let handle = handleOf(context, start);
  if (effect !== null) {
    const returnedHandle =
      origin.type === "effect-startup" &&
      effectAnchor !== start &&
      invocationPath !== undefined &&
      returnsCreatedHandle({ context, invocationPath, start });
    if (returnedHandle) {
      handle = handleOf(context, effectAnchor);
      ownershipStart = effectAnchor;
    }
    // React's returned value must be a cleanup, rather than the timer handle.
    if (handle?.kind === "transferred" && handle.transfer === "returned") {
      return null;
    }
  }
  return { effectAnchor, invocationPath, effect, ownershipStart, handle };
};

const isOwned = (
  context: LoopContext,
  cancels: Cancel[],
  { owner: origin, loopBody, start }: OwnedLoop,
): boolean => {
  const resolved = resolveLoopHandle(context, { owner: origin, start });
  if (resolved === null) {
    return false;
  }
  const { effectAnchor, invocationPath, effect, ownershipStart, handle } =
    resolved;
  if (
    handle === null ||
    hasAmbiguousHandleWrites({
      cancels,
      context,
      handle,
      start: ownershipStart,
      loopBody,
    })
  ) {
    return false;
  }
  if (handle.kind === "transferred") {
    return true;
  }
  const transfers =
    handle.kind === "binding" ? bindingTransfers(context, handle.variable) : [];
  const handoffs = transfers.filter(
    (transfer) =>
      transfer.node.type === "CallExpression" &&
      cancelsHandle(context, transfer, handle),
  );
  const matching = cancels.filter(
    (cancel) =>
      cancelsHandle(context, cancel, handle) &&
      (loopBody === null || !isWithin(cancel.node, loopBody)),
  );
  const proof: CleanupProof = {
    context,
    handle,
    cancels: [...matching, ...handoffs],
    visiting: new Set(),
    completed: new Map(),
    ...(invocationPath === undefined
      ? {}
      : { origin: { start, invocationPath } }),
  };
  const declaration =
    handle.kind === "binding" ? handle.variable.defs.at(0)?.node : null;
  const bindingOwner = isAstNode(declaration)
    ? enclosingFunctions(declaration).at(0)
    : undefined;
  const owner =
    effect ??
    (bindingOwner !== undefined && !context.effectCallbacks.has(bindingOwner)
      ? bindingOwner
      : enclosingFunctions(start).at(0));
  // A shared ref is an explicit external owner: separate schedule/clear
  // helpers operate on the same resolved root, after overwrite checks above.
  if (
    effect === null &&
    handle.kind === "member" &&
    owner !== undefined &&
    matching.length > 0 &&
    handle.rootVariable.defs.every(
      (definition) =>
        isAstNode(definition.node) && !isWithin(definition.node, owner),
    )
  ) {
    return true;
  }
  if (owner === undefined) {
    return false;
  }
  // A finally block can start a timer after an earlier return or throw. Its
  // incoming completion is unknown to the structural setup-path proof.
  if (startsInFinally(ownershipStart, owner)) {
    return false;
  }
  return ownsOwnerCleanup({
    proof,
    effect,
    owner,
    start: ownershipStart,
    effectAnchor,
    loopBody,
    transfers,
    matching,
  });
};

// Only literal integer progress and limits establish a finite retry budget.
const integerValue = (node: unknown): number | null => {
  const value = unwrapExpression(node);
  if (value === null) {
    return null;
  }
  if (typeof value.value === "number" && Number.isSafeInteger(value.value)) {
    return value.value;
  }
  if (value.type === "UnaryExpression" && value.operator === "-") {
    const argument = integerValue(value.argument);
    return argument === null ? null : -argument;
  }
  return null;
};

// A standalone write earlier on the call's path runs before every reschedule.
type PrecedesOnPathOptions = { write: AstNode; call: AstNode; loop: AstNode };

const precedesOnPath = ({
  write,
  call,
  loop,
}: PrecedesOnPathOptions): boolean => {
  const statement = parentOf(write);
  const block = statement === null ? null : parentOf(statement);
  if (
    statement?.type !== "ExpressionStatement" ||
    block?.type !== "BlockStatement" ||
    !Array.isArray(block.body)
  ) {
    return false;
  }
  let current = call;
  while (current !== loop) {
    const parent = parentOf(current);
    if (parent === block) {
      return block.body.indexOf(statement) < block.body.indexOf(current);
    }
    if (
      parent === null ||
      FUNCTION_TYPES.has(parent.type) ||
      CONDITIONAL_PARENTS.has(parent.type)
    ) {
      return false;
    }
    current = parent;
  }
  return false;
};

type CounterDirection = "increasing" | "decreasing";
type CounterProgress = "before-call" | "for-update";

type CounterDirectionOptions = {
  variable: Variable;
  call: AstNode;
  loop: AstNode;
  progress: CounterProgress;
};

const counterStep = (write: AstNode): number | null => {
  const step =
    write.type === "UpdateExpression"
      ? write.operator === "++"
        ? 1
        : write.operator === "--"
          ? -1
          : null
      : write.type === "AssignmentExpression" &&
          (write.operator === "+=" || write.operator === "-=")
        ? integerValue(write.right)
        : null;
  if (step === null || step === 0) {
    return null;
  }
  return write.type === "AssignmentExpression" && write.operator === "-="
    ? -step
    : step;
};

const counterDirection = ({
  variable,
  call,
  loop,
  progress,
}: CounterDirectionOptions): CounterDirection | null => {
  const definition = variable.defs.at(0);
  if (
    variable.defs.length !== 1 ||
    definition?.type !== "Variable" ||
    !isAstNode(definition.node) ||
    definition.node.type !== "VariableDeclarator" ||
    integerValue(definition.node.init) === null
  ) {
    return null;
  }
  const correctInitializer =
    progress === "for-update"
      ? isAstNode(loop.init) && isWithin(definition.node, loop.init)
      : !isWithin(definition.node, loop);
  if (!correctInitializer) {
    return null;
  }
  let direction: CounterDirection | null = null;
  for (const reference of variable.references) {
    if (!reference.isWrite() || reference.init) {
      continue;
    }
    if (!isAstNode(reference.identifier)) {
      return null;
    }
    const write = parentOf(reference.identifier);
    if (
      write === null ||
      (progress === "for-update"
        ? write !== loop.update
        : !isWithin(write, loop) || !precedesOnPath({ write, call, loop }))
    ) {
      return null;
    }
    const delta = counterStep(write);
    if (delta === null) {
      return null;
    }
    const next = delta > 0 ? "increasing" : "decreasing";
    if (direction !== null && direction !== next) {
      return null;
    }
    direction = next;
  }
  return direction;
};

type BoundedGuardOptions = {
  context: LoopContext;
  guard: Guard;
  call: AstNode;
  loop: AstNode;
  progress: CounterProgress;
};

const boundedGuard = ({
  context,
  guard: { expression, outcome },
  call,
  loop,
  progress,
}: BoundedGuardOptions): boolean => {
  const node = unwrapExpression(expression);
  if (node === null) {
    return false;
  }
  const recurse = (child: unknown, nextOutcome = outcome): boolean =>
    isAstNode(child) &&
    boundedGuard({
      context,
      guard: { expression: child, outcome: nextOutcome },
      call,
      loop,
      progress,
    });
  if (node.type === "UnaryExpression" && node.operator === "!") {
    return recurse(node.argument, outcome === "truthy" ? "falsy" : "truthy");
  }
  if (
    node.type === "LogicalExpression" &&
    (node.operator === "&&" || node.operator === "||")
  ) {
    const bothRequired = (node.operator === "&&") === (outcome === "falsy");
    return bothRequired
      ? recurse(node.left) && recurse(node.right)
      : recurse(node.left) || recurse(node.right);
  }
  if (node.type !== "BinaryExpression") {
    return false;
  }
  const left = unwrapExpression(node.left);
  const right = unwrapExpression(node.right);
  for (const [counter, bound, counterSide] of [
    [left, right, "left"],
    [right, left, "right"],
  ] as const) {
    if (!isIdentifierReference(counter)) {
      continue;
    }
    const boundVariable = isIdentifierReference(bound)
      ? resolveVariable(context, bound)
      : null;
    const limit = integerValue(
      boundVariable === null ? bound : stableInitializer(boundVariable),
    );
    if (limit === null) {
      continue;
    }
    const variable = resolveVariable(context, counter);
    const direction =
      variable === null
        ? null
        : counterDirection({ variable, call, loop, progress });
    if (direction === null) {
      continue;
    }
    const ascendingComparison =
      counterSide === "left"
        ? node.operator === "<" || node.operator === "<="
        : node.operator === ">" || node.operator === ">=";
    const descendingComparison =
      counterSide === "left"
        ? node.operator === ">" || node.operator === ">="
        : node.operator === "<" || node.operator === "<=";
    const bounded =
      direction === "increasing"
        ? outcome === "truthy"
          ? ascendingComparison
          : descendingComparison
        : outcome === "truthy"
          ? descendingComparison
          : ascendingComparison;
    if (bounded) {
      return true;
    }
  }
  return false;
};

const finiteForLoop = (context: LoopContext, node: AstNode): boolean =>
  node.type === "ForStatement" &&
  isAstNode(node.init) &&
  node.init.type === "VariableDeclaration" &&
  Array.isArray(node.init.declarations) &&
  node.init.declarations.length === 1 &&
  isAstNode(node.test) &&
  isAstNode(node.update) &&
  boundedGuard({
    context,
    guard: { expression: node.test, outcome: "truthy" },
    call: node.update,
    loop: node,
    progress: "for-update",
  });

// Every frame call that enters a loop function, reschedules and kick-offs,
// keyed by the loop.
const frameLoops = (
  context: LoopContext,
  starts: LoopStart[],
): Map<AstNode, AstNode[]> => {
  const loops = new Map<AstNode, AstNode[]>();
  const kickOffs: AstNode[] = [];
  for (const { kind, node } of starts) {
    if (kind !== "frame") {
      continue;
    }
    const loop = frameLoopFunction(context, node);
    if (loop === null) {
      kickOffs.push(node);
    } else {
      loops.set(loop, [...(loops.get(loop) ?? []), node]);
    }
  }
  for (const node of kickOffs) {
    const callback = callArguments(node).at(0);
    const named = functionFor(context, callback);
    const inline = unwrapExpression(callback);
    const loop =
      named !== null && loops.has(named)
        ? named
        : isFunctionNode(inline)
          ? (directFunctionCalls(inline)
              .map((candidate) => namedCallTarget(context, candidate))
              .find((target) => target !== null && loops.has(target)) ?? null)
          : null;
    const calls = loop === null ? undefined : loops.get(loop);
    calls?.push(node);
  }
  return loops;
};

const hasGuardedFrameCallback = (
  context: LoopContext,
  call: AstNode,
  loop: AstNode,
): boolean => {
  const callback = unwrapExpression(callArguments(call).at(0));
  if (!isFunctionNode(callback)) {
    return false;
  }
  const invocations = directFunctionCalls(callback).filter(
    (node) => namedCallTarget(context, node) === loop,
  );
  return (
    invocations.length > 0 &&
    invocations.every((node) => rescheduleGuards(node, callback) !== null)
  );
};

type LoopOwnershipOptions = {
  context: LoopContext;
  kind: LoopKind;
  cancels: Cancel[];
  starts: { node: AstNode; loopBody: AstNode | null }[];
  effectInvocations: AstNode[];
};

type AsyncFrameOwnerOptions = Pick<
  LoopOwnershipOptions,
  "context" | "cancels" | "starts" | "effectInvocations"
> & {
  loopBody: AstNode;
  unowned: Set<AstNode>;
};

type AsyncFrameOwnership =
  LoopOwner | { type: "unowned-startup"; node: AstNode };

// An asynchronous frame callback inherits effect ownership only from a
// retained kickoff on a proven startup path, not lexical nesting alone.
const asyncFrameOwner = ({
  context,
  cancels,
  starts,
  effectInvocations,
  loopBody,
  unowned,
}: AsyncFrameOwnerOptions): AsyncFrameOwnership => {
  let unownedStartup: AstNode | undefined;
  for (const kickoff of starts) {
    if (kickoff.loopBody !== loopBody || isWithin(kickoff.node, loopBody)) {
      continue;
    }
    const kickoffOwner = enclosingFunctions(kickoff.node).at(0);
    if (kickoffOwner === undefined) {
      continue;
    }
    for (const invocation of effectInvocations) {
      const paths = loopInvocationPaths({
        context,
        invocation,
        target: kickoffOwner,
        budget: { remaining: MAX_LOOP_INVOCATION_PATHS },
      });
      if (paths === null) {
        unowned.add(invocation);
        continue;
      }
      const path = paths.find((candidate) =>
        isOwned(context, cancels, {
          owner: {
            type: "effect-startup",
            effectAnchor: candidate.at(1) ?? kickoff.node,
            invocationPath: candidate,
          },
          loopBody,
          start: kickoff.node,
        }),
      );
      if (path !== undefined) {
        return {
          type: "async-frame-callback",
          effectAnchor: path.at(1) ?? kickoff.node,
          invocationPath: path,
        };
      }
      if (paths.length > 0) {
        unownedStartup ??= kickoff.node;
      }
    }
  }
  return unownedStartup === undefined
    ? { type: "factory-contract" }
    : { type: "unowned-startup", node: unownedStartup };
};

const loopOwnershipReports = ({
  context,
  kind,
  cancels,
  starts,
  effectInvocations,
}: LoopOwnershipOptions): Report[] => {
  const unowned = new Set<AstNode>();
  for (const { node: start, loopBody } of starts) {
    const owner = enclosingFunctions(start).at(0);
    const repeated =
      owner !== undefined &&
      hasUncancelledRepeatedInvocation({
        context,
        cancels,
        start,
        owner,
        invocations: effectInvocations,
      });
    let reached = false;
    for (const invocation of effectInvocations) {
      if (owner === undefined) {
        continue;
      }
      const paths = loopInvocationPaths({
        context,
        invocation,
        target: owner,
        budget: { remaining: MAX_LOOP_INVOCATION_PATHS },
      });
      if (paths === null) {
        unowned.add(invocation);
        continue;
      }
      if (paths.length === 0) {
        continue;
      }
      reached = true;
      if (
        repeated ||
        !paths.every((path) =>
          isOwned(context, cancels, {
            owner: {
              type: "effect-startup",
              effectAnchor: path.at(1) ?? start,
              invocationPath: path,
            },
            loopBody,
            start,
          }),
        )
      ) {
        unowned.add(
          enclosingEffect(context, start) === null ? invocation : start,
        );
      }
    }
    const fallbackOwner =
      !reached && loopBody !== null && owner === loopBody
        ? asyncFrameOwner({
            context,
            cancels,
            starts,
            effectInvocations,
            loopBody,
            unowned,
          })
        : ({ type: "factory-contract" } as const);
    if (fallbackOwner.type === "unowned-startup") {
      unowned.add(fallbackOwner.node);
    } else if (
      !reached &&
      !isOwned(context, cancels, { owner: fallbackOwner, loopBody, start })
    ) {
      unowned.add(start);
    }
  }
  return [...unowned].map((node) => ({ kind, messageId: "unownedLoop", node }));
};

const frameLoopReports = (
  context: LoopContext,
  { cancels, starts, effectInvocations }: LoopCalls,
): Report[] => {
  const reports: Report[] = [];
  for (const [loop, calls] of frameLoops(context, starts)) {
    let bounded = true;
    for (const reschedule of calls.filter((call) => isWithin(call, loop))) {
      const guards = rescheduleGuards(reschedule, loop);
      if (guards === null) {
        bounded = false;
        if (!hasGuardedFrameCallback(context, reschedule, loop)) {
          reports.push({
            kind: "frame",
            messageId: "idleFrameLoop",
            node: reschedule,
          });
        }
      } else if (
        !guards.some((guard) =>
          boundedGuard({
            context,
            guard,
            loop,
            call: reschedule,
            progress: "before-call",
          }),
        )
      ) {
        bounded = false;
      }
    }
    if (bounded) {
      continue;
    }
    reports.push(
      ...loopOwnershipReports({
        context,
        kind: "frame",
        cancels: cancels.frame,
        starts: calls.map((node) => ({ node, loopBody: loop })),
        effectInvocations,
      }),
    );
  }
  return reports;
};

type LoopInvocationOptions = {
  context: LoopContext;
  invocation: AstNode;
  target: AstNode;
  visiting?: ReadonlySet<AstNode>;
  budget: { remaining: number };
};

const MAX_LOOP_INVOCATION_PATHS = 64;

const loopInvocationPaths = ({
  context,
  invocation,
  target,
  visiting = new Set(),
  budget,
}: LoopInvocationOptions): AstNode[][] | null => {
  const called = startupTarget(context, invocation);
  if (
    called === null ||
    visiting.has(called) ||
    !functionsReaching(context, target).has(called)
  ) {
    return [];
  }
  if (budget.remaining <= 0) {
    return null;
  }
  budget.remaining -= 1;
  const paths: AstNode[][] = [];
  if (called === target) {
    paths.push([invocation]);
  } else {
    for (const call of directFunctionCalls(called)) {
      const nested = loopInvocationPaths({
        context,
        invocation: call,
        target,
        visiting: new Set([...visiting, called]),
        budget,
      });
      if (
        nested === null ||
        paths.length + nested.length > MAX_LOOP_INVOCATION_PATHS
      ) {
        return null;
      }
      for (const path of nested) {
        paths.push([invocation, ...path]);
      }
    }
  }
  // One call node in a loop can execute repeatedly and overwrite the handle.
  const owner = enclosingFunctions(invocation).at(0);
  for (
    let parent = parentOf(invocation);
    parent !== null && parent !== owner;
    parent = parentOf(parent)
  ) {
    if (
      [
        "ForStatement",
        "ForInStatement",
        "ForOfStatement",
        "WhileStatement",
        "DoWhileStatement",
      ].includes(parent.type)
    ) {
      return paths.length * 2 > MAX_LOOP_INVOCATION_PATHS
        ? null
        : [...paths, ...paths];
    }
  }
  return paths;
};

type RepeatedLoopInvocationOptions = {
  context: LoopContext;
  cancels: Cancel[];
  start: AstNode;
  owner: AstNode;
  invocations: AstNode[];
};

type InvocationPairOptions = {
  context: LoopContext;
  proof: CleanupProof;
  left: AstNode[];
  right: AstNode[];
  freshOwner: AstNode | undefined;
};

const uncancelledInvocationPair = ({
  context,
  proof,
  left,
  right,
  freshOwner,
}: InvocationPairOptions): boolean => {
  const divergence = left.findIndex(
    (call, position) => call !== right[position],
  );
  if (divergence === -1) {
    return true;
  }
  // Only divergence before entering the allocation owner creates two instances.
  if (
    freshOwner !== undefined &&
    [left, right].every((path) => {
      const allocation = path.findIndex(
        (call) => startupTarget(context, call) === freshOwner,
      );
      return allocation >= divergence;
    })
  ) {
    return false;
  }
  const earlier = left[divergence];
  const later = right[divergence];
  if (earlier === undefined || later === undefined) {
    return true;
  }
  if (mutuallyExclusiveBranches(earlier, later)) {
    return false;
  }
  const [first, second] =
    earlier.range[0] < later.range[0] ? [earlier, later] : [later, earlier];
  if (!cancelledBeforeWrite({ proof, write: second, start: first })) {
    return true;
  }
  return false;
};

const hasUncancelledRepeatedInvocation = ({
  context,
  cancels,
  start,
  owner,
  invocations,
}: RepeatedLoopInvocationOptions): boolean => {
  const handle = handleOf(context, start);
  if (handle === null || handle.kind === "transferred") {
    return false;
  }
  const variable =
    handle.kind === "binding" ? handle.variable : handle.rootVariable;
  const declaration =
    variable.defs.length === 1 ? variable.defs.at(0)?.node : null;
  const freshOwner =
    isAstNode(declaration) &&
    (handle.kind === "binding" ||
      (isSingleAssignment(variable) &&
        ["ObjectExpression", "ArrayExpression"].includes(
          unwrapExpression(declaration.init)?.type ?? "",
        )))
      ? enclosingFunctions(declaration).at(0)
      : undefined;
  if (freshOwner === owner) {
    return false;
  }
  const proof: CleanupProof = {
    context,
    handle,
    cancels: cancels.filter((cancel) => cancelsHandle(context, cancel, handle)),
    visiting: new Set(),
    completed: new Map(),
  };
  const write = parentOf(start);
  // A helper that clears the shared handle before replacing it is restartable.
  if (write !== null && cancelledBeforeWrite({ proof, write, start })) {
    return false;
  }
  const paths: AstNode[][] = [];
  for (const invocation of invocations) {
    const nested = loopInvocationPaths({
      context,
      invocation,
      target: owner,
      budget: { remaining: MAX_LOOP_INVOCATION_PATHS },
    });
    if (
      nested === null ||
      paths.length + nested.length > MAX_LOOP_INVOCATION_PATHS
    ) {
      return true;
    }
    paths.push(...nested);
  }
  for (let index = 0; index < paths.length; index += 1) {
    const left = paths[index];
    if (left === undefined) {
      continue;
    }
    for (const right of paths.slice(index + 1)) {
      if (
        uncancelledInvocationPair({ context, proof, left, right, freshOwner })
      ) {
        return true;
      }
    }
  }
  return false;
};

const intervalReports = (
  context: LoopContext,
  { cancels, starts, effectInvocations }: LoopCalls,
): Report[] =>
  loopOwnershipReports({
    context,
    kind: "interval",
    cancels: cancels.interval,
    starts: starts
      .filter(({ kind }) => kind === "interval")
      .map(({ node }) => ({
        node,
        loopBody: functionFor(context, callArguments(node).at(0)),
      })),
    effectInvocations,
  });

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          unownedLoop:
            "This {{start}} loop is not provably cancelled by its owner. " +
            "Keep the handle and pass it to {{cancel}} outside the loop " +
            "callback (in the effect's returned cleanup when an effect " +
            "starts it), or return the handle to the caller.",
          idleFrameLoop:
            "This requestAnimationFrame loop reschedules itself on every " +
            "frame without a stop condition, so it keeps running while " +
            "nothing changes. Reschedule only while there is work (a " +
            "visible, moving, or pending state) and restart it when work " +
            "returns.",
        },
        schema: [],
      },
      createOnce(context) {
        const effectRegistrations = new Map<AstNode, AstNode>();
        let functionCallers = new Map<AstNode, Set<AstNode>>();
        const reachingFunctions = new Map<AstNode, ReadonlySet<AstNode>>();
        let effectCallbacks = new Set<AstNode>();
        const loopContext = {
          get sourceCode() {
            return context.sourceCode;
          },
          get effectCallbacks() {
            return effectCallbacks;
          },
          effectRegistrations,
          get functionCallers() {
            return functionCallers;
          },
          reachingFunctions,
        } satisfies LoopContext;
        const calls: LoopCalls = {
          invocations: [],
          effectInvocations: [],
          cancels: { frame: [], interval: [] },
          starts: [],
        };
        return {
          before() {
            effectCallbacks.clear();
            effectRegistrations.clear();
            functionCallers.clear();
            reachingFunctions.clear();
            calls.invocations.length = 0;
            calls.starts.length = 0;
            calls.effectInvocations.length = 0;
            calls.cancels.frame.length = 0;
            calls.cancels.interval.length = 0;
            const { text } = context.sourceCode;
            return (
              text.includes(START_NAMES.frame) ||
              text.includes(START_NAMES.interval)
            );
          },
          CallExpression(node) {
            const call: unknown = node;
            if (!isAstNode(call)) {
              return;
            }
            calls.invocations.push(call);
            const callback = effectCallbackFor(loopContext, call);
            if (callback !== null) {
              effectRegistrations.set(call, callback);
            }
            for (const kind of ["frame", "interval"] as const) {
              if (isGlobalCall(loopContext, call, START_NAMES[kind])) {
                calls.starts.push({ kind, node: call });
              } else if (isGlobalCall(loopContext, call, CANCEL_NAMES[kind])) {
                const argument = callArguments(call).at(0);
                calls.cancels[kind].push({
                  argument: isAstNode(argument) ? argument : null,
                  node: call,
                });
              }
            }
          },
          "Program:exit"() {
            effectCallbacks = new Set(effectRegistrations.values());
            functionCallers = indexFunctionCallers(
              loopContext,
              calls.invocations,
            );
            calls.effectInvocations.push(...effectRegistrations.keys());
            const reports = [
              ...frameLoopReports(loopContext, calls),
              ...intervalReports(loopContext, calls),
            ];
            for (const { kind, messageId, node } of reports) {
              context.report({
                node,
                messageId,
                data: { start: START_NAMES[kind], cancel: CANCEL_NAMES[kind] },
              });
            }
          },
        };
      },
    },
  },
});
