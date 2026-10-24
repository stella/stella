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
  | { kind: "member"; text: string }
  | { kind: "transferred" };

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

// The effect callback a function sits in: the first argument of an effect
// hook call, found on the way out from `node`.
const enclosingEffect = (node: AstNode): AstNode | null => {
  for (const candidate of enclosingFunctions(node)) {
    const call = parentOf(candidate);
    if (
      call?.type === "CallExpression" &&
      callArguments(call).at(0) === candidate
    ) {
      const callee = unwrapExpression(call.callee);
      const name = isIdentifier(callee)
        ? callee.name
        : callee?.type === "MemberExpression"
          ? getPropertyName(callee.property)
          : null;
      if (name !== null && EFFECT_HOOKS.has(name)) {
        return candidate;
      }
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

type LoopContext = ScopeContext & { sourceCode: { text: string } };

type LoopStart = { kind: LoopKind; node: AstNode };

type LoopCalls = {
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
  const expression = unwrapExpression(node);
  if (expression === null) {
    return null;
  }
  if (isFunctionNode(expression)) {
    return expression;
  }
  if (!isIdentifierReference(expression)) {
    return null;
  }
  const variable = resolveVariable(context, expression);
  if (variable === null) {
    return null;
  }
  const definition = variable.defs.at(0);
  if (
    variable.defs.length === 1 &&
    definition?.type === "FunctionName" &&
    isFunctionNode(definition.node)
  ) {
    return definition.node;
  }
  const initializer = stableInitializer(variable);
  return isFunctionNode(initializer) ? initializer : null;
};

// The function a named call invokes, or null for any other call.
const namedCallTarget = (
  context: LoopContext,
  node: AstNode,
): AstNode | null =>
  node.type === "CallExpression" && isIdentifier(unwrapExpression(node.callee))
    ? functionFor(context, node.callee)
    : null;

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
    everyNode(inline).map((node) => namedCallTarget(context, node)),
  );
  return enclosing.find((candidate) => called.has(candidate)) ?? null;
};

// A binding returned or handed to another function transfers ownership of
// the handle.
const bindingHandle = (context: LoopContext, variable: Variable): Handle => {
  const transferred = variable.references.some((reference) => {
    const identifier: unknown = reference.identifier;
    if (!isAstNode(identifier)) {
      return false;
    }
    const parent = parentOf(identifier);
    if (parent?.type === "ReturnStatement") {
      return true;
    }
    return (
      parent?.type === "CallExpression" &&
      callArguments(parent).includes(identifier) &&
      !isGlobalCall(context, parent, CANCEL_NAMES.frame) &&
      !isGlobalCall(context, parent, CANCEL_NAMES.interval)
    );
  });
  return transferred ? { kind: "transferred" } : { kind: "binding", variable };
};

const assignedHandle = (
  context: LoopContext,
  target: AstNode | null,
): Handle | null => {
  if (isIdentifierReference(target)) {
    const variable = resolveVariable(context, target);
    return variable === null ? null : bindingHandle(context, variable);
  }
  return target?.type === "MemberExpression"
    ? { kind: "member", text: sourceText(context, target) }
    : null;
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
    return { kind: "transferred" };
  }
  const handedOver =
    parent.type === "ReturnStatement" ||
    (parent.type === "ArrowFunctionExpression" && parent.body === current) ||
    (parent.type === "CallExpression" &&
      callArguments(parent).includes(current));
  return handedOver ? { kind: "transferred" } : null;
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
    sourceText(context, argument) === handle.text
  );
};

// The functions an effect returns: inline, or bound to a returned name.
const returnedFunctions = (
  context: LoopContext,
  effect: AstNode,
): AstNode[] => {
  const returned: AstNode[] = [];
  const body = unwrapExpression(effect.body);
  if (effect.type === "ArrowFunctionExpression" && isFunctionNode(body)) {
    returned.push(body);
  }
  for (const node of everyNode(effect.body)) {
    if (
      node.type !== "ReturnStatement" ||
      enclosingFunctions(node).at(0) !== effect
    ) {
      continue;
    }
    const value = unwrapExpression(node.argument);
    if (isFunctionNode(value)) {
      returned.push(value);
    } else if (isIdentifierReference(value)) {
      const declared = functionFor(context, value);
      if (declared !== null) {
        returned.push(declared);
      }
      const variable = resolveVariable(context, value);
      for (const reference of variable?.references ?? []) {
        const written = unwrapExpression(reference.writeExpr);
        if (isFunctionNode(written)) {
          returned.push(written);
        }
      }
    }
  }
  return returned;
};

// Functions an effect returns as its cleanup, plus functions those cleanups
// call by name.
const cleanupFunctions = (context: LoopContext, effect: AstNode): AstNode[] => {
  const cleanups = new Set(returnedFunctions(context, effect));
  // Iterating the growing set follows invoked helpers once, including cycles.
  for (const cleanup of cleanups) {
    for (const node of everyNode(cleanup.body)) {
      if (
        node.type !== "CallExpression" ||
        enclosingFunctions(node).at(0) !== cleanup
      ) {
        continue;
      }
      const called = functionFor(context, node.callee);
      if (called !== null) {
        cleanups.add(called);
      }
    }
  }
  return [...cleanups];
};

// `start`'s loop body is `loopBody`; the effect enclosing `effectAnchor`,
// if any, must cancel it in its returned cleanup.
type OwnedLoop = {
  effectAnchor: AstNode;
  loopBody: AstNode | null;
  start: AstNode;
};

const isOwned = (
  context: LoopContext,
  cancels: Cancel[],
  { effectAnchor, loopBody, start }: OwnedLoop,
): boolean => {
  const handle = handleOf(context, start);
  if (handle === null) {
    return false;
  }
  if (handle.kind === "transferred") {
    return true;
  }
  const effect = enclosingEffect(effectAnchor);
  const owners = effect === null ? null : cleanupFunctions(context, effect);
  return cancels.some(
    (cancel) =>
      cancelsHandle(context, cancel, handle) &&
      (loopBody === null || !isWithin(cancel.node, loopBody)) &&
      (owners === null ||
        owners.some(
          (owner) => enclosingFunctions(cancel.node).at(0) === owner,
        )),
  );
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

type CounterDirectionOptions = {
  variable: Variable;
  call: AstNode;
  loop: AstNode;
};

const counterDirection = ({
  variable,
  call,
  loop,
}: CounterDirectionOptions): CounterDirection | null => {
  const definition = variable.defs.at(0);
  if (
    variable.defs.length !== 1 ||
    definition?.type !== "Variable" ||
    !isAstNode(definition.node) ||
    definition.node.type !== "VariableDeclarator" ||
    isWithin(definition.node, loop) ||
    integerValue(definition.node.init) === null
  ) {
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
      !isWithin(write, loop) ||
      !precedesOnPath({ write, call, loop })
    ) {
      return null;
    }
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
    const delta =
      write.type === "AssignmentExpression" && write.operator === "-="
        ? -step
        : step;
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
};

const boundedGuard = ({
  context,
  guard: { expression, outcome },
  call,
  loop,
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
      variable === null ? null : counterDirection({ variable, call, loop });
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
          ? (everyNode(inline)
              .map((candidate) => namedCallTarget(context, candidate))
              .find((target) => target !== null && loops.has(target)) ?? null)
          : null;
    const calls = loop === null ? undefined : loops.get(loop);
    calls?.push(node);
  }
  return loops;
};

const frameLoopReports = (
  context: LoopContext,
  { cancels, starts }: LoopCalls,
): Report[] => {
  const reports: Report[] = [];
  for (const [loop, calls] of frameLoops(context, starts)) {
    let bounded = true;
    for (const reschedule of calls.filter((call) => isWithin(call, loop))) {
      const guards = rescheduleGuards(reschedule, loop);
      if (guards === null) {
        bounded = false;
        reports.push({
          kind: "frame",
          messageId: "idleFrameLoop",
          node: reschedule,
        });
      } else if (
        !guards.some((guard) =>
          boundedGuard({ context, guard, loop, call: reschedule }),
        )
      ) {
        bounded = false;
      }
    }
    if (bounded) {
      continue;
    }
    for (const call of calls) {
      if (
        !isOwned(context, cancels.frame, {
          effectAnchor: loop,
          loopBody: loop,
          start: call,
        })
      ) {
        reports.push({ kind: "frame", messageId: "unownedLoop", node: call });
      }
    }
  }
  return reports;
};

const intervalReports = (
  context: LoopContext,
  { cancels, starts }: LoopCalls,
): Report[] =>
  starts
    .filter(
      ({ kind, node }) =>
        kind === "interval" &&
        !isOwned(context, cancels.interval, {
          effectAnchor: node,
          loopBody: functionFor(context, callArguments(node).at(0)),
          start: node,
        }),
    )
    .map(({ node }) => ({ kind: "interval", messageId: "unownedLoop", node }));

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
        const calls: LoopCalls = {
          cancels: { frame: [], interval: [] },
          starts: [],
        };
        return {
          before() {
            calls.starts.length = 0;
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
            for (const kind of ["frame", "interval"] as const) {
              if (isGlobalCall(context, call, START_NAMES[kind])) {
                calls.starts.push({ kind, node: call });
              } else if (isGlobalCall(context, call, CANCEL_NAMES[kind])) {
                const argument = callArguments(call).at(0);
                calls.cancels[kind].push({
                  argument: isAstNode(argument) ? argument : null,
                  node: call,
                });
              }
            }
          },
          "Program:exit"() {
            const reports = [
              ...frameLoopReports(context, calls),
              ...intervalReports(context, calls),
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
