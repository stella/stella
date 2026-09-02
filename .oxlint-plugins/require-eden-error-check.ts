import {
  eslintCompatPlugin,
  type Ranged,
  type Variable,
} from "@oxlint/plugins";
// Prevents Eden treaty responses from being consumed through promise
// chaining or discarded outright, either of which lets a failed API call
// masquerade as success.
//
// `api.*` calls (the Eden treaty proxy from @/lib/api) resolve
// `{ data, error }` and never throw on a normal HTTP error response.
// `.then(cb)` without inspecting `response.error` inside `cb`, and
// `.catch(cb)` tacked on as if it were the error channel, both read as
// error handling while doing nothing of the sort — the exact bug fixed by
// hand in calendar-view.tsx and task-detail-panel.tsx (surfaced only
// because someone happened to notice the silent failure). A bare
// `await api...;` expression statement or a `void api...;` discard drops
// the resolved `{ data, error }` on the floor the same way.
//
// Assigned awaited responses are followed through their local lexical scope.
// Every path must inspect `.error`, destructure `error`, or pass the whole
// response to the canonical `unwrapEden` adapter before reading `.data`,
// escaping or returning the response, reassigning its binding, or leaving the
// scope. The analysis deliberately stays local: passing an unchecked response
// to an opaque helper is an escape rather than an assumed proof.
//
// Flags:
//   api.tasks({ id }).patch(body).then((response) => { ... })
//   api.tasks({ id }).patch(body).then(cb).catch(cb)
//   api.entities({ id })["some-route"].post(body).catch(cb)
//   await api.tasks({ id }).patch(body);      // bare statement, result discarded
//   api.tasks({ id }).patch(body);            // bare fire-and-forget, no await/void at all
//   void api.tasks({ id }).patch(body);       // explicit discard
//
// Allows:
//   const response = await api.tasks({ id }).patch(body);
//   if (response.error) { ... }
//   return response.data
//   const { data, error } = await api.tasks.get()
//   return unwrapEden(response)
//   promise.then(cb)            // chain rooted at a non-`api` identifier
//   apiResult.then(cb)          // `api` call already assigned to a variable;
//                                // trace the call site where the variable
//                                // was produced instead
//   const api = makeScopedClient(); api.tasks({ id }).patch(body);
//                                     // a local `api` that shadows the
//                                     // `@/lib/api` import resolves to a
//                                     // different binding (see scope
//                                     // resolution below) and is not flagged
//
// Escape hatch: none by design — every Eden call site should be consumable
// with `await` and an explicit `response.error` check. If a call is
// genuinely fire-and-forget, wrap it in `void (async () => { ... })()` (or
// `Result.tryPromise` for a throwaway mutation) and still check
// `response.error` inside. If checking the result is truly meaningless for
// a specific best-effort call, suppress with `// eslint-disable-next-line
// require-eden-error-check -- SAFETY: <reason>` rather than leaving the
// discard unexplained.
//
// Shadowing: the root identifier of a flagged chain is resolved through
// oxlint's scope API (`context.sourceCode.getScope` + `Scope.set`, walking
// `.upper` the way ESLint's `findVariable` does) to the `Variable` it
// actually refers to at that use site, and only flagged when that
// variable's declaration is the `api` import from `@/lib/api` itself. A
// local `api` (parameter, destructure, `const api = ...`) that shadows the
// import resolves to a different `Variable` and is left alone.
//
// Aliasing: a chain root that is not the `api` import itself is also
// treated as an Eden root when it resolves to a `const`/`let` variable
// whose own initializer is itself Eden-rooted (recursively, via the same
// chain-root walk) — e.g. `const wsClient = api.uploads({ id });
// wsClient.presign.post(body).then(cb)`. Resolution stops (does not flag)
// at `var`, function parameters, and reassignments: only a
// `VariableDeclarator`'s own initializer is inspected, capped at
// `MAX_ALIAS_DEPTH` hops and guarded by a `visited` set against declaration
// cycles.

import {
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const API_MODULE = "@/lib/api";
// Adapters that take the whole Eden response and own its error channel,
// keyed by the module that exports them.
const APPROVED_RESPONSE_ADAPTERS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  ["@/lib/errors/api", new Set(["unwrapEden"])],
  ["@/lib/public-law-api", new Set(["unwrapPublicLawEden"])],
]);
const EDEN_HTTP_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
]);

type FlowState = "absent" | "dead" | "handled" | "unhandled";

type FlowOutcome = {
  states: Set<FlowState>;
  unsafe: boolean;
  unsafeExit?: AstNode | undefined;
};

// Walk a call/member chain down to its syntactic root, unwrapping both
// `foo(...)` (CallExpression -> callee) and `foo.bar` / `foo["bar"]`
// (MemberExpression -> object, computed or not) at every step. Returns the
// root Identifier node, or the last non-Identifier node reached (e.g. a
// function expression for an IIFE) when the chain does not root at a bare
// name.
const getChainRoot = (node: unknown): unknown => {
  let current = unwrapExpression(node);
  while (isAstNode(current)) {
    if (current.type === "CallExpression" || current.type === "NewExpression") {
      current = unwrapExpression(current.callee);
      continue;
    }
    if (current.type === "MemberExpression") {
      current = unwrapExpression(current.object);
      continue;
    }
    break;
  }
  return current;
};

// True when `node` (already unwrapped) is a `.then(...)`/`.catch(...)` call:
// used to keep the direct-discard checks below from double-reporting a call
// chain the CallExpression visitor already flags on its own.
const isThenOrCatchCall = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  if (
    !isAstNode(callee) ||
    callee.type !== "MemberExpression" ||
    callee.computed !== false
  ) {
    return false;
  }
  const method = getPropertyName(callee.property);
  return method === "then" || method === "catch";
};

export default eslintCompatPlugin({
  meta: { name: "require-eden-error-check" },
  rules: {
    "require-eden-error-check": {
      meta: {
        type: "problem",
        messages: {
          requireEdenErrorCheck:
            "Eden response consumed via '.{{method}}()'. api.* calls resolve " +
            "{ data, error } and never throw, so promise chaining can let a " +
            "failed request masquerade as success. Use `const response = " +
            "await api...; if (response.error) { ... }` (toAPIError for the " +
            "message) instead.",
          requireEdenErrorCheckDiscarded:
            "Eden call result discarded via '{{form}}'. api.* calls resolve " +
            "{ data, error } and never throw, so discarding the result can " +
            "let a failed request masquerade as success. Use `const " +
            "response = await api...; if (response.error) { ... }` " +
            "(toAPIError for the message) instead.",
          requireEdenAssignedErrorCheck:
            "This assigned Eden response can be consumed or leave scope " +
            "without its error channel being inspected. Check `.error`, " +
            "destructure `{ data, error }`, or pass the response to the " +
            "imported `unwrapEden()` adapter before using `.data` or " +
            "letting the response escape.",
        },
      },
      createOnce(context) {
        const apiLocalNames = new Set<string>();
        const pendingEdenBindings = new Map<Variable, Ranged>();
        const assignedResults: {
          binding: Variable;
          canBeAbsent: boolean;
          node: Ranged;
        }[] = [];

        // Resolve the `Variable` an Identifier reference binds to by
        // walking the scope chain outward from its use site — the same
        // nearest-enclosing-declaration search ESLint's `findVariable`
        // utility does, built on oxlint's `getScope`/`Scope.set` since this
        // plugin API has no ready-made `findVariable` helper of its own.
        const resolveVariable = (identifierNode) => {
          const findVariable = (scope) =>
            scope?.set.get(identifierNode.name) ??
            (scope?.upper ? findVariable(scope.upper) : null);
          return findVariable(context.sourceCode.getScope(identifierNode));
        };

        // True when `variable` is the binding introduced by `import { api }
        // from "@/lib/api"` (or an aliased form of it) — i.e. the actual
        // import, not a same-named local that shadows it.
        const isApiImportVariable = (
          variable: ReturnType<typeof resolveVariable>,
        ) =>
          variable !== null &&
          variable.defs.some((def) => {
            if (def.type !== "ImportBinding" || !isAstNode(def.node)) {
              return false;
            }
            if (getImportedName(def.node) !== "api") {
              return false;
            }
            if (
              !isAstNode(def.parent) ||
              def.parent.type !== "ImportDeclaration"
            ) {
              return false;
            }
            return (
              isStringLiteral(def.parent.source) &&
              def.parent.source.value === API_MODULE
            );
          });

        // A chain root only counts as a direct Eden `api` root when it is
        // both spelled like the import (fast pre-check against the
        // `apiLocalNames` set collected from `ImportDeclaration`) and
        // resolves, through scope, to that same import binding rather than
        // a local shadow (parameter, destructure, `const api = ...`).
        const isDirectApiRoot = (root: unknown): boolean => {
          if (!isIdentifier(root) || !apiLocalNames.has(root.name)) {
            return false;
          }
          return isApiImportVariable(resolveVariable(root));
        };

        // Alias-chain hop cap: comfortably covers realistic
        // `const a = api...; const b = a...;` aliasing depth while keeping a
        // runaway or (guarded-against but cheap to also bound) cyclic chain
        // from walking indefinitely.
        const MAX_ALIAS_DEPTH = 5;

        // True when `root` is either the `api` import itself, or (up to
        // `MAX_ALIAS_DEPTH` hops) a local `const`/`let` variable whose own
        // initializer is itself Eden-rooted — see the "Aliasing" doc comment
        // above. `visited` guards against declaration cycles across hops.
        const isGenuineApiRoot = (
          root: unknown,
          visited = new Set<unknown>(),
          depth = 0,
        ): boolean => {
          if (isDirectApiRoot(root)) {
            return true;
          }
          if (depth >= MAX_ALIAS_DEPTH || !isIdentifier(root)) {
            return false;
          }
          const variable = resolveVariable(root);
          if (variable === null || visited.has(variable)) {
            return false;
          }
          visited.add(variable);
          return variable.defs.some((def) => {
            if (def.type !== "Variable" || !isAstNode(def.node)) {
              return false;
            }
            if (def.node.type !== "VariableDeclarator") {
              return false;
            }
            // Only `const`/`let` initializers are traced; `var` is left
            // alone since its hoisting/reassignment semantics make "the"
            // initializer a weaker signal.
            if (
              !isAstNode(def.parent) ||
              def.parent.type !== "VariableDeclaration" ||
              def.parent.kind === "var"
            ) {
              return false;
            }
            const init = def.node.init;
            if (!isAstNode(init)) {
              return false;
            }
            return isGenuineApiRoot(getChainRoot(init), visited, depth + 1);
          });
        };

        const terminalEdenCall = (node: unknown): AstNode | null => {
          const call = unwrapExpression(node);
          if (!isAstNode(call) || call.type !== "CallExpression") {
            return null;
          }
          const callee = unwrapExpression(call.callee);
          if (!isAstNode(callee) || callee.type !== "MemberExpression") {
            return null;
          }
          const method = getPropertyName(callee.property);
          if (method === null || !EDEN_HTTP_METHODS.has(method)) {
            return null;
          }
          return isGenuineApiRoot(getChainRoot(call)) ? call : null;
        };

        const awaitedTerminalEdenCall = (node: unknown): AstNode | null => {
          const awaited = unwrapExpression(node);
          if (!isAstNode(awaited) || awaited.type !== "AwaitExpression") {
            return null;
          }
          const direct = terminalEdenCall(awaited.argument);
          if (direct !== null) {
            return direct;
          }
          const operand = unwrapExpression(awaited.argument);
          if (!isIdentifier(operand)) {
            return null;
          }
          const binding = resolveVariable(operand);
          return binding !== null && pendingEdenBindings.has(binding)
            ? awaited
            : null;
        };

        const containsAwaitedTerminalEdenValue = (node: unknown): boolean => {
          if (awaitedTerminalEdenCall(node) !== null) {
            return true;
          }
          const expression = unwrapExpression(node);
          return (
            isAstNode(expression) &&
            expression.type === "ConditionalExpression" &&
            (containsAwaitedTerminalEdenValue(expression.consequent) ||
              containsAwaitedTerminalEdenValue(expression.alternate))
          );
        };

        const hasNonEdenPath = (node: unknown): boolean => {
          if (awaitedTerminalEdenCall(node) !== null) {
            return false;
          }
          const expression = unwrapExpression(node);
          if (
            !isAstNode(expression) ||
            expression.type !== "ConditionalExpression"
          ) {
            return true;
          }
          return (
            hasNonEdenPath(expression.consequent) ||
            hasNonEdenPath(expression.alternate)
          );
        };

        const isApprovedResponseAdapter = (node: unknown): boolean => {
          const callee = unwrapExpression(node);
          if (!isIdentifier(callee)) {
            return false;
          }
          const variable = resolveVariable(callee);
          return (
            variable !== null &&
            variable.defs.some((definition) => {
              if (
                definition.type !== "ImportBinding" ||
                !isAstNode(definition.node) ||
                !isAstNode(definition.parent) ||
                definition.parent.type !== "ImportDeclaration" ||
                !isStringLiteral(definition.parent.source)
              ) {
                return false;
              }
              const adapters = APPROVED_RESPONSE_ADAPTERS.get(
                definition.parent.source.value,
              );
              const importedName = getImportedName(definition.node);
              return (
                adapters !== undefined &&
                importedName !== null &&
                adapters.has(importedName)
              );
            })
          );
        };

        const isBindingIdentifier = (
          node: unknown,
          binding: unknown,
        ): boolean => {
          const expression = unwrapExpression(node);
          return (
            isIdentifier(expression) && resolveVariable(expression) === binding
          );
        };

        const hasUnhandled = (states: ReadonlySet<FlowState>): boolean =>
          states.has("unhandled");

        const handledStates = (
          states: ReadonlySet<FlowState>,
        ): Set<FlowState> => {
          const next = new Set<FlowState>();
          for (const state of states) {
            next.add(state === "unhandled" ? "handled" : state);
          }
          return next;
        };

        const deadStates = (states: ReadonlySet<FlowState>): Set<FlowState> => {
          const next = new Set<FlowState>();
          if (states.size > 0) {
            next.add("dead");
          }
          return next;
        };

        const mergeStates = (
          ...stateSets: readonly ReadonlySet<FlowState>[]
        ): Set<FlowState> => {
          const merged = new Set<FlowState>();
          for (const states of stateSets) {
            for (const state of states) {
              merged.add(state);
            }
          }
          return merged;
        };

        const containsBindingReference = (
          node: unknown,
          binding: unknown,
          seen = new Set<unknown>(),
        ): boolean => {
          if (!isAstNode(node) || seen.has(node)) {
            return false;
          }
          seen.add(node);
          if (isBindingIdentifier(node, binding)) {
            return true;
          }
          for (const [key, value] of Object.entries(node)) {
            if (key === "parent") {
              continue;
            }
            if (Array.isArray(value)) {
              if (
                value.some((child) =>
                  containsBindingReference(child, binding, seen),
                )
              ) {
                return true;
              }
              continue;
            }
            if (containsBindingReference(value, binding, seen)) {
              return true;
            }
          }
          return false;
        };

        const childNodes = (node: AstNode): AstNode[] => {
          const children: AstNode[] = [];
          for (const [key, value] of Object.entries(node)) {
            if (key === "parent") {
              continue;
            }
            if (Array.isArray(value)) {
              for (const child of value) {
                if (isAstNode(child)) {
                  children.push(child);
                }
              }
              continue;
            }
            if (isAstNode(value)) {
              children.push(value);
            }
          }
          return children;
        };

        const patternProperties = (pattern: unknown): Set<string> => {
          const properties = new Set<string>();
          if (!isAstNode(pattern) || pattern.type !== "ObjectPattern") {
            return properties;
          }
          const patternItems = Array.isArray(pattern.properties)
            ? pattern.properties
            : [];
          for (const property of patternItems) {
            if (!isAstNode(property) || property.type !== "Property") {
              continue;
            }
            const name = getPropertyName(property.key);
            if (name !== null) {
              properties.add(name);
            }
          }
          return properties;
        };

        const analyzeExpression = (
          node: unknown,
          states: ReadonlySet<FlowState>,
          binding: unknown,
        ): FlowOutcome => {
          const expression = unwrapExpression(node);
          if (!isAstNode(expression)) {
            return { states: new Set(states), unsafe: false };
          }

          if (isBindingIdentifier(expression, binding)) {
            return {
              states: new Set(states),
              unsafe: hasUnhandled(states),
            };
          }

          // `typeof response` observes only the binding's runtime kind; it
          // neither consumes nor exports the Eden response. Keeping it
          // neutral also gives the scope-completion fixture a non-vacuous
          // use without pretending that it checks the error channel.
          if (
            expression.type === "UnaryExpression" &&
            expression.operator === "typeof" &&
            isBindingIdentifier(expression.argument, binding)
          ) {
            return { states: new Set(states), unsafe: false };
          }

          if (
            expression.type === "MemberExpression" &&
            isBindingIdentifier(expression.object, binding)
          ) {
            const property =
              expression.computed === true
                ? isStringLiteral(expression.property)
                  ? expression.property.value
                  : null
                : getPropertyName(expression.property);
            if (property === "error") {
              return { states: handledStates(states), unsafe: false };
            }
            return {
              states: new Set(states),
              unsafe: hasUnhandled(states),
            };
          }

          if (
            expression.type === "ArrowFunctionExpression" ||
            expression.type === "FunctionExpression" ||
            expression.type === "FunctionDeclaration"
          ) {
            return {
              states: new Set(states),
              unsafe:
                hasUnhandled(states) &&
                containsBindingReference(expression, binding),
            };
          }

          if (
            expression.type === "CallExpression" ||
            expression.type === "NewExpression"
          ) {
            let current = new Set(states);
            let unsafe = false;
            const approved = isApprovedResponseAdapter(expression.callee);
            const calleeOutcome = analyzeExpression(
              expression.callee,
              current,
              binding,
            );
            current = calleeOutcome.states;
            unsafe ||= calleeOutcome.unsafe;
            const argumentsList = Array.isArray(expression.arguments)
              ? expression.arguments
              : [];
            for (const argument of argumentsList) {
              if (isBindingIdentifier(argument, binding)) {
                if (approved) {
                  current = handledStates(current);
                } else {
                  unsafe ||= hasUnhandled(current);
                }
                continue;
              }
              const outcome = analyzeExpression(argument, current, binding);
              current = outcome.states;
              unsafe ||= outcome.unsafe;
            }
            return { states: current, unsafe };
          }

          if (expression.type === "ConditionalExpression") {
            const test = analyzeExpression(expression.test, states, binding);
            const consequent = analyzeExpression(
              expression.consequent,
              test.states,
              binding,
            );
            const alternate = analyzeExpression(
              expression.alternate,
              test.states,
              binding,
            );
            return {
              states: mergeStates(consequent.states, alternate.states),
              unsafe: test.unsafe || consequent.unsafe || alternate.unsafe,
            };
          }

          if (expression.type === "LogicalExpression") {
            const left = analyzeExpression(expression.left, states, binding);
            const right = analyzeExpression(
              expression.right,
              left.states,
              binding,
            );
            return {
              states: mergeStates(left.states, right.states),
              unsafe: left.unsafe || right.unsafe,
            };
          }

          if (expression.type === "AssignmentExpression") {
            if (isBindingIdentifier(expression.right, binding)) {
              const properties = patternProperties(expression.left);
              return properties.has("error")
                ? { states: handledStates(states), unsafe: false }
                : { states: new Set(states), unsafe: hasUnhandled(states) };
            }

            const right = analyzeExpression(expression.right, states, binding);
            if (isBindingIdentifier(expression.left, binding)) {
              return {
                states: deadStates(right.states),
                unsafe: right.unsafe || hasUnhandled(right.states),
              };
            }

            const leftTarget = unwrapExpression(expression.left);
            if (
              expression.operator === "=" &&
              isAstNode(leftTarget) &&
              leftTarget.type === "MemberExpression" &&
              isBindingIdentifier(leftTarget.object, binding)
            ) {
              return {
                states: right.states,
                unsafe: right.unsafe || hasUnhandled(right.states),
              };
            }
            const left = analyzeExpression(
              expression.left,
              right.states,
              binding,
            );
            return {
              states: left.states,
              unsafe: right.unsafe || left.unsafe,
            };
          }

          if (expression.type === "UpdateExpression") {
            if (!isBindingIdentifier(expression.argument, binding)) {
              return analyzeExpression(expression.argument, states, binding);
            }
            return {
              states: deadStates(states),
              unsafe: hasUnhandled(states),
            };
          }

          if (expression.type === "SequenceExpression") {
            let current = new Set(states);
            let unsafe = false;
            const expressions = Array.isArray(expression.expressions)
              ? expression.expressions
              : [];
            for (const item of expressions) {
              const outcome = analyzeExpression(item, current, binding);
              current = outcome.states;
              unsafe ||= outcome.unsafe;
            }
            return { states: current, unsafe };
          }

          let current = new Set(states);
          let unsafe = false;
          for (const child of childNodes(expression)) {
            const outcome = analyzeExpression(child, current, binding);
            current = outcome.states;
            unsafe ||= outcome.unsafe;
          }
          return { states: current, unsafe };
        };

        const analyzeStatements = (
          statements: readonly unknown[],
          states: ReadonlySet<FlowState>,
          binding: unknown,
        ): FlowOutcome => {
          let current = new Set(states);
          let unsafe = false;
          let unsafeExit: AstNode | undefined;
          for (const statement of statements) {
            const outcome = analyzeStatement(statement, current, binding);
            current = outcome.states;
            unsafe ||= outcome.unsafe;
            unsafeExit ??= outcome.unsafeExit;
          }
          return { states: current, unsafe, unsafeExit };
        };

        const analyzeDeclarators = (
          declarations: readonly unknown[],
          states: ReadonlySet<FlowState>,
          binding: unknown,
        ): FlowOutcome => {
          let current = new Set(states);
          let unsafe = false;
          for (const declaration of declarations) {
            if (
              !isAstNode(declaration) ||
              declaration.type !== "VariableDeclarator"
            ) {
              continue;
            }
            if (isBindingIdentifier(declaration.init, binding)) {
              const properties = patternProperties(declaration.id);
              if (properties.has("error")) {
                current = handledStates(current);
              } else {
                unsafe ||= hasUnhandled(current);
              }
              continue;
            }
            const outcome = analyzeExpression(
              declaration.init,
              current,
              binding,
            );
            current = outcome.states;
            unsafe ||= outcome.unsafe;
          }
          return { states: current, unsafe };
        };

        const analyzeExitStatement = (
          node: AstNode,
          states: ReadonlySet<FlowState>,
          binding: unknown,
        ): FlowOutcome => {
          const argument = analyzeExpression(node.argument, states, binding);
          const exitsUnhandled = hasUnhandled(argument.states);
          return {
            states: deadStates(argument.states),
            unsafe: argument.unsafe || exitsUnhandled,
            unsafeExit:
              argument.unsafeExit ??
              (exitsUnhandled &&
              !containsBindingReference(node.argument, binding)
                ? node
                : undefined),
          };
        };

        // `response === null` / `response !== null` tests split the flow by
        // presence; any other test is analyzed as an ordinary expression.
        const nullComparisonOf = (
          test: unknown,
          binding: unknown,
        ): "absent" | "present" | null => {
          const expression = unwrapExpression(test);
          if (
            !isAstNode(expression) ||
            expression.type !== "BinaryExpression"
          ) {
            return null;
          }
          const left = unwrapExpression(expression.left);
          const right = unwrapExpression(expression.right);
          const comparesBindingToNull =
            (isBindingIdentifier(left, binding) &&
              isAstNode(right) &&
              right.type === "Literal" &&
              right.value === null) ||
            (isBindingIdentifier(right, binding) &&
              isAstNode(left) &&
              left.type === "Literal" &&
              left.value === null);
          if (!comparesBindingToNull) {
            return null;
          }
          if (expression.operator === "===" || expression.operator === "==") {
            return "absent";
          }
          if (expression.operator === "!==" || expression.operator === "!=") {
            return "present";
          }
          return null;
        };

        const analyzeBranches = (
          node: AstNode,
          consequentStates: ReadonlySet<FlowState>,
          alternateStates: ReadonlySet<FlowState>,
          binding: unknown,
        ): FlowOutcome => {
          const consequent = analyzeStatement(
            node.consequent,
            consequentStates,
            binding,
          );
          const alternate = isAstNode(node.alternate)
            ? analyzeStatement(node.alternate, alternateStates, binding)
            : {
                states: new Set(alternateStates),
                unsafe: false,
                unsafeExit: undefined,
              };
          return {
            states: mergeStates(consequent.states, alternate.states),
            unsafe: consequent.unsafe || alternate.unsafe,
            unsafeExit: consequent.unsafeExit ?? alternate.unsafeExit,
          };
        };

        const analyzeIfStatement = (
          node: AstNode,
          states: ReadonlySet<FlowState>,
          binding: unknown,
        ): FlowOutcome => {
          const nullComparison = nullComparisonOf(node.test, binding);
          if (nullComparison !== null) {
            const absentStates = new Set<FlowState>();
            const presentStates = new Set<FlowState>();
            for (const state of states) {
              if (state === "absent") {
                absentStates.add(state);
              } else {
                presentStates.add(state);
              }
            }
            return nullComparison === "absent"
              ? analyzeBranches(node, absentStates, presentStates, binding)
              : analyzeBranches(node, presentStates, absentStates, binding);
          }
          const test = analyzeExpression(node.test, states, binding);
          const branches = analyzeBranches(
            node,
            test.states,
            test.states,
            binding,
          );
          return {
            states: branches.states,
            unsafe: test.unsafe || branches.unsafe,
            unsafeExit: test.unsafeExit ?? branches.unsafeExit,
          };
        };

        const analyzeLoopStatement = (
          node: AstNode,
          states: ReadonlySet<FlowState>,
          binding: unknown,
        ): FlowOutcome => {
          const entry = analyzeExpression(node.init, states, binding);
          const test = analyzeExpression(node.test, entry.states, binding);
          const right = analyzeExpression(node.right, test.states, binding);
          const body = analyzeStatement(node.body, right.states, binding);
          const update = analyzeExpression(node.update, body.states, binding);
          return {
            states: mergeStates(test.states, update.states),
            unsafe:
              entry.unsafe ||
              test.unsafe ||
              right.unsafe ||
              body.unsafe ||
              update.unsafe,
            unsafeExit:
              entry.unsafeExit ??
              test.unsafeExit ??
              right.unsafeExit ??
              body.unsafeExit ??
              update.unsafeExit,
          };
        };

        const analyzeSwitchStatement = (
          node: AstNode,
          states: ReadonlySet<FlowState>,
          binding: unknown,
        ): FlowOutcome => {
          const discriminant = analyzeExpression(
            node.discriminant,
            states,
            binding,
          );
          const cases = Array.isArray(node.cases) ? node.cases : [];
          const hasDefault = cases.some(
            (switchCase) => isAstNode(switchCase) && switchCase.test === null,
          );
          const branches: Set<FlowState>[] = hasDefault
            ? []
            : [new Set(discriminant.states)];
          let unsafe = discriminant.unsafe;
          let unsafeExit = discriminant.unsafeExit;
          for (const switchCase of cases) {
            if (!isAstNode(switchCase)) {
              continue;
            }
            const test = analyzeExpression(
              switchCase.test,
              discriminant.states,
              binding,
            );
            const branch = analyzeStatements(
              Array.isArray(switchCase.consequent) ? switchCase.consequent : [],
              test.states,
              binding,
            );
            branches.push(branch.states);
            unsafe ||= test.unsafe || branch.unsafe;
            unsafeExit ??= test.unsafeExit ?? branch.unsafeExit;
          }
          return {
            states: mergeStates(...branches),
            unsafe,
            unsafeExit,
          };
        };

        const analyzeTryStatement = (
          node: AstNode,
          states: ReadonlySet<FlowState>,
          binding: unknown,
        ): FlowOutcome => {
          const tried = analyzeStatement(node.block, states, binding);
          // An explicit throw carries the state reached in the try body.
          // Starting catch from the pre-try state would resurrect an
          // already-inspected response and falsely reject a catch return.
          const caught = isAstNode(node.handler)
            ? analyzeStatement(node.handler.body, tried.states, binding)
            : {
                states: new Set<FlowState>(),
                unsafe: false,
                unsafeExit: undefined,
              };
          const combined = {
            states: mergeStates(tried.states, caught.states),
            unsafe: tried.unsafe || caught.unsafe,
            unsafeExit: tried.unsafeExit ?? caught.unsafeExit,
          };
          if (!isAstNode(node.finalizer)) {
            return combined;
          }
          const finalizerInput = combined.unsafeExit
            ? mergeStates(combined.states, states)
            : combined.states;
          const finalized = analyzeStatement(
            node.finalizer,
            finalizerInput,
            binding,
          );
          const pendingExitHandled =
            combined.unsafeExit !== undefined &&
            !hasUnhandled(finalized.states);
          return {
            states: finalized.states,
            unsafe:
              (combined.unsafe && !pendingExitHandled) || finalized.unsafe,
            unsafeExit: combined.unsafeExit ?? finalized.unsafeExit,
          };
        };

        const analyzeStatement = (
          node: unknown,
          states: ReadonlySet<FlowState>,
          binding: unknown,
        ): FlowOutcome => {
          if (!isAstNode(node)) {
            return { states: new Set(states), unsafe: false };
          }

          switch (node.type) {
            case "BlockStatement":
              return analyzeStatements(
                Array.isArray(node.body) ? node.body : [],
                states,
                binding,
              );
            case "ExpressionStatement":
              return analyzeExpression(node.expression, states, binding);
            case "VariableDeclaration":
              return analyzeDeclarators(
                Array.isArray(node.declarations) ? node.declarations : [],
                states,
                binding,
              );
            case "ReturnStatement":
            case "ThrowStatement":
              return analyzeExitStatement(node, states, binding);
            case "IfStatement":
              return analyzeIfStatement(node, states, binding);
            case "DoWhileStatement": {
              const body = analyzeStatement(node.body, states, binding);
              const test = analyzeExpression(node.test, body.states, binding);
              return {
                states: mergeStates(body.states, test.states),
                unsafe: body.unsafe || test.unsafe,
                unsafeExit: body.unsafeExit ?? test.unsafeExit,
              };
            }
            case "ForStatement":
            case "ForInStatement":
            case "ForOfStatement":
            case "WhileStatement":
              return analyzeLoopStatement(node, states, binding);
            case "SwitchStatement":
              return analyzeSwitchStatement(node, states, binding);
            case "TryStatement":
              return analyzeTryStatement(node, states, binding);
            case "LabeledStatement":
            case "WithStatement":
              return analyzeStatement(node.body, states, binding);
            default:
              return analyzeExpression(node, states, binding);
          }
        };

        const analyzeContinuation = (
          node: unknown,
          binding: Variable,
          canBeAbsent: boolean,
        ): FlowOutcome => {
          let current = isAstNode(node) ? node : null;
          let states = new Set<FlowState>(["unhandled"]);
          if (canBeAbsent) {
            states.add("absent");
          }
          let unsafe = false;
          let unsafeExit: AstNode | undefined;

          if (
            current?.type === "VariableDeclarator" &&
            isAstNode(current.parent) &&
            current.parent.type === "VariableDeclaration"
          ) {
            const declarations = Array.isArray(current.parent.declarations)
              ? current.parent.declarations
              : [];
            const index = declarations.indexOf(current);
            const siblings = analyzeDeclarators(
              index === -1 ? [] : declarations.slice(index + 1),
              states,
              binding,
            );
            states = siblings.states;
            unsafe = siblings.unsafe;
            current = current.parent;
          }

          while (current !== null) {
            const parent = isAstNode(current.parent) ? current.parent : null;
            if (
              parent !== null &&
              (parent.type === "BlockStatement" || parent.type === "Program") &&
              Array.isArray(parent.body)
            ) {
              const index = parent.body.indexOf(current);
              if (index !== -1) {
                const outcome = analyzeStatements(
                  parent.body.slice(index + 1),
                  states,
                  binding,
                );
                states = outcome.states;
                unsafe ||= outcome.unsafe;
                unsafeExit ??= outcome.unsafeExit;

                // A declaration's block is normally reached immediately.
                // An assignment may sit in a nested branch or try block;
                // keep climbing until the assigned binding's own lexical
                // scope so its outer continuation is not hidden.
                if (Object.is(parent, binding.scope.block)) {
                  return { states, unsafe, unsafeExit };
                }
              }
            }

            // A finally block runs after an acquisition in the try body and
            // before the enclosing statement continuation.
            if (
              parent?.type === "TryStatement" &&
              current === parent.block &&
              isAstNode(parent.finalizer)
            ) {
              const finalized = analyzeStatement(
                parent.finalizer,
                states,
                binding,
              );
              states = finalized.states;
              unsafe ||= finalized.unsafe;
              unsafeExit ??= finalized.unsafeExit;
            }

            current = parent;
          }

          return { states, unsafe, unsafeExit };
        };

        const reportAssignedResult = (node: Ranged): void => {
          context.report({
            node,
            messageId: "requireEdenAssignedErrorCheck",
          });
        };

        return {
          before() {
            apiLocalNames.clear();
            pendingEdenBindings.clear();
            assignedResults.length = 0;
          },
          ImportDeclaration(node) {
            if (node.source?.value !== API_MODULE) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (getImportedName(specifier) === "api") {
                apiLocalNames.add(specifier.local.name);
              }
            }
          },

          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              !isAstNode(callee) ||
              callee.type !== "MemberExpression" ||
              callee.computed !== false
            ) {
              return;
            }

            const method = getPropertyName(callee.property);
            if (method !== "then" && method !== "catch") {
              return;
            }

            const root = getChainRoot(callee.object);
            if (!isGenuineApiRoot(root)) {
              return;
            }

            context.report({
              node,
              messageId: "requireEdenErrorCheck",
              data: { method },
            });
          },

          VariableDeclarator(node) {
            if (
              terminalEdenCall(node.init) !== null &&
              isIdentifier(node.id) &&
              isAstNode(node.parent) &&
              node.parent.type === "VariableDeclaration" &&
              node.parent.kind === "const"
            ) {
              const binding = resolveVariable(node.id);
              if (binding !== null) {
                pendingEdenBindings.set(binding, node);
              }
              return;
            }
            if (!containsAwaitedTerminalEdenValue(node.init)) {
              return;
            }
            if (isIdentifier(node.id)) {
              const binding = resolveVariable(node.id);
              if (binding !== null) {
                assignedResults.push({
                  binding,
                  canBeAbsent: hasNonEdenPath(node.init),
                  node,
                });
              }
              return;
            }
            if (!patternProperties(node.id).has("error")) {
              reportAssignedResult(node);
            }
          },

          AssignmentExpression(node) {
            if (!containsAwaitedTerminalEdenValue(node.right)) {
              return;
            }
            if (isIdentifier(node.left)) {
              const binding = resolveVariable(node.left);
              if (binding !== null) {
                assignedResults.push({
                  binding,
                  canBeAbsent: hasNonEdenPath(node.right),
                  node,
                });
              }
              return;
            }
            if (!patternProperties(node.left).has("error")) {
              reportAssignedResult(node);
            }
          },

          AwaitExpression(node) {
            if (awaitedTerminalEdenCall(node) === null) {
              return;
            }

            const operand = unwrapExpression(node.argument);
            if (isIdentifier(operand)) {
              const pendingBinding = resolveVariable(operand);
              if (pendingBinding !== null) {
                pendingEdenBindings.delete(pendingBinding);
              }
            }

            let expression = unwrapExpression(node);
            if (!isAstNode(expression)) {
              return;
            }
            let parent = isAstNode(expression.parent)
              ? expression.parent
              : null;
            while (
              parent !== null &&
              (parent.type === "TSAsExpression" ||
                parent.type === "TSNonNullExpression" ||
                parent.type === "TSSatisfiesExpression" ||
                parent.type === "TSTypeAssertion" ||
                (parent.type === "ConditionalExpression" &&
                  (parent.consequent === expression ||
                    parent.alternate === expression)))
            ) {
              expression = parent;
              parent = isAstNode(expression.parent) ? expression.parent : null;
            }

            if (
              (parent?.type === "VariableDeclarator" &&
                parent.init === expression) ||
              (parent?.type === "AssignmentExpression" &&
                parent.right === expression) ||
              (parent?.type === "ExpressionStatement" &&
                parent.expression === expression)
            ) {
              return;
            }
            if (
              parent?.type === "MemberExpression" &&
              parent.object === expression &&
              (parent.computed === true
                ? isStringLiteral(parent.property) &&
                  parent.property.value === "error"
                : getPropertyName(parent.property) === "error")
            ) {
              return;
            }
            if (
              parent?.type === "CallExpression" &&
              Array.isArray(parent.arguments) &&
              parent.arguments.includes(expression) &&
              isApprovedResponseAdapter(parent.callee)
            ) {
              return;
            }

            reportAssignedResult(node);
          },

          // `await api...;` as a bare expression statement, or a bare
          // fire-and-forget `api...;` statement with no `await`/`void` at
          // all: the resolved `{ data, error }` is never bound to anything,
          // so `error` can never be inspected.
          ExpressionStatement(node) {
            const expression = unwrapExpression(node.expression);
            if (!isAstNode(expression)) {
              return;
            }

            if (expression.type === "AwaitExpression") {
              const argument = unwrapExpression(expression.argument);
              // Already flagged by the CallExpression visitor above; do not
              // double-report the same discard.
              if (isThenOrCatchCall(argument)) {
                return;
              }

              const root = getChainRoot(argument);
              if (!isGenuineApiRoot(root)) {
                return;
              }

              context.report({
                node,
                messageId: "requireEdenErrorCheckDiscarded",
                data: { form: "await api...;" },
              });
              return;
            }

            if (expression.type === "CallExpression") {
              // Already flagged by the CallExpression visitor above (as
              // chained consumption) or would be a false match on a call
              // that merely ends in a differently-named method; do not
              // double-report `.then()`/`.catch()` chains here.
              if (isThenOrCatchCall(expression)) {
                return;
              }

              const root = getChainRoot(expression);
              if (!isGenuineApiRoot(root)) {
                return;
              }

              context.report({
                node,
                messageId: "requireEdenErrorCheckDiscarded",
                data: { form: "api...; (no await, no void)" },
              });
            }
          },

          // `void api...;`: an explicit discard of the resolved
          // `{ data, error }`.
          UnaryExpression(node) {
            if (node.operator !== "void") {
              return;
            }

            const argument = unwrapExpression(node.argument);
            // Already flagged by the CallExpression visitor above; do not
            // double-report the same discard.
            if (isThenOrCatchCall(argument)) {
              return;
            }

            const root = getChainRoot(argument);
            if (!isGenuineApiRoot(root)) {
              return;
            }

            context.report({
              node,
              messageId: "requireEdenErrorCheckDiscarded",
              data: { form: "void api..." },
            });
          },

          "Program:exit"() {
            for (const pendingNode of pendingEdenBindings.values()) {
              reportAssignedResult(pendingNode);
            }
            for (const result of assignedResults) {
              const outcome = analyzeContinuation(
                result.node,
                result.binding,
                result.canBeAbsent,
              );
              if (outcome.unsafe || hasUnhandled(outcome.states)) {
                reportAssignedResult(outcome.unsafeExit ?? result.node);
              }
            }
          },
        };
      },
    },
  },
});
