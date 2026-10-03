import { eslintCompatPlugin, type Variable } from "@oxlint/plugins";

import baseline from "./query-data-requires-state-baseline.json" with { type: "json" };
import {
  type AstNode,
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  repoRelativeFilename,
  resolveImportedExpression,
  resolveVariable,
  staticStringValue,
  type ScopeContext,
  unwrapExpression,
} from "./utils.ts";

const QUERY_HOOKS = new Set(["useQuery", "useInfiniteQuery", "useQueries"]);
const QUERY_STATE = new Set([
  "isError",
  "error",
  "status",
  "isSuccess",
  "isLoadingError",
  "isRefetchError",
]);
const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const ARRAY_CALLBACKS = new Set([
  "map",
  "flatMap",
  "filter",
  "find",
  "findIndex",
  "some",
  "every",
  "forEach",
]);

const queryProperty = (node: AstNode): string | null => {
  const property = node.type === "Property" ? node.key : node.property;
  return node.computed
    ? staticStringValue(property)
    : getPropertyName(property);
};

const enclosingFunction = (node: AstNode): AstNode | null => {
  let current = node.parent;
  while (isAstNode(current)) {
    if (FUNCTIONS.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
};

const functionName = (node: AstNode | null): string => {
  if (!node) {
    return "<module>";
  }
  if (isIdentifier(node.id)) {
    return node.id.name;
  }
  const parent = node.parent;
  if (
    isAstNode(parent) &&
    parent.type === "VariableDeclarator" &&
    isIdentifier(parent.id)
  ) {
    return parent.id.name;
  }
  if (isAstNode(parent) && parent.type === "Property") {
    return getPropertyName(parent.key) ?? "<callback>";
  }
  return `${functionName(enclosingFunction(node))}/<callback>`;
};

const children = (node: AstNode): AstNode[] => {
  const result: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (isAstNode(value)) {
      result.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) {
          result.push(item);
        }
      }
    }
  }
  return result;
};

type QueryBinding = {
  node: AstNode;
  owner: AstNode | null;
  name: string;
  result: Set<Variable>;
  arrays: Set<Variable>;
  data: Set<Variable>;
  state: Set<Variable>;
  stateRest: Set<Variable>;
  dataNodes: Set<AstNode>;
  stateNodes: Set<AstNode>;
  whole: boolean;
};

type BindPatternOptions = {
  context: ScopeContext;
  binding: QueryBinding;
  pattern: unknown;
  kind: "result" | "arrays" | "data" | "state" | "stateRest";
};

const bindPattern = ({
  context,
  binding,
  pattern,
  kind,
}: BindPatternOptions) => {
  if (!isAstNode(pattern)) {
    return;
  }
  if (isIdentifierReference(pattern)) {
    const variable = resolveVariable(context, pattern);
    if (variable) {
      binding[kind].add(variable);
    }
    if (
      binding.name === "<query>" &&
      (kind === "result" || kind === "arrays" || kind === "data")
    ) {
      binding.name = pattern.name;
    }
    return;
  }
  if (pattern.type === "AssignmentPattern") {
    bindPattern({ context, binding, pattern: pattern.left, kind });
    return;
  }
  if (pattern.type === "ArrayPattern" && Array.isArray(pattern.elements)) {
    for (const element of pattern.elements) {
      bindPattern({
        context,
        binding,
        pattern: element,
        kind: kind === "arrays" ? "result" : kind,
      });
    }
    return;
  }
  if (pattern.type !== "ObjectPattern" || !Array.isArray(pattern.properties)) {
    return;
  }
  for (const property of pattern.properties) {
    if (!isAstNode(property)) {
      continue;
    }
    if (property.type === "RestElement") {
      const excludesData = pattern.properties.some(
        (entry) => isAstNode(entry) && queryProperty(entry) === "data",
      );
      bindPattern({
        context,
        binding,
        pattern: property.argument,
        kind:
          kind === "result" ? (excludesData ? "stateRest" : "result") : kind,
      });
      continue;
    }
    if (kind === "data" || kind === "state") {
      bindPattern({ context, binding, pattern: property.value, kind });
      continue;
    }
    const name = queryProperty(property);
    if (name === "data") {
      bindPattern({ context, binding, pattern: property.value, kind: "data" });
    } else if (name && QUERY_STATE.has(name)) {
      bindPattern({ context, binding, pattern: property.value, kind: "state" });
    }
  }
};

const hasRead = (variables: Set<Variable>): boolean =>
  [...variables].some((variable) =>
    variable.references.some((reference) => reference.isRead()),
  );

// Follow local data derivations so returning a memo, count, or boolean cannot
// erase the query's error contract merely by introducing another binding.
type DependsOnOptions = {
  context: ScopeContext;
  node: unknown;
  variables: Set<Variable>;
  nodes: Set<AstNode>;
  seen?: Set<Variable>;
};

const dependsOn = ({
  context,
  node,
  variables,
  nodes,
  seen = new Set<Variable>(),
}: DependsOnOptions): boolean => {
  const expression = unwrapExpression(node);
  if (!expression) {
    return false;
  }
  if (nodes.has(expression)) {
    return true;
  }
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    if (!variable || seen.has(variable)) {
      return false;
    }
    if (variables.has(variable)) {
      return true;
    }
    seen.add(variable);
    for (const definition of variable.defs) {
      if (
        isAstNode(definition.node) &&
        definition.node.type === "VariableDeclarator" &&
        dependsOn({
          context,
          node: definition.node.init,
          variables,
          nodes,
          seen,
        })
      ) {
        return true;
      }
    }
    return false;
  }
  return children(expression).some((child) => {
    if (FUNCTIONS.has(expression.type) && child !== expression.body) {
      return false;
    }
    if (
      expression.type === "MemberExpression" &&
      child === expression.property &&
      !expression.computed
    ) {
      return false;
    }
    if (
      expression.type === "Property" &&
      child === expression.key &&
      !expression.computed
    ) {
      return false;
    }
    return dependsOn({
      context,
      node: child,
      variables,
      nodes,
      seen: new Set(seen),
    });
  });
};

type PreservesWholeOptions = {
  context: ScopeContext;
  node: unknown;
  variables: Set<Variable>;
};

const preservesWhole = ({
  context,
  node,
  variables,
}: PreservesWholeOptions): boolean => {
  const expression = unwrapExpression(node);
  if (!expression || expression.type === "MemberExpression") {
    return false;
  }
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    return variable !== null && variables.has(variable);
  }
  return children(expression).some((child) => {
    if (FUNCTIONS.has(expression.type) && child !== expression.body) {
      return false;
    }
    if (
      expression.type === "Property" &&
      child === expression.key &&
      !expression.computed
    ) {
      return false;
    }
    return preservesWhole({ context, node: child, variables });
  });
};

type PreservesStateOptions = {
  context: ScopeContext;
  node: unknown;
  binding: QueryBinding;
};

const preservesState = ({
  context,
  node,
  binding,
}: PreservesStateOptions): boolean => {
  const expression = unwrapExpression(node);
  if (!expression) {
    return false;
  }
  if (
    expression.type === "ObjectExpression" ||
    expression.type === "ArrayExpression"
  ) {
    return dependsOn({
      context,
      node: expression,
      variables: new Set([...binding.state, ...binding.stateRest]),
      nodes: binding.stateNodes,
    });
  }
  if (expression.type === "CallExpression") {
    const imported = resolveImportedExpression(context, expression.callee);
    if (
      imported?.source === "react" &&
      imported.imported === "useMemo" &&
      Array.isArray(expression.arguments)
    ) {
      const callback = unwrapExpression(expression.arguments.at(0));
      if (!callback || !FUNCTIONS.has(callback.type)) {
        return false;
      }
      const body = unwrapExpression(callback.body);
      if (body?.type !== "BlockStatement") {
        return (
          preservesState({ context, node: body, binding }) ||
          preservesWhole({ context, node: body, variables: binding.result })
        );
      }
      const values: unknown[] = [];
      const visit = (current: AstNode) => {
        if (current.type === "ReturnStatement") {
          values.push(current.argument);
        }
        if (FUNCTIONS.has(current.type)) {
          return;
        }
        for (const child of children(current)) {
          visit(child);
        }
      };
      visit(body);
      return (
        values.length > 0 &&
        values.every(
          (value) =>
            preservesState({ context, node: value, binding }) ||
            preservesWhole({ context, node: value, variables: binding.result }),
        )
      );
    }
    return preservesWhole({
      context,
      node: expression,
      variables: binding.result,
    });
  }
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    const definition = variable?.defs.at(0);
    if (
      isAstNode(definition?.node) &&
      definition.node.type === "VariableDeclarator"
    ) {
      return preservesState({ context, node: definition.node.init, binding });
    }
  }
  return false;
};

const returnedDiscriminators = (node: unknown): string[] => {
  const expression = unwrapExpression(node);
  if (!expression) {
    return [];
  }
  if (expression.type === "ConditionalExpression") {
    return [
      ...returnedDiscriminators(expression.consequent),
      ...returnedDiscriminators(expression.alternate),
    ];
  }
  if (
    expression.type !== "ObjectExpression" ||
    !Array.isArray(expression.properties)
  ) {
    return [];
  }
  return expression.properties.flatMap((property) => {
    if (
      !isAstNode(property) ||
      !["type", "status", "state"].includes(queryProperty(property) ?? "")
    ) {
      return [];
    }
    const value = staticStringValue(property.value);
    return value === null ? [] : [value];
  });
};

type QuerySyntax = {
  imports: Map<Variable, string>;
  namespaces: Set<Variable>;
  calls: AstNode[];
  returns: AstNode[];
  memberNodes: AstNode[];
  declarations: AstNode[];
  iterations: AstNode[];
  throws: AstNode[];
};

type HookNameOptions = {
  context: ScopeContext;
  callee: unknown;
  syntax: QuerySyntax;
};

const hookName = ({
  context,
  callee,
  syntax,
}: HookNameOptions): string | undefined => {
  const expression = unwrapExpression(callee);
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    return variable ? syntax.imports.get(variable) : undefined;
  }
  if (
    expression?.type !== "MemberExpression" ||
    !isIdentifierReference(expression.object)
  ) {
    return undefined;
  }
  const variable = resolveVariable(context, expression.object);
  const name = queryProperty(expression);
  return variable &&
    syntax.namespaces.has(variable) &&
    name &&
    QUERY_HOOKS.has(name)
    ? name
    : undefined;
};

// Typed ESTree visitor nodes lack AstNode's index signature; narrow them once
// on entry so the collectors keep the untyped shape the analysis walks.
const collect = (nodes: AstNode[], node: unknown) => {
  if (isAstNode(node)) {
    nodes.push(node);
  }
};

type TrackImportsOptions = {
  context: ScopeContext;
  node: AstNode;
  syntax: QuerySyntax;
};

const trackImports = ({ context, node, syntax }: TrackImportsOptions) => {
  if (!isAstNode(node.source) || !Array.isArray(node.specifiers)) {
    return;
  }
  const source = node.source.value;
  const queryModule = source === "@tanstack/react-query";
  const chromeModule =
    typeof source === "string" &&
    /(?:^|\/)use-chrome-query(?:\.[jt]sx?)?$/.test(source);
  if (!queryModule && !chromeModule) {
    return;
  }
  for (const specifier of node.specifiers) {
    if (!isAstNode(specifier) || !isIdentifierReference(specifier.local)) {
      continue;
    }
    const variable = resolveVariable(context, specifier.local);
    if (!variable) {
      continue;
    }
    if (queryModule && specifier.type === "ImportNamespaceSpecifier") {
      syntax.namespaces.add(variable);
    }
    const name = getImportedName(specifier);
    if (
      name &&
      ((queryModule && QUERY_HOOKS.has(name)) ||
        (chromeModule && name === "useChromeQuery"))
    ) {
      syntax.imports.set(variable, name);
    }
  }
};

type InitializeBindingOptions = {
  context: ScopeContext;
  call: AstNode;
  hook: string;
};

const initializeBinding = ({
  context,
  call,
  hook,
}: InitializeBindingOptions): QueryBinding | null => {
  const binding: QueryBinding = {
    node: call,
    owner: enclosingFunction(call),
    name: "<query>",
    result: new Set(),
    arrays: new Set(),
    data: new Set(),
    state: new Set(),
    stateRest: new Set(),
    dataNodes: new Set(),
    stateNodes: new Set(),
    whole: false,
  };
  let container = call.parent;
  while (isAstNode(container) && unwrapExpression(container) === call) {
    container = container.parent;
  }
  if (isAstNode(container) && container.type === "VariableDeclarator") {
    binding.node = container;
    bindPattern({
      context,
      binding,
      pattern: container.id,
      kind: hook === "useQueries" ? "arrays" : "result",
    });
    return binding;
  }
  if (isAstNode(container) && container.type === "MemberExpression") {
    if (queryProperty(container) === "data") {
      binding.dataNodes.add(container);
    }
    return binding;
  }
  // Returning or passing a complete result preserves its contract.
  return null;
};

const queryCombineCallback = (
  context: ScopeContext,
  call: AstNode,
): AstNode | null => {
  if (!Array.isArray(call.arguments)) {
    return null;
  }
  const options = unwrapExpression(call.arguments.at(0));
  if (
    options?.type !== "ObjectExpression" ||
    !Array.isArray(options.properties)
  ) {
    return null;
  }
  const combine = options.properties.find(
    (property) => isAstNode(property) && queryProperty(property) === "combine",
  );
  let callback = isAstNode(combine) ? unwrapExpression(combine.value) : null;
  if (isIdentifierReference(callback)) {
    const variable = resolveVariable(context, callback);
    const definition = variable?.defs.at(0);
    callback = isAstNode(definition?.node)
      ? unwrapExpression(definition.node.init)
      : null;
  }
  if (
    callback?.type === "CallExpression" &&
    Array.isArray(callback.arguments)
  ) {
    callback = unwrapExpression(callback.arguments.at(0));
  }
  return callback && FUNCTIONS.has(callback.type) ? callback : null;
};

type TrackCombineOptions = InitializeBindingOptions & { binding: QueryBinding };

const trackCombine = ({
  context,
  call,
  hook,
  binding,
}: TrackCombineOptions): boolean => {
  if (hook !== "useQueries") {
    return false;
  }
  const callback = queryCombineCallback(context, call);
  if (!callback || !Array.isArray(callback.params)) {
    return false;
  }
  bindPattern({
    context,
    binding,
    pattern: callback.params.at(0),
    kind: "arrays",
  });
  return true;
};

type TrackedNodeOptions = {
  context: ScopeContext;
  binding: QueryBinding;
  node: unknown;
};

const isTrackedArray = ({
  context,
  binding,
  node,
}: TrackedNodeOptions): boolean => {
  const expression = unwrapExpression(node);
  if (!isIdentifierReference(expression)) {
    return false;
  }
  const variable = resolveVariable(context, expression);
  return variable !== null && binding.arrays.has(variable);
};

const isTrackedResult = ({
  context,
  binding,
  node,
}: TrackedNodeOptions): boolean => {
  const expression = unwrapExpression(node);
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    return variable !== null && binding.result.has(variable);
  }
  if (expression?.type === "MemberExpression" && expression.computed) {
    return isTrackedArray({ context, binding, node: expression.object });
  }
  if (expression?.type === "CallExpression") {
    const callee = unwrapExpression(expression.callee);
    return (
      callee?.type === "MemberExpression" &&
      queryProperty(callee) === "at" &&
      isTrackedArray({ context, binding, node: callee.object })
    );
  }
  return false;
};

type QueryAnalysisOptions = {
  context: ScopeContext;
  binding: QueryBinding;
  syntax: QuerySyntax;
};

const trackDeclarationAliases = ({
  context,
  binding,
  syntax,
}: QueryAnalysisOptions) => {
  for (const declaration of syntax.declarations) {
    if (isTrackedResult({ context, binding, node: declaration.init })) {
      bindPattern({
        context,
        binding,
        pattern: declaration.id,
        kind: "result",
      });
    }
    if (isTrackedArray({ context, binding, node: declaration.init })) {
      bindPattern({
        context,
        binding,
        pattern: declaration.id,
        kind: "arrays",
      });
    }
  }
};

const trackIterationBindings = ({
  context,
  binding,
  syntax,
}: QueryAnalysisOptions) => {
  for (const iteration of syntax.iterations) {
    if (!isTrackedArray({ context, binding, node: iteration.right })) {
      continue;
    }
    const left = iteration.left;
    if (
      !isAstNode(left) ||
      left.type !== "VariableDeclaration" ||
      !Array.isArray(left.declarations)
    ) {
      bindPattern({ context, binding, pattern: left, kind: "result" });
      continue;
    }
    for (const declaration of left.declarations) {
      if (isAstNode(declaration)) {
        bindPattern({
          context,
          binding,
          pattern: declaration.id,
          kind: "result",
        });
      }
    }
  }
};

const trackCollectionCallbacks = ({
  context,
  binding,
  syntax,
}: QueryAnalysisOptions) => {
  for (const candidate of syntax.calls) {
    const callee = unwrapExpression(candidate.callee);
    if (
      callee?.type !== "MemberExpression" ||
      !isTrackedArray({ context, binding, node: callee.object }) ||
      !ARRAY_CALLBACKS.has(queryProperty(callee) ?? "")
    ) {
      continue;
    }
    const callback = Array.isArray(candidate.arguments)
      ? candidate.arguments.at(0)
      : undefined;
    if (
      isAstNode(callback) &&
      FUNCTIONS.has(callback.type) &&
      Array.isArray(callback.params)
    ) {
      bindPattern({
        context,
        binding,
        pattern: callback.params.at(0),
        kind: "result",
      });
    }
  }
};

const bindingSize = (binding: QueryBinding): number =>
  binding.result.size +
  binding.arrays.size +
  binding.data.size +
  binding.state.size;

const trackAliases = (options: QueryAnalysisOptions) => {
  // Aliases, array elements and callback parameters retain the same query
  // identity. Iterate to a fixed point across their bindings.
  let previousSize = -1;
  while (previousSize !== bindingSize(options.binding)) {
    previousSize = bindingSize(options.binding);
    trackDeclarationAliases(options);
    trackIterationBindings(options);
    trackCollectionCallbacks(options);
  }
};

const collectMemberReads = ({
  context,
  binding,
  syntax,
}: QueryAnalysisOptions) => {
  for (const member of syntax.memberNodes) {
    const object = unwrapExpression(member.object);
    const restVariable = isIdentifierReference(object)
      ? resolveVariable(context, object)
      : null;
    const trackedResult = isTrackedResult({
      context,
      binding,
      node: member.object,
    });
    if (
      !trackedResult &&
      !(restVariable && binding.stateRest.has(restVariable))
    ) {
      continue;
    }
    const container = member.parent;
    if (
      isAstNode(container) &&
      container.type === "AssignmentExpression" &&
      container.left === member &&
      container.operator === "="
    ) {
      continue;
    }
    const name = queryProperty(member);
    if (name === "data" && trackedResult) {
      binding.dataNodes.add(member);
    }
    if (name && QUERY_STATE.has(name)) {
      binding.stateNodes.add(member);
    }
  }
};

const collectWholeEscapes = (binding: QueryBinding) => {
  for (const variable of [...binding.result, ...binding.arrays]) {
    for (const reference of variable.references) {
      if (!reference.isRead()) {
        continue;
      }
      // Walk the untyped parent chain: transparent wrappers (TS casts,
      // parentheses) between the reference and its consumer are not part of
      // the ESTree parent union.
      const identifier: unknown = reference.identifier;
      let container: unknown = reference.identifier.parent;
      while (
        isAstNode(container) &&
        unwrapExpression(container) === identifier
      ) {
        container = container.parent;
      }
      if (
        isAstNode(container) &&
        [
          "CallExpression",
          "ReturnStatement",
          "Property",
          "SpreadElement",
          "ArrayExpression",
          "JSXExpressionContainer",
        ].includes(container.type)
      ) {
        binding.whole = true;
      }
    }
  }
};

const queryReturnValues = (
  binding: QueryBinding,
  returns: AstNode[],
): unknown[] =>
  returns
    .filter(
      (returned) =>
        (returned.type === "ArrowFunctionExpression"
          ? returned
          : enclosingFunction(returned)) === binding.owner,
    )
    .map((returned) =>
      returned.type === "ArrowFunctionExpression"
        ? returned.body
        : returned.argument,
    );

type HookStripOptions = QueryAnalysisOptions & {
  returnValues: unknown[];
  readsState: boolean;
};

const hookStripsState = ({
  context,
  binding,
  syntax,
  returnValues,
  readsState,
}: HookStripOptions): boolean => {
  if (!/^use[A-Z]/.test(functionName(binding.owner))) {
    return false;
  }
  const throwsState = syntax.throws.some(
    (thrown) =>
      enclosingFunction(thrown) === binding.owner &&
      dependsOn({
        context,
        node: thrown.argument,
        variables: binding.state,
        nodes: binding.stateNodes,
      }),
  );
  if (throwsState) {
    return false;
  }
  const returnsErrorTag =
    readsState &&
    returnValues.some((value) =>
      returnedDiscriminators(value).some((tag) =>
        /error|fail|unavailable/u.test(tag),
      ),
    );
  return returnValues.some(
    (value) =>
      dependsOn({
        context,
        node: value,
        variables: binding.data,
        nodes: binding.dataNodes,
      }) &&
      !preservesState({ context, node: value, binding }) &&
      !preservesWhole({ context, node: value, variables: binding.result }) &&
      !(returnsErrorTag && returnedDiscriminators(value).length > 0),
  );
};

type QueryViolationOptions = InitializeBindingOptions & { syntax: QuerySyntax };

const queryViolation = ({
  context,
  call,
  hook,
  syntax,
}: QueryViolationOptions): QueryBinding | null => {
  const binding = initializeBinding({ context, call, hook });
  if (!binding) {
    return null;
  }
  const combines = trackCombine({ context, call, hook, binding });
  trackAliases({ context, binding, syntax });
  collectMemberReads({ context, binding, syntax });
  collectWholeEscapes(binding);
  const readsData = binding.dataNodes.size > 0 || hasRead(binding.data);
  if (!readsData) {
    return null;
  }
  const readsState = binding.stateNodes.size > 0 || hasRead(binding.state);
  const returnValues = queryReturnValues(binding, syntax.returns);
  const stripsState = hookStripsState({
    context,
    binding,
    syntax,
    returnValues,
    readsState,
  });
  if (
    !stripsState &&
    (readsState ||
      (!combines && binding.whole) ||
      returnValues.some((value) =>
        preservesState({ context, node: value, binding }),
      ))
  ) {
    return null;
  }
  return binding;
};

type QueryReportContext = ScopeContext & {
  filename?: string;
  getFilename?: () => string;
  options: readonly unknown[];
  report: (diagnostic: {
    node: AstNode;
    messageId: string;
    data: { key: string };
  }) => void;
};

const reportQueryViolations = (
  context: QueryReportContext,
  syntax: QuerySyntax,
) => {
  const options = context.options.at(0);
  const census =
    typeof options === "object" &&
    options !== null &&
    Reflect.get(options, "census") === true;
  for (const call of syntax.calls) {
    const hook = hookName({ context, callee: call.callee, syntax });
    if (!hook) {
      continue;
    }
    const binding = queryViolation({ context, call, hook, syntax });
    if (!binding) {
      continue;
    }
    const key = `${repoRelativeFilename(context)}::${functionName(binding.owner)}::${binding.name}`;
    if (!census && Object.hasOwn(baseline.entries, key)) {
      continue;
    }
    context.report({
      node: binding.node,
      messageId: "queryState",
      data: { key },
    });
  }
};

export default eslintCompatPlugin({
  meta: { name: "query-data-requires-state" },
  rules: {
    "query-data-requires-state": {
      meta: {
        type: "problem",
        messages: {
          queryState:
            "Query data requires its error state. Pass the result to useQueryView from @/lib/use-query-view, or handle and preserve its error/status. Query binding: {{key}}.",
        },
        schema: [
          {
            type: "object",
            properties: { census: { type: "boolean" } },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        const syntax: QuerySyntax = {
          imports: new Map(),
          namespaces: new Set(),
          calls: [],
          returns: [],
          memberNodes: [],
          declarations: [],
          iterations: [],
          throws: [],
        };
        return {
          before() {
            syntax.imports.clear();
            syntax.namespaces.clear();
            syntax.calls.length = 0;
            syntax.returns.length = 0;
            syntax.memberNodes.length = 0;
            syntax.declarations.length = 0;
            syntax.iterations.length = 0;
            syntax.throws.length = 0;
          },
          ImportDeclaration(node) {
            if (isAstNode(node)) {
              trackImports({ context, node, syntax });
            }
          },
          CallExpression(node) {
            collect(syntax.calls, node);
          },
          ReturnStatement(node) {
            collect(syntax.returns, node);
          },
          ArrowFunctionExpression(node) {
            if (node.expression) {
              collect(syntax.returns, node);
            }
          },
          MemberExpression(node) {
            collect(syntax.memberNodes, node);
          },
          VariableDeclarator(node) {
            collect(syntax.declarations, node);
          },
          ForOfStatement(node) {
            collect(syntax.iterations, node);
          },
          ThrowStatement(node) {
            collect(syntax.throws, node);
          },
          "Program:exit"() {
            reportQueryViolations(context, syntax);
          },
        };
      },
    },
  },
});
