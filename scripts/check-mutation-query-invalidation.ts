import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

import { BASELINE_PATHS } from "./baseline-paths";
import {
  generateMutationQueryCensus,
  type MutationQueryCensus,
} from "./mutation-query-census.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE = BASELINE_PATHS.mutationQueryInvalidation;
const REALTIME_MODULE = "apps/web/src/lib/workspace-realtime.ts";
const CONTRACT_MODULE = REALTIME_MODULE;
const API_CONTRACT_MODULE = "packages/api-contract/src/resource-ref.ts";
const HELPER_MODULE = "@/lib/workspace-realtime";
const API_CONTRACT_IMPORT = "@stll/api-contract";
const MUTATION_HELPER = "resourceMutation";
const READER_HELPER = "resourceQueryOptions";
const MUTATION_PRIMITIVES = new Set(["useMutation", "mutationOptions"]);
const READER_PRIMITIVES = new Set(["queryOptions", "infiniteQueryOptions"]);
const ROUTE_READER_HELPERS = new Set([
  "ensureRouteQueryData",
  "ensureRouteInfiniteQueryData",
]);
const READER_EXECUTORS = new Set([
  ...READER_PRIMITIVES,
  ...ROUTE_READER_HELPERS,
  "useQuery",
  "useSuspenseQuery",
  "useInfiniteQuery",
  "useSuspenseInfiniteQuery",
  "fetchQuery",
  "prefetchQuery",
  "ensureQueryData",
  "fetchInfiniteQuery",
  "prefetchInfiniteQuery",
  "query",
  "infiniteQuery",
  "ensureInfiniteQueryData",
]);
const READER_SPREAD_OVERRIDES = new Set([
  "enabled",
  "select",
  "staleTime",
  "gcTime",
  "placeholderData",
  "refetchInterval",
  "refetchIntervalInBackground",
  "refetchOnMount",
  "refetchOnReconnect",
  "refetchOnWindowFocus",
  "retry",
  "retryDelay",
  "retryOnMount",
  "throwOnError",
  "notifyOnChangeProps",
  "subscribed",
]);
const MUTATION_SPREAD_OVERRIDES = new Set([
  "onMutate",
  "onSuccess",
  "onError",
  "onSettled",
  "retry",
  "retryDelay",
  "throwOnError",
  "scope",
]);

const baselineSchema = v.object({
  entries: v.record(v.string(), v.pipe(v.string(), v.regex(/\S/u))),
});

type Source = { file: string; text: string };
type Finding = {
  id: string;
  file: string;
  reason: string;
  disposition: "legacy" | "invalid-declaration";
};
type ImportMap = Map<string, { module: string; imported: string }>;
type Binding = {
  name: string;
  scope: ts.Node;
  value?: ts.Expression;
  mutable: boolean;
  functionLike?: ts.FunctionLikeDeclaration;
};
type FactoryFunctionArgs = {
  module: ModuleIndex;
  expression: ts.Expression;
  reference: ts.Node;
  modules: ReadonlyMap<string, ModuleIndex>;
  seen: Set<string>;
};
type TaggedReaderArgs = {
  module: ModuleIndex;
  expression: ts.Expression;
  reference: ts.Node;
  names: ReadonlySet<string>;
  modules: ReadonlyMap<string, ModuleIndex>;
  seen: Set<string>;
};
type ModuleIndex = {
  file: string;
  source: ts.SourceFile;
  imports: ImportMap;
  bindings: Binding[];
};

const lexicalScope = (node: ts.Node): ts.Node => {
  for (
    let current = node.parent;
    !ts.isSourceFile(current);
    current = current.parent
  ) {
    if (
      ts.isSourceFile(current) ||
      ts.isBlock(current) ||
      ts.isFunctionLike(current)
    ) {
      return current;
    }
  }
  return node.getSourceFile();
};

const indexSource = ({ file, text }: Source): ModuleIndex => {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports: ImportMap = new Map();
  const bindings: Binding[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      const module = node.moduleSpecifier.text;
      if (clause?.name) {
        imports.set(clause.name.text, { module, imported: "default" });
      }
      const namedBindings = clause?.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const item of namedBindings.elements) {
          imports.set(item.name.text, {
            module,
            imported: (item.propertyName ?? item.name).text,
          });
        }
      }
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        imports.set(namedBindings.name.text, { module, imported: "*" });
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const declarationList = node.parent;
      const mutable =
        !ts.isVariableDeclarationList(declarationList) ||
        declarationList.getFirstToken()?.kind !== ts.SyntaxKind.ConstKeyword;
      const binding: Binding = {
        name: node.name.text,
        scope: lexicalScope(node),
        mutable,
      };
      if (node.initializer) {
        binding.value = node.initializer;
        if (
          ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer)
        ) {
          binding.functionLike = node.initializer;
        }
      }
      bindings.push(binding);
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      bindings.push({
        name: node.name.text,
        scope: node.parent,
        mutable: true,
      });
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      bindings.push({
        name: node.name.text,
        scope: lexicalScope(node),
        mutable: true,
        functionLike: node,
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      bindings.push({
        name: node.name.text,
        scope: lexicalScope(node),
        mutable: true,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { file, source, imports, bindings };
};

const unwrap = (node: ts.Expression): ts.Expression => {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return unwrap(node.expression);
  }
  return node;
};

const propertyName = (name: ts.PropertyName | ts.BindingName | undefined) => {
  if (!name) {
    return undefined;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
};

const objectProperty = (
  object: ts.Expression,
  key: string,
): ts.Expression | undefined => {
  const value = unwrap(object);
  if (!ts.isObjectLiteralExpression(value)) {
    return undefined;
  }
  const found = value.properties.find((item) =>
    ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)
      ? propertyName(item.name) === key
      : false,
  );
  if (found && ts.isPropertyAssignment(found)) {
    return found.initializer;
  }
  if (found && ts.isShorthandPropertyAssignment(found)) {
    return found.name;
  }
  return undefined;
};

const hasExactProperty = (object: ts.Expression, key: string): boolean => {
  const value = unwrap(object);
  if (!ts.isObjectLiteralExpression(value)) {
    return false;
  }
  return (
    !value.properties.some(ts.isSpreadAssignment) &&
    value.properties.filter(
      (item) => item.name && propertyName(item.name) === key,
    ).length === 1
  );
};

const hasExactProperties = (
  object: ts.Expression,
  keys: readonly string[],
): boolean => {
  const value = unwrap(object);
  if (
    !ts.isObjectLiteralExpression(value) ||
    value.properties.some(ts.isSpreadAssignment)
  ) {
    return false;
  }
  const actual = value.properties.map((property) =>
    ts.isPropertyAssignment(property) ||
    ts.isShorthandPropertyAssignment(property)
      ? propertyName(property.name)
      : undefined,
  );
  const actualKeys = actual.filter((key): key is string => key !== undefined);
  return (
    actualKeys.length === actual.length &&
    JSON.stringify(actualKeys.toSorted(compareCodeUnit)) ===
      JSON.stringify(keys.toSorted(compareCodeUnit))
  );
};

const callName = (call: ts.CallExpression) => {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  return undefined;
};

const localBinding = (
  module: ModuleIndex,
  name: string,
  reference: ts.Node,
): Binding | undefined => {
  const scopes: ts.Node[] = [];
  for (let scope: ts.Node = reference; ; scope = scope.parent) {
    scopes.push(scope);
    if (ts.isSourceFile(scope)) {
      break;
    }
  }
  return module.bindings
    .filter(
      (binding) => binding.name === name && scopes.includes(binding.scope),
    )
    .toSorted(
      (left, right) => scopes.indexOf(left.scope) - scopes.indexOf(right.scope),
    )
    .at(0);
};

const resolveLocal = (
  module: ModuleIndex,
  expression: ts.Expression,
  reference: ts.Node = expression,
  seen = new Set<string>(),
): ts.Expression | undefined => {
  const current = unwrap(expression);
  if (!ts.isIdentifier(current)) {
    return current;
  }
  if (seen.has(current.text)) {
    return undefined;
  }
  const binding = localBinding(module, current.text, reference);
  if (!binding) {
    return current;
  }
  if (!binding.value || binding.mutable) {
    return undefined;
  }
  seen.add(current.text);
  return resolveLocal(module, binding.value, binding.scope, seen);
};

const importedFrom = (
  module: ModuleIndex,
  expression: ts.Expression,
  exportName: string,
  expectedModule: string,
): boolean => {
  const resolved = resolveLocal(module, expression);
  if (!resolved || !ts.isIdentifier(resolved)) {
    return false;
  }
  const imported = module.imports.get(resolved.text);
  return (
    imported?.imported === exportName && imported.module === expectedModule
  );
};

const canonicalCall = (
  module: ModuleIndex,
  call: ts.CallExpression,
  exportName: string,
): boolean => importedFrom(module, call.expression, exportName, HELPER_MODULE);

const resourceTypeNames = (text: string): Set<string> => {
  const source = ts.createSourceFile(
    API_CONTRACT_MODULE,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = source.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (item) =>
          ts.isIdentifier(item.name) && item.name.text === "RESOURCE_TYPE",
      ),
  );
  if (!declaration || !ts.isVariableStatement(declaration)) {
    return panic("RESOURCE_TYPE declaration is missing");
  }
  const binding = declaration.declarationList.declarations.find(
    (item) => ts.isIdentifier(item.name) && item.name.text === "RESOURCE_TYPE",
  );
  if (
    !binding?.initializer ||
    !ts.isObjectLiteralExpression(unwrap(binding.initializer))
  ) {
    return panic("RESOURCE_TYPE is not a static object literal");
  }
  const resourceObject = unwrap(binding.initializer);
  if (!ts.isObjectLiteralExpression(resourceObject)) {
    return panic("RESOURCE_TYPE is not a static object literal");
  }
  return new Set(
    resourceObject.properties.flatMap((property) =>
      ts.isPropertyAssignment(property)
        ? [propertyName(property.name)].filter(
            (name): name is string => name !== undefined,
          )
        : [],
    ),
  );
};

const isValidResourceList = (
  module: ModuleIndex,
  options: ts.Expression | undefined,
  names: ReadonlySet<string>,
): boolean => {
  if (
    !options ||
    !ts.isObjectLiteralExpression(unwrap(options)) ||
    !hasExactProperty(options, "resources")
  ) {
    return false;
  }
  const resources = objectProperty(options, "resources");
  if (!resources) {
    return false;
  }
  const resourceArray = unwrap(resources);
  if (!ts.isArrayLiteralExpression(resourceArray)) {
    return false;
  }
  const elements = resourceArray.elements;
  if (elements.length === 0 || elements.some(ts.isSpreadElement)) {
    return false;
  }
  return elements.every((element) => {
    const value = unwrap(element);
    if (
      !ts.isPropertyAccessExpression(value) ||
      !ts.isIdentifier(value.expression)
    ) {
      return false;
    }
    return (
      names.has(value.name.text) &&
      importedFrom(
        module,
        value.expression,
        "RESOURCE_TYPE",
        API_CONTRACT_IMPORT,
      )
    );
  });
};

const isScopeObject = (object: ts.ObjectLiteralExpression): boolean => {
  if (!hasExactProperty(object, "type")) {
    return false;
  }
  const type = objectProperty(object, "type");
  if (!type) {
    return false;
  }
  const value = unwrap(type);
  if (!ts.isStringLiteral(value)) {
    return false;
  }
  if (value.text === "organization") {
    return true;
  }
  return (
    value.text === "workspace" &&
    hasExactProperty(object, "workspaceId") &&
    objectProperty(object, "workspaceId") !== undefined
  );
};

const isValidScopeObject = (scope: ts.Expression | undefined): boolean => {
  if (!scope) {
    return false;
  }
  const value = unwrap(scope);
  if (ts.isConditionalExpression(value)) {
    return (
      isValidScopeObject(value.whenTrue) && isValidScopeObject(value.whenFalse)
    );
  }
  return ts.isObjectLiteralExpression(value) && isScopeObject(value);
};

const isValidHelperConfig = (
  module: ModuleIndex,
  config: ts.Expression | undefined,
  names: ReadonlySet<string>,
): boolean => {
  if (!config) {
    return false;
  }
  const type = objectProperty(config, "type");
  if (type) {
    const value = unwrap(type);
    return (
      hasExactProperties(config, ["type"]) &&
      ts.isStringLiteral(value) &&
      value.text === "independent"
    );
  }
  return (
    hasExactProperties(config, ["resources", "scope"]) &&
    isValidResourceList(module, config, names) &&
    isValidScopeObject(objectProperty(config, "scope"))
  );
};

type MutationContract = { resources: string[]; writes: string[] };

const parseMutationContract = (
  module: ModuleIndex,
  property: ts.ObjectLiteralElementLike,
  names: ReadonlySet<string>,
): { key: string; contract: MutationContract } | undefined => {
  if (!ts.isPropertyAssignment(property)) {
    return undefined;
  }
  const key = propertyName(property.name);
  const value = unwrap(property.initializer);
  if (!key || !ts.isObjectLiteralExpression(value)) {
    return undefined;
  }
  const resourceExpression = objectProperty(value, "resources");
  const writesExpression = objectProperty(value, "writes");
  if (!resourceExpression || !writesExpression) {
    return undefined;
  }
  const resourceValue = unwrap(resourceExpression);
  const writesValue = unwrap(writesExpression);
  if (
    !ts.isArrayLiteralExpression(resourceValue) ||
    !ts.isArrayLiteralExpression(writesValue)
  ) {
    return undefined;
  }
  const resources: string[] = [];
  for (const resource of resourceValue.elements) {
    const item = unwrap(resource);
    if (
      !ts.isPropertyAccessExpression(item) ||
      !ts.isIdentifier(item.expression) ||
      !names.has(item.name.text) ||
      !importedFrom(
        module,
        item.expression,
        "RESOURCE_TYPE",
        API_CONTRACT_IMPORT,
      )
    ) {
      return undefined;
    }
    resources.push(item.name.text);
  }
  const writes: string[] = [];
  for (const write of writesValue.elements) {
    const item = unwrap(write);
    if (!ts.isObjectLiteralExpression(item)) {
      return undefined;
    }
    const method = objectProperty(item, "method");
    const route = objectProperty(item, "route");
    if (!method || !route) {
      return undefined;
    }
    const methodValue = unwrap(method);
    const routeValue = unwrap(route);
    if (!ts.isStringLiteral(methodValue) || !ts.isStringLiteral(routeValue)) {
      return undefined;
    }
    writes.push(`${methodValue.text.toUpperCase()} ${routeValue.text}`);
  }
  if (!resources.length || !writes.length) {
    return undefined;
  }
  return {
    key,
    contract: {
      resources: resources.toSorted(compareCodeUnit),
      writes: writes.toSorted(compareCodeUnit),
    },
  };
};

const mutationContracts = (
  module: ModuleIndex | undefined,
  names: ReadonlySet<string>,
): Map<string, MutationContract> => {
  if (!module) {
    return new Map();
  }
  const declaration = module.source.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (item) =>
          ts.isIdentifier(item.name) &&
          item.name.text === "RESOURCE_MUTATION_CONTRACTS",
      ),
  );
  if (!declaration || !ts.isVariableStatement(declaration)) {
    return new Map();
  }
  const binding = declaration.declarationList.declarations.find(
    (item) =>
      ts.isIdentifier(item.name) &&
      item.name.text === "RESOURCE_MUTATION_CONTRACTS",
  );
  if (
    !binding?.initializer ||
    !ts.isObjectLiteralExpression(unwrap(binding.initializer))
  ) {
    return new Map();
  }
  const result = new Map<string, MutationContract>();
  const contractsObject = unwrap(binding.initializer);
  if (!ts.isObjectLiteralExpression(contractsObject)) {
    return new Map();
  }
  for (const property of contractsObject.properties) {
    const parsed = parseMutationContract(module, property, names);
    if (!parsed || result.has(parsed.key)) {
      return new Map();
    }
    result.set(parsed.key, parsed.contract);
  }
  return result;
};

type MutationContractErrorArgs = {
  call: ts.CallExpression;
  mutationFn: ts.Expression;
  entry: MutationQueryCensus["mutations"][number];
  contracts: ReadonlyMap<string, MutationContract>;
};

const mutationContractError = ({
  call,
  mutationFn,
  entry,
  contracts,
}: MutationContractErrorArgs): string | undefined => {
  const options = call.arguments.at(0);
  if (
    !options ||
    !(
      hasExactProperties(options, ["mutation", "queryClient", "mutationFn"]) ||
      hasExactProperties(options, [
        "mutation",
        "queryClient",
        "mutationFn",
        "scope",
      ])
    )
  ) {
    return "resourceMutation options must contain mutation, queryClient, mutationFn, and optionally scope.";
  }
  const scope = objectProperty(options, "scope");
  if (scope !== undefined) {
    const scopeValue = unwrap(scope);
    const scopeType =
      ts.isObjectLiteralExpression(scopeValue) &&
      hasExactProperties(scopeValue, ["type"])
        ? objectProperty(scopeValue, "type")
        : undefined;
    const scopeTypeValue = scopeType ? unwrap(scopeType) : undefined;
    if (
      !scopeTypeValue ||
      !ts.isStringLiteral(scopeTypeValue) ||
      !["workspace", "organization"].includes(scopeTypeValue.text)
    ) {
      return "resourceMutation scope must be a closed workspace or organization scope literal.";
    }
  }
  const mutation = objectProperty(options, "mutation");
  if (!mutation) {
    return "resourceMutation mutation key must be a string literal.";
  }
  const mutationValue = unwrap(mutation);
  if (!ts.isStringLiteral(mutationValue)) {
    return "resourceMutation mutation key must be a string literal.";
  }
  const contract = contracts.get(mutationValue.text);
  if (!contract) {
    return `resourceMutation names unknown contract ${mutationValue.text}.`;
  }
  const normalizedHelperCall = call.getText().replace(/\s+/gu, " ").trim();
  const normalizedMutationFn = mutationFn
    .getText()
    .replace(/\s+/gu, " ")
    .trim();
  const unresolved = entry.unresolved.filter(
    ({ reason, file, expression }) =>
      !(
        reason === "dynamic-options-spread" &&
        file === CONTRACT_MODULE &&
        expression === "options"
      ),
  );
  const unresolvedIsOnlyHelperReturn =
    unresolved.length === 1 &&
    unresolved[0]?.reason === "dynamic-operation-function" &&
    [normalizedHelperCall, normalizedMutationFn].includes(
      unresolved[0].expression.replace(/\s+/gu, " ").trim(),
    );
  if (unresolved.length > 0 && !unresolvedIsOnlyHelperReturn) {
    return "resourceMutation write analysis has unresolved operations.";
  }
  const observedWrites = entry.writes
    .map(({ method, route }) => `${method.toUpperCase()} ${route}`)
    .toSorted(compareCodeUnit);
  if (JSON.stringify(observedWrites) !== JSON.stringify(contract.writes)) {
    return "resourceMutation route does not match its registered contract.";
  }
  if (
    objectProperty(options, "queryClient") === undefined ||
    objectProperty(options, "mutationFn") === undefined
  ) {
    return "resourceMutation requires queryClient and mutationFn.";
  }
  return undefined;
};

type MutationOptionsShape = {
  properties: readonly (readonly [string, ts.Expression])[];
};

type MutationOptionsShapeArgs = {
  module: ModuleIndex;
  expression: ts.Expression;
  reference?: ts.Node;
  seen?: Set<Binding>;
};

const optionsAliasRoot = (expression: ts.Expression) => {
  let root = unwrap(expression);
  while (
    ts.isPropertyAccessExpression(root) ||
    ts.isElementAccessExpression(root)
  ) {
    root = unwrap(root.expression);
  }
  return ts.isIdentifier(root) ? root : undefined;
};

const hasBindingPropertyMutation = (module: ModuleIndex, binding: Binding) => {
  const aliases = new Set([binding]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of module.bindings) {
      if (aliases.has(candidate) || !candidate.value) {
        continue;
      }
      const root = optionsAliasRoot(candidate.value);
      const source = root
        ? localBinding(module, root.text, candidate.scope)
        : undefined;
      if (source && aliases.has(source)) {
        aliases.add(candidate);
        changed = true;
      }
    }
  }
  const refersToAlias = (expression: ts.Expression, reference: ts.Node) => {
    const root = optionsAliasRoot(expression);
    if (!root) {
      return false;
    }
    const resolved = localBinding(module, root.text, reference);
    return resolved !== undefined && aliases.has(resolved);
  };
  let mutated = false;
  const visit = (node: ts.Node) => {
    const assignedExpression = ts.isBinaryExpression(node)
      ? node.left
      : undefined;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      assignedExpression !== undefined &&
      ((ts.isIdentifier(assignedExpression) &&
        refersToAlias(assignedExpression, assignedExpression)) ||
        ((ts.isPropertyAccessExpression(assignedExpression) ||
          ts.isElementAccessExpression(assignedExpression)) &&
          refersToAlias(assignedExpression.expression, assignedExpression)))
    ) {
      mutated = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
        node.operator,
      ) &&
      refersToAlias(node.operand, node)
    ) {
      mutated = true;
      return;
    }
    if (
      ts.isDeleteExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)) &&
      refersToAlias(node.expression.expression, node.expression)
    ) {
      mutated = true;
      return;
    }
    const firstArgument = ts.isCallExpression(node)
      ? node.arguments.at(0)
      : undefined;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText() === "Object" &&
      ["assign", "defineProperty", "setPrototypeOf"].includes(
        node.expression.name.text,
      ) &&
      firstArgument !== undefined &&
      refersToAlias(firstArgument, node)
    ) {
      mutated = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(module.source);
  return mutated;
};

type UnchangedOptionsBindingArgs = {
  module: ModuleIndex;
  identifier: ts.Identifier;
  reference: ts.Node;
};

const unchangedOptionsBinding = ({
  module,
  identifier,
  reference,
}: UnchangedOptionsBindingArgs) => {
  const binding = localBinding(module, identifier.text, reference);
  if (
    !binding?.value ||
    binding.mutable ||
    hasBindingPropertyMutation(module, binding)
  ) {
    return undefined;
  }
  return { binding, expression: binding.value, reference: binding.scope };
};

type TaggedSpreadStatus = "unresolved" | "untagged" | "tagged" | "invalid";
type TaggedSpreadValidationArgs = {
  module: ModuleIndex;
  expression: ts.Expression;
  reference: ts.Node;
  allowedOverrides: ReadonlySet<string>;
  isTaggedSpread: (expression: ts.Expression, reference: ts.Node) => boolean;
  seen?: Set<Binding>;
};

const validateTaggedSpreadOverrides = ({
  module,
  expression,
  reference,
  allowedOverrides,
  isTaggedSpread,
  seen = new Set<Binding>(),
}: TaggedSpreadValidationArgs): TaggedSpreadStatus => {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) {
    const resolved = unchangedOptionsBinding({
      module,
      identifier: value,
      reference,
    });
    if (!resolved || seen.has(resolved.binding)) {
      return "unresolved";
    }
    return validateTaggedSpreadOverrides({
      module,
      expression: resolved.expression,
      reference: resolved.reference,
      allowedOverrides,
      isTaggedSpread,
      seen: new Set(seen).add(resolved.binding),
    });
  }
  if (!ts.isObjectLiteralExpression(value)) {
    return "unresolved";
  }
  let tagged = false;
  for (const property of value.properties) {
    if (ts.isSpreadAssignment(property)) {
      if (tagged) {
        return "invalid";
      }
      const nested = validateTaggedSpreadOverrides({
        module,
        expression: property.expression,
        reference: property,
        allowedOverrides,
        isTaggedSpread,
        seen: new Set(seen),
      });
      if (nested === "invalid") {
        return "invalid";
      }
      tagged =
        nested === "tagged" || isTaggedSpread(property.expression, property);
      continue;
    }
    if (
      tagged &&
      (ts.isComputedPropertyName(property.name) ||
        !allowedOverrides.has(propertyName(property.name) ?? ""))
    ) {
      return "invalid";
    }
  }
  return tagged ? "tagged" : "untagged";
};

const mutationOptionsShape = ({
  module,
  expression,
  reference = expression,
  seen = new Set<Binding>(),
}: MutationOptionsShapeArgs): MutationOptionsShape | undefined => {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) {
    const resolved = unchangedOptionsBinding({
      module,
      identifier: value,
      reference,
    });
    if (!resolved || seen.has(resolved.binding)) {
      return undefined;
    }
    const next = new Set(seen);
    next.add(resolved.binding);
    return mutationOptionsShape({
      module,
      expression: resolved.expression,
      reference: resolved.reference,
      seen: next,
    });
  }
  if (!ts.isObjectLiteralExpression(value)) {
    return undefined;
  }
  const properties: (readonly [string, ts.Expression])[] = [];
  for (const property of value.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = mutationOptionsShape({
        module,
        expression: property.expression,
        reference: property,
        seen: new Set(seen),
      });
      if (!spread) {
        return undefined;
      }
      properties.push(...spread.properties);
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      const key = propertyName(property.name);
      if (!key) {
        return undefined;
      }
      properties.push([key, property.initializer]);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      properties.push([property.name.text, property.name]);
      continue;
    }
    return undefined;
  }
  return { properties };
};

const resolvedMutationHelper = (
  module: ModuleIndex,
  expression: ts.Expression,
): ts.CallExpression | undefined => {
  const resolved = resolveLocal(module, expression, expression);
  return resolved &&
    ts.isCallExpression(resolved) &&
    canonicalCall(module, resolved, MUTATION_HELPER)
    ? resolved
    : undefined;
};

const isTaggedMutationSpread = (
  module: ModuleIndex,
  expression: ts.Expression,
  reference: ts.Node,
) => {
  const shape = mutationOptionsShape({ module, expression, reference });
  const mutationFunctions =
    shape?.properties.filter(([key]) => key === "mutationFn") ?? [];
  const finalMutationFunction = mutationFunctions.at(-1)?.[1];
  return (
    finalMutationFunction !== undefined &&
    resolvedMutationHelper(module, finalMutationFunction) !== undefined
  );
};

type MutationExecutionResult =
  | { status: "valid" }
  | { status: "invalid"; reason: string }
  | { status: "unwrapped" };

type MutationExecutionArgs = {
  module: ModuleIndex;
  call: ts.CallExpression;
  entry: MutationQueryCensus["mutations"][number];
  contracts: ReadonlyMap<string, MutationContract>;
};

const inspectMutationExecution = ({
  module,
  call,
  entry,
  contracts,
}: MutationExecutionArgs): MutationExecutionResult => {
  const options = call.arguments.at(0);
  const spreadValidation = options
    ? validateTaggedSpreadOverrides({
        module,
        expression: options,
        reference: call,
        allowedOverrides: MUTATION_SPREAD_OVERRIDES,
        isTaggedSpread: (spread, reference) =>
          isTaggedMutationSpread(module, spread, reference),
      })
    : "unresolved";
  if (spreadValidation === "invalid") {
    return {
      status: "invalid",
      reason:
        "Mutation option spread overrides must use an explicit allowed option key.",
    };
  }
  const shape = options
    ? mutationOptionsShape({ module, expression: options, reference: call })
    : undefined;
  const orderedMutationFunctions =
    shape?.properties.filter(([key]) => key === "mutationFn") ?? [];
  const finalMutationFunction = orderedMutationFunctions.at(-1)?.[1];
  const helperCalls = new Set<ts.CallExpression>();
  for (const [, expression] of orderedMutationFunctions) {
    const helper = resolvedMutationHelper(module, expression);
    if (helper) {
      helperCalls.add(helper);
    }
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      canonicalCall(module, node, MUTATION_HELPER)
    ) {
      helperCalls.add(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(call);
  const selectedHelper = finalMutationFunction
    ? resolvedMutationHelper(module, finalMutationFunction)
    : undefined;
  if (selectedHelper) {
    helperCalls.add(selectedHelper);
  }
  if (helperCalls.size > 0 || selectedHelper !== undefined) {
    if (!selectedHelper || !finalMutationFunction || helperCalls.size !== 1) {
      return {
        status: "invalid",
        reason:
          "resourceMutation must be the effective mutationFn and cannot be discarded or overridden.",
      };
    }
    const error = mutationContractError({
      call: selectedHelper,
      mutationFn: finalMutationFunction,
      entry,
      contracts,
    });
    return error === undefined
      ? { status: "valid" }
      : { status: "invalid", reason: error };
  }

  const ownWrites = entry.kind === "wrapper" ? entry.ownWrites : entry.writes;
  const observedWrites = new Set(
    ownWrites.map(({ method, route }) => `${method.toUpperCase()} ${route}`),
  );
  if (
    [...contracts.values()].some(({ writes }) =>
      writes.some((write) => observedWrites.has(write)),
    )
  ) {
    return {
      status: "invalid",
      reason:
        "A mutation on a registered resource route must execute resourceMutation as its mutationFn.",
    };
  }
  return { status: "unwrapped" };
};

const findCall = (
  module: ModuleIndex,
  location: { line: number; column: number; callee: string },
): ts.CallExpression | undefined => {
  if (
    location.line < 1 ||
    location.line >
      module.source.getLineAndCharacterOfPosition(module.source.end).line + 1
  ) {
    return undefined;
  }
  const lineText = module.source.text.split(/\r?\n/u)[location.line - 1];
  if (
    lineText === undefined ||
    location.column < 1 ||
    location.column > lineText.length + 1
  ) {
    return undefined;
  }
  const start = module.source.getPositionOfLineAndCharacter(
    location.line - 1,
    location.column - 1,
  );
  let result: ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.getStart(module.source) === start &&
      node.expression.getText(module.source).replace(/\s+/gu, " ").trim() ===
        location.callee
    ) {
      result = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(module.source);
  return result;
};

const enclosingFunctionName = (node: ts.Node): string | undefined => {
  for (
    let current = node.parent;
    !ts.isSourceFile(current);
    current = current.parent
  ) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text;
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
    if (ts.isPropertyAssignment(current) && current.initializer === node) {
      return propertyName(current.name);
    }
  }
  return undefined;
};

const wrappedReaderCall = (
  module: ModuleIndex,
  reader: ts.CallExpression,
  names: ReadonlySet<string>,
): boolean => {
  for (
    let current = reader.parent;
    !ts.isSourceFile(current);
    current = current.parent
  ) {
    if (!ts.isCallExpression(current)) {
      continue;
    }
    const first = current.arguments.at(0);
    if (!first || !isWithin(reader, first)) {
      continue;
    }
    if (!canonicalCall(module, current, READER_HELPER)) {
      continue;
    }
    return isValidHelperConfig(module, current.arguments.at(1), names);
  }
  return false;
};

const isWithin = (node: ts.Node, ancestor: ts.Node): boolean => {
  for (
    let current: ts.Node = node;
    !ts.isSourceFile(current);
    current = current.parent
  ) {
    if (current === ancestor) {
      return true;
    }
  }
  return false;
};

const importedModule = (
  module: ModuleIndex,
  imported: string,
  modules: ReadonlyMap<string, ModuleIndex>,
): ModuleIndex | undefined => {
  let base: string | undefined;
  if (imported.startsWith("@/")) {
    base = path.posix.join("apps/web/src", imported.slice(2));
  } else if (imported.startsWith(".")) {
    base = path.posix.join(path.posix.dirname(module.file), imported);
  }
  if (!base) {
    return undefined;
  }
  const withoutJsExtension = base.replace(/\.[cm]?jsx?$/u, "");
  return [
    base,
    `${withoutJsExtension}.ts`,
    `${withoutJsExtension}.tsx`,
    `${withoutJsExtension}/index.ts`,
    `${withoutJsExtension}/index.tsx`,
  ]
    .map((file) => modules.get(file))
    .find((candidate) => candidate !== undefined);
};

const exportedFunction = (
  module: ModuleIndex,
  name: string,
  seen = new Set<string>(),
): ts.FunctionLikeDeclaration | undefined => {
  if (seen.has(name)) {
    return undefined;
  }
  seen.add(name);
  for (const statement of module.source.statements) {
    if (
      !ts.canHaveModifiers(statement) ||
      !ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return hasIdentifierAssignment(module.source, name)
        ? undefined
        : statement;
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const declaration = statement.declarationList.declarations.find(
      (item) => ts.isIdentifier(item.name) && item.name.text === name,
    );
    if (!declaration?.initializer) {
      continue;
    }
    if (
      statement.declarationList.getFirstToken()?.kind !==
      ts.SyntaxKind.ConstKeyword
    ) {
      return undefined;
    }
    const initializer = unwrap(declaration.initializer);
    if (
      ts.isArrowFunction(initializer) ||
      ts.isFunctionExpression(initializer)
    ) {
      return initializer;
    }
    if (ts.isIdentifier(initializer)) {
      return exportedFunction(module, initializer.text, seen);
    }
  }
  return undefined;
};

const hasIdentifierAssignment = (
  source: ts.SourceFile,
  name: string,
): boolean => {
  let reassigned = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      reassigned = true;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
        node.operator,
      ) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === name
    ) {
      reassigned = true;
    }
    if (!reassigned) {
      ts.forEachChild(node, visit);
    }
  };
  visit(source);
  return reassigned;
};

const factoryFunction = ({
  module,
  expression,
  reference,
  modules,
  seen,
}: FactoryFunctionArgs):
  | { module: ModuleIndex; functionLike: ts.FunctionLikeDeclaration }
  | undefined => {
  const callee = unwrap(expression);
  if (!ts.isIdentifier(callee)) {
    return undefined;
  }
  const binding = localBinding(module, callee.text, reference);
  if (binding) {
    if (binding.functionLike) {
      if (binding.mutable && !ts.isFunctionDeclaration(binding.functionLike)) {
        return undefined;
      }
      if (
        ts.isFunctionDeclaration(binding.functionLike) &&
        hasIdentifierAssignment(module.source, callee.text)
      ) {
        return undefined;
      }
      return { module, functionLike: binding.functionLike };
    }
    if (binding.mutable) {
      return undefined;
    }
    if (!binding.value) {
      return undefined;
    }
    const initializer = unwrap(binding.value);
    if (
      ts.isArrowFunction(initializer) ||
      ts.isFunctionExpression(initializer)
    ) {
      return { module, functionLike: initializer };
    }
    if (ts.isIdentifier(initializer)) {
      const key = `${module.file}:${initializer.text}:${binding.scope.pos}`;
      if (seen.has(key)) {
        return undefined;
      }
      seen.add(key);
      return factoryFunction({
        module,
        expression: initializer,
        reference: binding.scope,
        modules,
        seen,
      });
    }
    return undefined;
  }
  const imported = module.imports.get(callee.text);
  if (
    !imported ||
    imported.imported === "*" ||
    imported.imported === "default"
  ) {
    return undefined;
  }
  const target = importedModule(module, imported.module, modules);
  const functionLike = target && exportedFunction(target, imported.imported);
  return target && functionLike ? { module: target, functionLike } : undefined;
};

type TaggedFactoryArgs = Omit<
  FactoryFunctionArgs,
  "expression" | "reference"
> & {
  functionLike: ts.FunctionLikeDeclaration;
  names: ReadonlySet<string>;
};
const functionReturnsTaggedReader = ({
  module,
  functionLike,
  names,
  modules,
  seen,
}: TaggedFactoryArgs): boolean => {
  if (!functionLike.body) {
    return false;
  }
  if (!ts.isBlock(functionLike.body)) {
    return isTaggedReaderValue({
      module,
      expression: functionLike.body,
      reference: functionLike.body,
      names,
      modules,
      seen,
    });
  }
  const returns: ts.ReturnStatement[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && node !== functionLike) {
      return;
    }
    if (ts.isReturnStatement(node)) {
      returns.push(node);
      return;
    }
    ts.forEachChild(node, collect);
  };
  collect(functionLike.body);
  const lastStatement = functionLike.body.statements.at(-1);
  return (
    returns.length > 0 &&
    lastStatement !== undefined &&
    ts.isReturnStatement(lastStatement) &&
    returns.every(
      (item) =>
        item.expression !== undefined &&
        isTaggedReaderValue({
          module,
          expression: item.expression,
          reference: item.expression,
          names,
          modules,
          seen: new Set(seen),
        }),
    )
  );
};

type ForwardedReaderOptionsArgs = {
  module: ModuleIndex;
  expression: ts.Expression;
  reference: ts.Node;
  parameter: ts.ParameterDeclaration;
  seen: Set<Binding>;
};

const forwardsReaderOptions = ({
  module,
  expression,
  reference,
  parameter,
  seen,
}: ForwardedReaderOptionsArgs): boolean => {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) {
    const parameterBinding = localBinding(module, value.text, reference);
    if (
      ts.isIdentifier(parameter.name) &&
      value.text === parameter.name.text &&
      parameterBinding?.scope === parameter.parent &&
      !hasBindingPropertyMutation(module, parameterBinding)
    ) {
      return true;
    }
    const resolved = unchangedOptionsBinding({
      module,
      identifier: value,
      reference,
    });
    if (!resolved || seen.has(resolved.binding)) {
      return false;
    }
    return forwardsReaderOptions({
      module,
      expression: resolved.expression,
      reference: resolved.reference,
      parameter,
      seen: new Set(seen).add(resolved.binding),
    });
  }
  if (ts.isConditionalExpression(value)) {
    return [value.whenTrue, value.whenFalse].every((branch) =>
      forwardsReaderOptions({
        module,
        expression: branch,
        reference,
        parameter,
        seen: new Set(seen),
      }),
    );
  }
  if (!ts.isObjectLiteralExpression(value)) {
    return false;
  }
  return (
    validateTaggedSpreadOverrides({
      module,
      expression: value,
      reference,
      allowedOverrides: READER_SPREAD_OVERRIDES,
      isTaggedSpread: (spread, spreadReference) =>
        forwardsReaderOptions({
          module,
          expression: spread,
          reference: spreadReference,
          parameter,
          seen: new Set(seen),
        }),
    }) === "tagged"
  );
};

type WrapperForwardsReaderOptionsArgs = {
  module: ModuleIndex;
  functionLike: ts.FunctionLikeDeclaration;
  modules: ReadonlyMap<string, ModuleIndex>;
  seen: Set<string>;
};

const wrapperForwardsReaderOptions = ({
  module,
  functionLike,
  modules,
  seen,
}: WrapperForwardsReaderOptionsArgs): boolean | undefined => {
  const parameter = functionLike.parameters.at(0);
  if (!functionLike.body) {
    return undefined;
  }
  const readerForwards: boolean[] = [];
  const visit = (node: ts.Node) => {
    if (readerForwards.includes(false)) {
      return;
    }
    if (ts.isFunctionLike(node) && node !== functionLike) {
      return;
    }
    if (!ts.isCallExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    const name = callName(node);
    if (name && READER_EXECUTORS.has(name)) {
      const options = node.arguments.at(0);
      readerForwards.push(
        parameter !== undefined &&
          ts.isIdentifier(parameter.name) &&
          options !== undefined &&
          forwardsReaderOptions({
            module,
            expression: options,
            reference: node,
            parameter,
            seen: new Set(),
          }),
      );
      return;
    }
    const target = factoryFunction({
      module,
      expression: node.expression,
      reference: node,
      modules,
      seen: new Set(),
    });
    if (target) {
      const argument = node.arguments.at(0);
      const key = `${target.module.file}:${target.functionLike.pos}:${target.functionLike.end}`;
      const nestedForwards = !seen.has(key)
        ? wrapperForwardsReaderOptions({
            module: target.module,
            functionLike: target.functionLike,
            modules,
            seen: new Set(seen).add(key),
          })
        : false;
      if (nestedForwards !== undefined) {
        readerForwards.push(
          nestedForwards &&
            parameter !== undefined &&
            ts.isIdentifier(parameter.name) &&
            argument !== undefined &&
            forwardsReaderOptions({
              module,
              expression: argument,
              reference: node,
              parameter,
              seen: new Set(),
            }),
        );
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(functionLike.body);
  return readerForwards.length > 0 ? readerForwards.every(Boolean) : undefined;
};

const isTaggedReaderValue = ({
  module,
  expression,
  reference,
  names,
  modules,
  seen,
}: TaggedReaderArgs): boolean => {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) {
    const resolved = unchangedOptionsBinding({
      module,
      identifier: value,
      reference,
    });
    if (!resolved) {
      return false;
    }
    const key = `${module.file}:options:${resolved.reference.pos}:${value.text}`;
    if (seen.has(key)) {
      return false;
    }
    return isTaggedReaderValue({
      module,
      expression: resolved.expression,
      reference: resolved.reference,
      names,
      modules,
      seen: new Set(seen).add(key),
    });
  }
  if (ts.isConditionalExpression(value)) {
    return (
      isTaggedReaderValue({
        module,
        expression: value.whenTrue,
        reference,
        names,
        modules,
        seen: new Set(seen),
      }) &&
      isTaggedReaderValue({
        module,
        expression: value.whenFalse,
        reference,
        names,
        modules,
        seen: new Set(seen),
      })
    );
  }
  if (ts.isObjectLiteralExpression(value)) {
    const validation = validateTaggedSpreadOverrides({
      module,
      expression: value,
      reference,
      allowedOverrides: READER_SPREAD_OVERRIDES,
      isTaggedSpread: (spread, spreadReference) =>
        isTaggedReaderValue({
          module,
          expression: spread,
          reference: spreadReference,
          names,
          modules,
          seen: new Set(seen),
        }),
    });
    return validation === "tagged";
  }
  if (!ts.isCallExpression(value)) {
    return false;
  }
  if (canonicalCall(module, value, READER_HELPER)) {
    return isValidHelperConfig(module, value.arguments.at(1), names);
  }
  const target = factoryFunction({
    module,
    expression: value.expression,
    reference: value,
    modules,
    seen: new Set(),
  });
  if (!target) {
    return false;
  }
  const key = `${target.module.file}:${target.functionLike.pos}:${target.functionLike.end}`;
  if (seen.has(key)) {
    return false;
  }
  const nextSeen = new Set(seen).add(key);
  return functionReturnsTaggedReader({
    module: target.module,
    functionLike: target.functionLike,
    names,
    modules,
    seen: nextSeen,
  });
};

type ReaderState = {
  entry: MutationQueryCensus["readers"][number];
  module: ModuleIndex | undefined;
  call: ts.CallExpression | undefined;
  tagged: boolean;
};
type ReaderStatesArgs = {
  entries: MutationQueryCensus["readers"];
  indexed: ReadonlyMap<string, ModuleIndex>;
  names: ReadonlySet<string>;
  find: (entry: {
    id: string;
    file: string;
    line: number;
    column: number;
    callee: string;
  }) => ts.CallExpression | undefined;
};
const createReaderStates = ({
  entries,
  indexed,
  names,
  find,
}: ReaderStatesArgs): ReaderState[] =>
  entries.map((entry) => {
    const module = indexed.get(entry.file);
    const call = find(entry);
    if (!module || !call) {
      return { entry, module, call, tagged: false };
    }
    const options = call.arguments.at(
      ROUTE_READER_HELPERS.has(callName(call) ?? "") ? 1 : 0,
    );
    const target = factoryFunction({
      module,
      expression: call.expression,
      reference: call,
      modules: indexed,
      seen: new Set(),
    });
    let tagged: boolean;
    if (ROUTE_READER_HELPERS.has(callName(call) ?? "")) {
      tagged =
        options !== undefined &&
        isTaggedReaderValue({
          module,
          expression: options,
          reference: call,
          names,
          modules: indexed,
          seen: new Set(),
        });
    } else if (target) {
      tagged =
        options !== undefined &&
        wrapperForwardsReaderOptions({
          module: target.module,
          functionLike: target.functionLike,
          modules: indexed,
          seen: new Set([
            `${target.module.file}:${target.functionLike.pos}:${target.functionLike.end}`,
          ]),
        }) === true &&
        isTaggedReaderValue({
          module,
          expression: options,
          reference: call,
          names,
          modules: indexed,
          seen: new Set(),
        });
    } else if (
      entry.kind === "wrapper" ||
      !READER_PRIMITIVES.has(callName(call) ?? "")
    ) {
      tagged =
        options !== undefined &&
        isTaggedReaderValue({
          module,
          expression: options,
          reference: call,
          names,
          modules: indexed,
          seen: new Set(),
        });
    } else {
      tagged = wrappedReaderCall(module, call, names);
    }
    return { entry, module, call, tagged };
  });

const coveredReaderIds = (
  readerStates: readonly ReaderState[],
): Set<string> => {
  const readersById = new Map(
    readerStates.map(({ entry }) => [entry.id, entry]),
  );
  const validReaderIds = new Set(
    readerStates.filter(({ tagged }) => tagged).map(({ entry }) => entry.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const { entry } of readerStates) {
      if (
        entry.kind !== "wrapper" ||
        validReaderIds.has(entry.id) ||
        entry.wrapperOf.length === 0 ||
        !entry.wrapperOf.every(
          (id) => readersById.has(id) && validReaderIds.has(id),
        )
      ) {
        continue;
      }
      validReaderIds.add(entry.id);
      changed = true;
    }
  }
  return validReaderIds;
};

const invalidReaderHelperFindings = (
  modules: ReadonlyMap<string, ModuleIndex>,
  names: ReadonlySet<string>,
): Finding[] => {
  const findings: Finding[] = [];
  for (const module of modules.values()) {
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        canonicalCall(module, node, READER_HELPER) &&
        !isValidHelperConfig(module, node.arguments.at(1), names)
      ) {
        const { line, character } = module.source.getLineAndCharacterOfPosition(
          node.getStart(module.source),
        );
        findings.push({
          id: `${module.file}:${READER_HELPER}:${line + 1}:${character + 1}:reader-helper`,
          file: module.file,
          reason:
            "resourceQueryOptions requires valid resources and scope metadata or an explicit independent declaration.",
          disposition: "invalid-declaration",
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(module.source);
  }
  return findings;
};

/** Returns exact legacy IDs and malformed helper uses; additions are never silently accepted. */
export const inspectMutationQueryInvalidation = (
  census: MutationQueryCensus,
  sources: readonly Source[],
): Finding[] => {
  const indexed = new Map(
    sources.map((source) => [source.file, indexSource(source)]),
  );
  const names = resourceTypeNames(
    sources.find(({ file }) => file === API_CONTRACT_MODULE)?.text ??
      readFileSync(path.join(ROOT, API_CONTRACT_MODULE), "utf-8"),
  );
  const contracts = mutationContracts(indexed.get(CONTRACT_MODULE), names);
  const calls = new Map<string, ts.CallExpression>();
  const find = (entry: {
    id: string;
    file: string;
    line: number;
    column: number;
    callee: string;
  }) => {
    const cached = calls.get(entry.id);
    if (cached) {
      return cached;
    }
    const module = indexed.get(entry.file);
    if (!module) {
      return undefined;
    }
    const call = findCall(module, entry);
    if (call) {
      calls.set(entry.id, call);
    }
    return call;
  };
  const findings: Finding[] = [];
  const validMutationIds = new Set<string>();
  const invalidMutationReasons = new Map<string, string>();
  const invalidMutationIds = new Set<string>();
  const mutationReason = () =>
    `Existing mutation pending migration to ${MUTATION_HELPER} with its resource declaration.`;

  for (const entry of census.mutations) {
    const module = indexed.get(entry.file);
    const call = find(entry);
    if (!module || !call) {
      invalidMutationIds.add(entry.id);
      invalidMutationReasons.set(
        entry.id,
        "Mutation call location could not be resolved from its census.",
      );
      continue;
    }
    const name = callName(call) ?? "";
    const isPrimitive = MUTATION_PRIMITIVES.has(name);
    const inOwner =
      entry.file === REALTIME_MODULE &&
      enclosingFunctionName(call) === MUTATION_HELPER;
    if (inOwner && isPrimitive) {
      validMutationIds.add(entry.id);
      continue;
    }
    const execution = inspectMutationExecution({
      module,
      call,
      entry,
      contracts,
    });
    switch (execution.status) {
      case "valid":
        validMutationIds.add(entry.id);
        break;
      case "invalid":
        invalidMutationIds.add(entry.id);
        invalidMutationReasons.set(entry.id, execution.reason);
        break;
      case "unwrapped":
        break;
      default:
        execution satisfies never;
        return panic("Unknown mutation execution status");
    }
  }

  // A caller of a hook is covered only when every mutation definition it
  // reaches is itself routed through the canonical declaration helper.
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of census.mutations) {
      if (
        validMutationIds.has(entry.id) ||
        invalidMutationIds.has(entry.id) ||
        entry.kind !== "wrapper" ||
        entry.ownUnresolved.length > 0 ||
        entry.wrapperOf.length === 0
      ) {
        continue;
      }
      if (entry.wrapperOf.every((id) => validMutationIds.has(id))) {
        if (entry.ownWrites.length > 0) {
          invalidMutationIds.add(entry.id);
          invalidMutationReasons.set(
            entry.id,
            "Mutation wrapper contains writes outside its nested mutation primitives.",
          );
        } else {
          validMutationIds.add(entry.id);
        }
        changed = true;
      }
    }
  }
  for (const entry of census.mutations) {
    if (!validMutationIds.has(entry.id)) {
      findings.push({
        id: `${entry.id}:mutation`,
        file: entry.file,
        reason: invalidMutationReasons.get(entry.id) ?? mutationReason(),
        disposition: invalidMutationIds.has(entry.id)
          ? "invalid-declaration"
          : "legacy",
      });
    }
  }

  const readerReason = () =>
    `Existing query reader pending migration to ${READER_HELPER} resource metadata.`;
  const readerStates = createReaderStates({
    entries: census.readers,
    indexed,
    names,
    find,
  });
  const validReaderIds = coveredReaderIds(readerStates);
  for (const { entry, module, call } of readerStates) {
    if (!module || !call) {
      findings.push({
        id: `${entry.id}:reader`,
        file: entry.file,
        reason: "Query reader location could not be resolved from its census.",
        disposition: "legacy",
      });
      continue;
    }
    if (!validReaderIds.has(entry.id)) {
      findings.push({
        id: `${entry.id}:reader`,
        file: entry.file,
        reason: readerReason(),
        disposition: "legacy",
      });
    }
  }
  findings.push(...invalidReaderHelperFindings(indexed, names));
  return findings.toSorted((left, right) => compareCodeUnit(left.id, right.id));
};

const reasonFor = (finding: Finding) => finding.reason;
const git = (args: readonly string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
};
const committedEntries = (revision: string): Record<string, string> | null => {
  const listed = git(["ls-tree", "--name-only", revision, "--", BASELINE]);
  if (listed === null) {
    return panic("Cannot inspect the committed mutation/query baseline");
  }
  if (!listed) {
    return null;
  }
  const content = git(["show", `${revision}:${BASELINE}`]);
  if (content === null) {
    return panic("Cannot read the committed mutation/query baseline");
  }
  return v.parse(baselineSchema, JSON.parse(content)).entries;
};

export const checkBaseline = ({
  observed,
  recorded,
  committed,
  write,
}: {
  observed: readonly Finding[];
  recorded: Record<string, string>;
  committed: Record<string, string> | null;
  write: boolean;
}) => {
  const invalidDeclarations = observed.filter(
    ({ disposition }) => disposition === "invalid-declaration",
  );
  if (invalidDeclarations.length > 0) {
    return {
      ok: false,
      entries: recorded,
      errors: invalidDeclarations.map(
        ({ id, reason }) => `Invalid declaration: ${id}: ${reason}`,
      ),
    };
  }
  const observedIds = new Set<string>();
  const duplicates = new Set<string>();
  for (const { id } of observed) {
    if (observedIds.has(id)) {
      duplicates.add(id);
    }
    observedIds.add(id);
  }
  if (duplicates.size > 0) {
    return {
      ok: false,
      entries: recorded,
      errors: [...duplicates]
        .toSorted(compareCodeUnit)
        .map((id) => `Duplicate observed finding ID: ${id}`),
    };
  }
  const byId = new Map(observed.map((finding) => [finding.id, finding]));
  const additions = [...byId.keys()].filter((id) => !(id in recorded));
  const stale = Object.keys(recorded).filter((id) => !byId.has(id));
  const growth =
    committed === null
      ? []
      : Object.keys(recorded).filter((id) => !(id in committed));
  const reworded =
    committed === null
      ? []
      : Object.keys(recorded).filter(
          (id) => id in committed && recorded[id] !== committed[id],
        );
  if (
    growth.length ||
    reworded.length ||
    (committed !== null && additions.length)
  ) {
    return {
      ok: false,
      entries: recorded,
      errors: [
        ...growth.map((id) => `Added baseline entry: ${id}`),
        ...reworded.map((id) => `Changed baseline reason: ${id}`),
        ...(committed !== null
          ? additions.map((id) => `New unclassified site: ${id}`)
          : []),
        ...stale.map((id) => `Stale baseline entry: ${id}`),
      ],
    };
  }
  if (write) {
    const next =
      committed === null
        ? Object.fromEntries(
            observed.map((finding) => [finding.id, reasonFor(finding)]),
          )
        : Object.fromEntries(
            Object.entries(recorded).filter(([id]) => byId.has(id)),
          );
    return { ok: true, entries: next, errors: [] as string[] };
  }
  return {
    ok: additions.length === 0 && stale.length === 0,
    entries: recorded,
    errors: [
      ...additions.map((id) => `New unclassified site: ${id}`),
      ...stale.map((id) => `Stale baseline entry: ${id}`),
    ],
  };
};

const main = () => {
  const census = generateMutationQueryCensus(ROOT);
  const sources = census.scope.files.map((file) => ({
    file,
    text: readFileSync(path.join(ROOT, file), "utf-8"),
  }));
  if (!sources.some(({ file }) => file === API_CONTRACT_MODULE)) {
    sources.push({
      file: API_CONTRACT_MODULE,
      text: readFileSync(path.join(ROOT, API_CONTRACT_MODULE), "utf-8"),
    });
  }
  if (!sources.some(({ file }) => file === CONTRACT_MODULE)) {
    sources.push({
      file: CONTRACT_MODULE,
      text: readFileSync(path.join(ROOT, CONTRACT_MODULE), "utf-8"),
    });
  }
  const observed = inspectMutationQueryInvalidation(census, sources);
  const baselinePath = path.join(ROOT, BASELINE);
  const baseline = v.parse(
    baselineSchema,
    JSON.parse(readFileSync(baselinePath, "utf-8")),
  );
  const baseRevision = (
    git(
      process.env["BASE_SHA"]
        ? ["rev-parse", "--verify", `${process.env["BASE_SHA"]}^{commit}`]
        : ["merge-base", "HEAD", "origin/main"],
    ) ??
    panic(
      "Cannot resolve the mutation/query invalidation baseline base revision",
    )
  ).trim();
  const result = checkBaseline({
    observed,
    recorded: baseline.entries,
    committed: committedEntries(baseRevision),
    write: process.argv.includes("--write"),
  });
  if (!result.ok) {
    process.stderr.write(
      `Mutation/query invalidation baseline failed.\n${result.errors.join("\n")}\n`,
    );
    process.exit(1);
  }
  if (process.argv.includes("--write")) {
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ entries: result.entries }, null, 2)}\n`,
    );
  }
  process.stdout.write(
    `Mutation/query invalidation: ${String(census.mutations.length)} mutations, ${String(census.readers.length)} readers, ${String(observed.length)} legacy requirements.\n`,
  );
};

if (import.meta.main) {
  main();
}
