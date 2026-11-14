// Write contracts of every mutation the API serves.
//
// The route table the API serves (`apiRoutes`) is read as data: every POST,
// PUT, PATCH and DELETE route declares `patch` or `replace`, through the
// contract its safe factory recorded for the definition or, for a route no
// safe factory built, through `RAW_WRITE_CONTRACTS` keyed by method and path.
// A replacement names its precondition, and one checked against a stored
// timestamp or revision must reach the owner's enforcement in the source of
// the handler export the route mounts. Deferred replacements sit in the
// reasoned, shrink-only baseline and the owner's debt id list, which move
// together.
import { panic } from "better-result";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

import { SAFE_HANDLER_FACTORIES } from "../apps/api/src/lib/safe-handler-factories";
import { RAW_WRITE_CONTRACTS } from "../apps/api/src/lib/write-contract/raw-write-contracts";
import {
  type ArrowFunctionExpression,
  type BlockStatement,
  type CallExpression,
  type Function as SyntaxFunction,
  type Node,
  parseSource,
  type Program,
  type VariableDeclaration,
  walk,
} from "../packages/scripts/src/syntax-tree.ts";
import { BASELINE_PATHS } from "./baseline-paths";

const ROOT = path.resolve(import.meta.dir, "..");
const OWNER = "apps/api/src/lib/write-contract/write-contract.ts";
const BASELINE = BASELINE_PATHS.writeContracts;
const writeContractBaselineSchema = v.array(
  v.strictObject({
    key: v.string(),
    count: v.pipe(v.number(), v.integer(), v.minValue(1)),
    reason: v.pipe(v.string(), v.trim(), v.minLength(1)),
    baselineId: v.pipe(v.string(), v.minLength(1)),
  }),
);
export type WriteContractBaseline = v.InferOutput<
  typeof writeContractBaselineSchema
>;
type SourceLoader = (file: string) => string | undefined;
type LexicalScope = ReadonlyMap<string, Node | undefined>;
type LocatedExpression = {
  file: string;
  node: Node;
  scope?: LexicalScope | undefined;
};

// oxc nodes carry no parent links; each parsed file records them once.
const PARENTS = new WeakMap<Node, Node>();
const parentOf = (node: Node): Node | undefined => PARENTS.get(node);

// A node's identity within its file, for cycle detection.
const identity = (node: Node) => `${String(node.start)}-${String(node.end)}`;

// A wrapper the compiler sees through: optional chains included, which oxc
// wraps and the compiler does not.
const unwrap = (node: Node): Node => {
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "ParenthesizedExpression" ||
    node.type === "ChainExpression"
  ) {
    return unwrap(node.expression);
  }
  return node;
};

// `object.name`, not computed.
const memberName = (node: Node): string | undefined =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.property.type === "Identifier"
    ? node.property.name
    : undefined;

const isWrapperFunction = (
  node: Node,
): node is ArrowFunctionExpression | SyntaxFunction =>
  node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression";

// A method's function belongs to its member, which the compiler reads as one
// method declaration rather than a function expression.
const isMethodFunction = (node: Node): boolean => {
  const parent = parentOf(node);
  return (
    node.type === "FunctionExpression" &&
    (parent?.type === "MethodDefinition" ||
      parent?.type === "TSAbstractMethodDefinition" ||
      (parent?.type === "Property" &&
        (parent.method || parent.kind !== "init")))
  );
};

const FUNCTION_LIKE = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "MethodDefinition",
  "TSAbstractMethodDefinition",
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "TSConstructorType",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
  "TSFunctionType",
  "TSMethodSignature",
]);

const isFunctionLike = (node: Node): boolean =>
  FUNCTION_LIKE.has(node.type) ||
  (node.type === "Property" && (node.method || node.kind !== "init"));

const isConstDeclaration = (node: Node): node is VariableDeclaration =>
  node.type === "VariableDeclaration" && node.kind === "const";

const isNullLiteral = (node: Node) =>
  node.type === "Literal" && node.value === null && !("regex" in node);

const stringText = (node: Node): string | undefined => {
  if (node.type === "Literal") {
    return typeof node.value === "string" ? node.value : undefined;
  }
  return node.type === "TemplateLiteral" && node.expressions.length === 0
    ? (node.quasis.at(0)?.value.cooked ?? "")
    : undefined;
};

const moduleExportName = (name: Node): string | undefined => {
  if (name.type === "Identifier") {
    return name.name;
  }
  return name.type === "Literal" && typeof name.value === "string"
    ? name.value
    : undefined;
};

// The statement an `export` (named or default) declares, or the statement.
const declaredStatement = (statement: Node): Node => {
  if (
    (statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration") &&
    statement.declaration !== null
  ) {
    return statement.declaration;
  }
  return statement;
};

// The value a call yields once awaits, parentheses and type assertions are
// read through.
const outermostValue = (call: CallExpression): Node => {
  let expression: Node = call;
  for (
    let parent = parentOf(expression);
    parent?.type === "AwaitExpression" ||
    parent?.type === "ParenthesizedExpression" ||
    parent?.type === "TSAsExpression" ||
    parent?.type === "TSSatisfiesExpression" ||
    parent?.type === "ChainExpression";
    parent = parentOf(expression)
  ) {
    expression = parent;
  }
  return expression;
};

// `const name = <call>;` as the only declaration of a statement in a block.
const conflictDeclaration = (declarator: Node | undefined) => {
  const statement = declarator === undefined ? undefined : parentOf(declarator);
  if (
    declarator?.type !== "VariableDeclarator" ||
    declarator.id.type !== "Identifier" ||
    statement === undefined ||
    !isConstDeclaration(statement) ||
    statement.declarations.length !== 1
  ) {
    return undefined;
  }
  const block = parentOf(statement);
  return block?.type === "BlockStatement"
    ? { block, name: declarator.id.name, statement }
    : undefined;
};

// `name`, `name !== null` or `null != name`.
const checksNonNull = (condition: Node, name: string): boolean => {
  if (condition.type === "Identifier") {
    return condition.name === name;
  }
  if (
    condition.type !== "BinaryExpression" ||
    (condition.operator !== "!==" && condition.operator !== "!=")
  ) {
    return false;
  }
  const { left, right } = condition;
  return (
    (left.type === "Identifier" &&
      left.name === name &&
      isNullLiteral(right)) ||
    (right.type === "Identifier" && right.name === name && isNullLiteral(left))
  );
};

/** Recognize only a returned value or an immediate conflict early return. */
const propagatesConflict = (call: CallExpression): boolean => {
  const parent = parentOf(outermostValue(call));
  if (
    parent?.type === "ReturnStatement" ||
    parent?.type === "ArrowFunctionExpression"
  ) {
    return true;
  }
  const declaration = conflictDeclaration(parent);
  if (declaration === undefined) {
    return false;
  }
  const { block, name, statement } = declaration;
  const next = block.body.at(block.body.indexOf(statement) + 1);
  const returnsConflict = (node: Node): boolean => {
    if (node.type === "BlockStatement") {
      const only = node.body.at(0);
      return (
        node.body.length === 1 && only !== undefined && returnsConflict(only)
      );
    }
    if (node.type !== "ReturnStatement" || node.argument === null) {
      return false;
    }
    const value = unwrap(node.argument);
    return value.type === "Identifier" && value.name === name;
  };
  if (next?.type === "ReturnStatement") {
    return returnsConflict(next);
  }
  return (
    next?.type === "IfStatement" &&
    next.alternate === null &&
    checksNonNull(unwrap(next.test), name) &&
    returnsConflict(next.consequent)
  );
};

const modulePath = (file: string, specifier: string) => {
  let target: string | undefined;
  if (specifier.startsWith("@/api/")) {
    target = `apps/api/src/${specifier.slice(6)}`;
  } else if (specifier.startsWith(".")) {
    target = path.posix.join(path.posix.dirname(file), specifier);
  }
  return target === undefined
    ? undefined
    : `${target.replace(/\.ts$/u, "")}.ts`;
};

type BindingReference = { file: string; name: string };
type BindingReferenceOptions = BindingReference & { statement: Node };
type BindingOptions = { file: string; name: string; visited?: Set<string> };
type FactoryBindingOptions = {
  file: string;
  expression: Node;
  seen?: Set<string>;
  scope?: LexicalScope | undefined;
};

type LocalHandlerLookup =
  | { type: "none" }
  | { type: "unique"; value: LocatedExpression }
  | { type: "ambiguous"; values: readonly LocatedExpression[] };
type HandlerBindingOptions = { reference: BindingReference; handler: string };

type SafeCallOptions = {
  value: LocatedExpression;
  seen?: Set<string>;
  handler: string;
};
type EnforcementOptions = {
  value: LocatedExpression;
  type: string;
  seen: Set<string>;
};
type EnforcementCallOptions = Omit<EnforcementOptions, "value"> & {
  value: LocatedExpression & { node: CallExpression };
};
type SafeCall = LocatedExpression & {
  node: CallExpression;
  configArgument: (typeof SAFE_HANDLER_FACTORIES)[keyof typeof SAFE_HANDLER_FACTORIES]["configArgument"];
};

// Every name a binding pattern declares, defaults and rests included.
const bindingNames = (name: Node): string[] => {
  if (name.type === "Identifier") {
    return [name.name];
  }
  if (name.type === "AssignmentPattern") {
    return bindingNames(name.left);
  }
  if (name.type === "RestElement") {
    return bindingNames(name.argument);
  }
  if (name.type === "ObjectPattern") {
    return name.properties.flatMap((property) =>
      bindingNames(property.type === "RestElement" ? property : property.value),
    );
  }
  return name.type === "ArrayPattern"
    ? name.elements.flatMap((element) =>
        element === null ? [] : bindingNames(element),
      )
    : [];
};

const wrapperScope = ({ node, scope }: LocatedExpression): LexicalScope => {
  const bindings = new Map(scope);
  if (!isWrapperFunction(node)) {
    return bindings;
  }
  for (const parameter of node.params) {
    for (const name of bindingNames(parameter)) {
      bindings.set(name, undefined);
    }
  }
  if (node.body?.type !== "BlockStatement") {
    return bindings;
  }
  return blockScope(node.body, bindings);
};

const blockScope = (
  block: BlockStatement,
  parent: LexicalScope,
): LexicalScope => {
  const bindings = new Map(parent);
  for (const statement of block.body) {
    if (statement.type === "FunctionDeclaration" && statement.id !== null) {
      bindings.set(statement.id.name, undefined);
    }
    if (statement.type !== "VariableDeclaration") {
      continue;
    }
    for (const declaration of statement.declarations) {
      const initializer =
        declaration.id.type === "Identifier" && statement.kind === "const"
          ? (declaration.init ?? undefined)
          : undefined;
      for (const name of bindingNames(declaration.id)) {
        bindings.set(name, initializer);
      }
    }
  }
  return bindings;
};

const wrapperReturn = (
  wrapper: ArrowFunctionExpression | SyntaxFunction,
): Node | undefined => {
  if (wrapper.async || wrapper.generator) {
    return undefined;
  }
  const { body } = wrapper;
  if (body === null) {
    return undefined;
  }
  if (body.type !== "BlockStatement") {
    return body;
  }
  const direct = body.body.filter(
    (statement) => statement.type === "ReturnStatement",
  );
  if (direct.length !== 1) {
    return undefined;
  }
  let returns = 0;
  walk(body, (node) => {
    if (isFunctionLike(node)) {
      return "skip-children";
    }
    if (node.type === "ReturnStatement") {
      returns += 1;
    }
    return undefined;
  });
  const only = direct.at(0);
  return returns === 1 && only?.type === "ReturnStatement"
    ? (only.argument ?? undefined)
    : undefined;
};

type FactoryImportOptions = {
  file: string;
  node: Node;
  name: string;
  statement: Node;
};
const factoryImport = ({
  file,
  node,
  name,
  statement,
}: FactoryImportOptions) => {
  if (statement.type !== "ImportDeclaration") {
    return undefined;
  }
  const target = modulePath(file, statement.source.value);
  if (target === undefined || statement.importKind === "type") {
    return undefined;
  }
  for (const item of statement.specifiers) {
    if (
      item.type === "ImportSpecifier" &&
      node.type === "Identifier" &&
      item.local.name === name &&
      item.importKind !== "type"
    ) {
      return {
        module: target,
        imported: moduleExportName(item.imported) ?? item.local.name,
      };
    }
    const property = memberName(node);
    if (
      item.type === "ImportNamespaceSpecifier" &&
      item.local.name === name &&
      property !== undefined
    ) {
      return { module: target, imported: property };
    }
  }
  return undefined;
};

class WriteSourceResolver {
  private readonly load: SourceLoader;
  constructor(load: SourceLoader) {
    this.load = load;
  }
  private readonly sources = new Map<string, Program>();
  source = (file: string) => {
    const cached = this.sources.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const content = this.load(file);
    if (content === undefined) {
      return undefined;
    }
    const { program } = parseSource(file, content);
    walk(program, (node, ancestors) => {
      const parent = ancestors.at(-1);
      if (parent !== undefined) {
        PARENTS.set(node, parent);
      }
    });
    this.sources.set(file, program);
    return program;
  };
  binding = ({
    file,
    name,
    visited = new Set<string>(),
  }: BindingOptions): LocatedExpression | undefined => {
    const key = `${file}#${name}`;
    if (visited.has(key)) {
      return undefined;
    }
    visited.add(key);
    const parsed = this.source(file);
    if (parsed === undefined) {
      return undefined;
    }
    for (const statement of parsed.body) {
      const exportedDefault =
        name === "default" ? defaultExpression(statement) : undefined;
      if (exportedDefault !== undefined) {
        return this.resolve({ file, node: exportedDefault }, visited);
      }
      const declaration = declaredStatement(statement);
      if (isConstDeclaration(declaration)) {
        for (const declarator of declaration.declarations) {
          if (
            declarator.id.type === "Identifier" &&
            declarator.id.name === name &&
            declarator.init !== null
          ) {
            return this.resolve({ file, node: declarator.init }, visited);
          }
        }
      }
      const reference = this.reference({ file, name, statement });
      if (reference !== undefined) {
        return this.binding({ ...reference, visited });
      }
    }
    return undefined;
  };
  reference = ({
    file,
    name,
    statement,
  }: BindingReferenceOptions): BindingReference | undefined => {
    if (statement.type === "ImportDeclaration") {
      const target = modulePath(file, statement.source.value);
      if (target === undefined || statement.specifiers.length === 0) {
        return undefined;
      }
      const defaultImport = statement.specifiers.find(
        (item) => item.type === "ImportDefaultSpecifier",
      );
      if (defaultImport?.local.name === name) {
        return { file: target, name: "default" };
      }
      const found = statement.specifiers.find(
        (item) => item.type === "ImportSpecifier" && item.local.name === name,
      );
      return found?.type === "ImportSpecifier"
        ? {
            file: target,
            name: moduleExportName(found.imported) ?? found.local.name,
          }
        : undefined;
    }
    if (
      statement.type !== "ExportNamedDeclaration" ||
      statement.declaration !== null
    ) {
      return undefined;
    }
    const found = statement.specifiers.find(
      (item) => moduleExportName(item.exported) === name,
    );
    if (found === undefined) {
      return undefined;
    }
    const target =
      statement.source === null
        ? file
        : modulePath(file, statement.source.value);
    return target === undefined
      ? undefined
      : { file: target, name: moduleExportName(found.local) ?? name };
  };
  resolve = (
    { file, node, scope }: LocatedExpression,
    visited = new Set<string>(),
  ): LocatedExpression | undefined => {
    const value = unwrap(node);
    if (value.type === "Identifier") {
      if (scope?.has(value.name)) {
        const initializer = scope.get(value.name);
        if (initializer === undefined) {
          return undefined;
        }
        const key = `${file}#local:${value.name}:${identity(initializer)}`;
        if (visited.has(key)) {
          return undefined;
        }
        visited.add(key);
        return this.resolve({ file, node: initializer, scope }, visited);
      }
      return this.binding({ file, name: value.name, visited });
    }
    const name = memberName(value);
    if (value.type === "MemberExpression" && name !== undefined) {
      const property = this.fields({ file, node: value.object, scope }).get(
        name,
      );
      return property === undefined
        ? undefined
        : this.resolve(property, visited);
    }
    return { file, node: value, scope };
  };
  fields = (
    value: LocatedExpression,
    visited = new Set<string>(),
  ): Map<string, LocatedExpression> => {
    const resolved = this.resolve(value);
    const result = new Map<string, LocatedExpression>();
    if (resolved?.node.type !== "ObjectExpression") {
      return result;
    }
    const key = `${resolved.file}:${identity(resolved.node)}`;
    if (visited.has(key)) {
      return result;
    }
    visited.add(key);
    for (const property of resolved.node.properties) {
      if (property.type === "SpreadElement") {
        const spread = this.resolve({
          file: resolved.file,
          node: property.argument,
          scope: resolved.scope,
        });
        if (spread?.node.type !== "ObjectExpression") {
          // An opaque later spread may overwrite every preceding declaration.
          result.clear();
          continue;
        }
        for (const [name, item] of this.fields(spread, new Set(visited))) {
          result.set(name, item);
        }
      } else if (property.kind === "init" && !property.method) {
        // A shorthand entry reads the binding its key names.
        const name = property.computed
          ? undefined
          : moduleExportName(property.key);
        if (name === undefined) {
          result.clear();
        } else {
          result.set(name, {
            file: resolved.file,
            node: property.value,
            scope: resolved.scope,
          });
        }
      }
    }
    return result;
  };
  text = (value: LocatedExpression | undefined): string | undefined => {
    if (value === undefined) {
      return undefined;
    }
    const resolved = this.resolve(value);
    if (resolved === undefined) {
      return undefined;
    }
    const literal = stringText(resolved.node);
    if (literal !== undefined) {
      return literal;
    }
    if (
      resolved.node.type === "BinaryExpression" &&
      resolved.node.operator === "+"
    ) {
      const left = this.text({
        file: resolved.file,
        node: resolved.node.left,
        scope: resolved.scope,
      });
      const right = this.text({
        file: resolved.file,
        node: resolved.node.right,
        scope: resolved.scope,
      });
      if (left !== undefined && right !== undefined) {
        return left + right;
      }
    }
    return undefined;
  };
  factoryBinding = ({
    file,
    expression,
    seen = new Set<string>(),
    scope,
  }: FactoryBindingOptions):
    { module: string; imported: string } | undefined => {
    const node = unwrap(expression);
    let name: string | undefined;
    if (node.type === "Identifier") {
      name = node.name;
    } else if (
      memberName(node) !== undefined &&
      node.type === "MemberExpression" &&
      node.object.type === "Identifier"
    ) {
      name = node.object.name;
    }
    if (name === undefined || seen.has(`${file}#${name}`)) {
      return undefined;
    }
    seen.add(`${file}#${name}`);
    if (scope?.has(name)) {
      const initializer = scope.get(name);
      return initializer === undefined
        ? undefined
        : this.factoryBinding({ file, expression: initializer, seen, scope });
    }
    for (const statement of this.source(file)?.body ?? []) {
      const imported = factoryImport({ file, node, name, statement });
      if (imported !== undefined) {
        return imported;
      }
      const declaration = declaredStatement(statement);
      if (
        declaration.type === "VariableDeclaration" &&
        node.type === "Identifier"
      ) {
        const found = declaration.declarations.find(
          (item) => item.id.type === "Identifier" && item.id.name === name,
        );
        if (found?.init) {
          return this.factoryBinding({
            file,
            expression: found.init,
            seen,
            scope,
          });
        }
      }
    }
    return undefined;
  };
  localHandlerBinding = ({
    file,
    name,
  }: BindingReference): LocalHandlerLookup => {
    if (name === "default") {
      return { type: "none" };
    }
    const candidates: LocatedExpression[] = [];
    const source = this.source(file);
    if (source !== undefined) {
      walk(source, (node, ancestors) => {
        const declaration = ancestors.at(-1);
        if (
          node.type !== "VariableDeclarator" ||
          node.id.type !== "Identifier" ||
          node.id.name !== name ||
          declaration?.type !== "VariableDeclaration"
        ) {
          return;
        }
        const wrapper = ancestors.findLast(
          (ancestor) =>
            isWrapperFunction(ancestor) && !isMethodFunction(ancestor),
        );
        // The compiler's declaration list sits in its statement or loop
        // header, which sits in the block.
        const holder = ancestors.at(-2);
        const statementBlock =
          holder?.type === "BlockStatement" ? holder : ancestors.at(-3);
        if (
          wrapper !== undefined &&
          isWrapperFunction(wrapper) &&
          wrapper.body?.type === "BlockStatement" &&
          statementBlock === wrapper.body &&
          (holder?.type === "BlockStatement" ||
            holder?.type === "ForStatement" ||
            holder?.type === "ForInStatement" ||
            holder?.type === "ForOfStatement")
        ) {
          candidates.push({
            file,
            node: node.id,
            scope: wrapperScope({ file, node: wrapper }),
          });
        }
      });
    }
    const value = candidates.at(0);
    if (value === undefined) {
      return { type: "none" };
    }
    if (candidates.length === 1) {
      return { type: "unique", value };
    }
    return { type: "ambiguous", values: candidates };
  };
  handlerBinding = ({
    reference,
    handler,
  }: HandlerBindingOptions): LocatedExpression | undefined => {
    const module = this.binding(reference);
    const local = this.localHandlerBinding(reference);
    switch (local.type) {
      case "none":
        return module;
      case "unique":
        if (module === undefined) {
          return local.value;
        }
        this.safeCalls({ value: module, handler });
        this.safeCalls({ value: local.value, handler });
        return undefined;
      case "ambiguous":
        if (module !== undefined) {
          this.safeCalls({ value: module, handler });
        }
        for (const value of local.values) {
          this.safeCalls({ value, handler });
        }
        return undefined;
      default:
        return panic(local satisfies never);
    }
  };
  safeCalls = ({
    value,
    seen = new Set<string>(),
    handler,
  }: SafeCallOptions): SafeCall[] | undefined => {
    const resolved = this.resolve(value);
    if (resolved === undefined) {
      return undefined;
    }
    if (resolved.node.type === "ConditionalExpression") {
      const left = this.safeCalls({
        value: {
          file: resolved.file,
          node: resolved.node.consequent,
          scope: resolved.scope,
        },
        seen: new Set(seen),
        handler,
      });
      const right = this.safeCalls({
        value: {
          file: resolved.file,
          node: resolved.node.alternate,
          scope: resolved.scope,
        },
        seen: new Set(seen),
        handler,
      });
      return left === undefined || right === undefined
        ? undefined
        : left.concat(right);
    }
    if (resolved.node.type !== "CallExpression") {
      return undefined;
    }
    const imported = this.factoryBinding({
      file: resolved.file,
      expression: resolved.node.callee,
      scope: resolved.scope,
    });
    const factory = Object.entries(SAFE_HANDLER_FACTORIES).find(
      ([name, definition]) =>
        name === imported?.imported &&
        modulePath(resolved.file, definition.module) === imported.module,
    );
    if (factory !== undefined) {
      return [
        {
          file: resolved.file,
          node: resolved.node,
          scope: resolved.scope,
          configArgument: factory[1].configArgument,
        },
      ];
    }
    const wrapper = this.resolve({
      file: resolved.file,
      node: resolved.node.callee,
      scope: resolved.scope,
    });
    if (
      wrapper === undefined ||
      !isWrapperFunction(wrapper.node) ||
      isMethodFunction(wrapper.node)
    ) {
      return undefined;
    }
    const key = `${wrapper.file}:${identity(wrapper.node)}`;
    if (seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    const returned = wrapperReturn(wrapper.node);
    if (returned === undefined) {
      return undefined;
    }
    return this.safeCalls({
      value: {
        file: wrapper.file,
        node: returned,
        scope: wrapperScope(wrapper),
      },
      seen,
      handler,
    });
  };
  private readonly handlers = new Map<string, SafeCall[]>();

  /** Follow only invoked functions and callbacks, never unrelated module declarations. */
  enforcementFields = (handler: string, type: string): Set<string> => {
    const calls = this.handlers.get(handler) ?? [];
    const perHandler = calls.map((safe) => {
      const callback = safe.node.arguments.at(1);
      if (callback === undefined) {
        return new Set<string>();
      }
      return this.functionEnforcement({
        value: { file: safe.file, node: callback, scope: safe.scope },
        type,
        seen: new Set(),
      });
    });
    const first = perHandler.at(0) ?? new Set<string>();
    return new Set(
      [...first].filter((field) =>
        perHandler.every((fields) => fields.has(field)),
      ),
    );
  };
  functionEnforcement = ({
    value,
    type,
    seen,
  }: EnforcementOptions): Set<string> => {
    const resolved = this.resolve(value);
    const result = new Set<string>();
    if (
      resolved === undefined ||
      !isWrapperFunction(resolved.node) ||
      isMethodFunction(resolved.node) ||
      resolved.node.body === null
    ) {
      return result;
    }
    const key = `${resolved.file}:${identity(resolved.node)}`;
    if (seen.has(key)) {
      return result;
    }
    seen.add(key);
    const scope = wrapperScope(resolved);
    const visit = (node: Node, currentScope: LexicalScope) => {
      // Only unconditional, propagated comparisons count: a branch, loop, catch, short
      // circuit or optional call may skip the comparison on some write path.
      if (isFunctionLike(node) || isConditionalExecution(node)) {
        return;
      }
      if (isShortCircuit(node)) {
        visit(node.left, currentScope);
        return;
      }
      // A catch can swallow a failure, and a finally can override a return.
      // Only propagation from the finally block survives either boundary.
      if (
        node.type === "TryStatement" &&
        (node.handler !== null || node.finalizer !== null)
      ) {
        if (node.finalizer !== null) {
          visit(node.finalizer, currentScope);
        }
        return;
      }
      const nestedScope =
        node.type === "BlockStatement"
          ? blockScope(node, currentScope)
          : currentScope;
      if (node.type === "CallExpression" && propagatesConflict(node)) {
        for (const field of this.callEnforcement({
          value: { file: resolved.file, node, scope: nestedScope },
          type,
          seen,
        })) {
          result.add(field);
        }
      }
      if (node.type === "BlockStatement") {
        for (const statement of node.body) {
          visit(statement, nestedScope);
          if (
            statement.type === "ReturnStatement" ||
            statement.type === "ThrowStatement"
          ) {
            break;
          }
        }
        return;
      }
      for (const child of childNodes(node)) {
        visit(child, nestedScope);
      }
    };
    visit(resolved.node.body, scope);
    return result;
  };
  callEnforcement = ({
    value,
    type,
    seen,
  }: EnforcementCallOptions): Set<string> => {
    const result = new Set<string>();
    const imported = this.factoryBinding({
      file: value.file,
      expression: value.node.callee,
      scope: value.scope,
    });
    if (
      imported?.module === OWNER &&
      imported.imported === "enforceWritePrecondition"
    ) {
      const argument = value.node.arguments.at(0);
      const options =
        argument === undefined
          ? new Map<string, LocatedExpression>()
          : this.fields({
              file: value.file,
              node: argument,
              scope: value.scope,
            });
      const field = this.text(options.get("field"));
      if (this.text(options.get("type")) === type && field !== undefined) {
        result.add(field);
      }
      return result;
    }
    // Transaction callbacks run while their decisive lock is held. Other callback
    // consumers require a called write helper rather than an assumed invocation.
    const callbacks =
      memberName(value.node.callee) === "transaction"
        ? value.node.arguments
        : [];
    for (const expression of [value.node.callee, ...callbacks]) {
      for (const field of this.functionEnforcement({
        value: { file: value.file, node: expression, scope: value.scope },
        type,
        seen: new Set(seen),
      })) {
        result.add(field);
      }
    }
    return result;
  };
  config = (handler: string): Map<string, LocatedExpression> => {
    const match = /^(.*\.ts)(?:#(.*))?\.handler$/u.exec(handler);
    const file = match?.[1];
    if (file === undefined) {
      return new Map();
    }
    const reference = { file, name: match?.[2] ?? "default" };
    const exported = this.handlerBinding({ reference, handler });
    if (exported === undefined) {
      return new Map();
    }
    const calls = this.safeCalls({ value: exported, handler });
    if (calls === undefined || calls.length === 0) {
      return new Map();
    }
    this.handlers.set(handler, calls);
    const configs = calls.map(this.callConfig);
    const first = configs.at(0);
    if (first === undefined) {
      return new Map();
    }
    const signature = this.contractSignature(first);
    return configs.every(
      (config) => this.contractSignature(config) === signature,
    )
      ? first
      : new Map();
  };
  callConfig = (safe: SafeCall): Map<string, LocatedExpression> => {
    const argument = safe.node.arguments.at(0);
    if (argument === undefined) {
      return new Map();
    }
    const options = this.fields({
      file: safe.file,
      node: argument,
      scope: safe.scope,
    });
    if (safe.configArgument === "options") {
      const nested = options.get("config");
      return nested === undefined ? new Map() : this.fields(nested);
    }
    return options;
  };
  contractSignature = (config: Map<string, LocatedExpression>) => {
    const value = config.get("precondition");
    const precondition =
      value === undefined
        ? new Map<string, LocatedExpression>()
        : this.fields(value);
    return JSON.stringify({
      contract: this.text(config.get("contract")),
      description: this.text(config.get("description")),
      precondition: [...precondition].map(([name, field]) => [
        name,
        this.text(field) ?? this.strings(field),
      ]),
    });
  };
  strings = (value: LocatedExpression | undefined): string[] | undefined => {
    if (value === undefined) {
      return undefined;
    }
    const resolved = this.resolve(value);
    if (resolved?.node.type !== "ArrayExpression") {
      return undefined;
    }
    const result: string[] = [];
    for (const element of resolved.node.elements) {
      const literal =
        element === null
          ? undefined
          : this.text({
              file: resolved.file,
              node: element,
              scope: resolved.scope,
            });
      if (literal === undefined) {
        return undefined;
      }
      result.push(literal);
    }
    return result;
  };
}

// The expression of `export default <expression>` or `export =
// <expression>`; a default function or class is a declaration.
const defaultExpression = (statement: Node): Node | undefined => {
  if (statement.type === "TSExportAssignment") {
    return statement.expression;
  }
  if (statement.type !== "ExportDefaultDeclaration") {
    return undefined;
  }
  const { declaration } = statement;
  return declaration.type === "FunctionDeclaration" ||
    declaration.type === "ClassDeclaration" ||
    declaration.type === "TSInterfaceDeclaration"
    ? undefined
    : declaration;
};

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

const isShortCircuit = (
  node: Node,
): node is Node & { left: Node; right: Node } =>
  node.type === "LogicalExpression" ||
  (node.type === "AssignmentExpression" &&
    (node.operator === "&&=" ||
      node.operator === "||=" ||
      node.operator === "??="));

// A call the compiler marks as part of an optional chain: optional itself, or
// reached through an optional link of its callee.
const isOptionalChainCall = (node: Node): boolean => {
  if (node.type !== "CallExpression") {
    return false;
  }
  if (node.optional) {
    return true;
  }
  for (let link: Node = node.callee; ;) {
    if (link.type === "MemberExpression") {
      if (link.optional) {
        return true;
      }
      link = link.object;
    } else if (link.type === "CallExpression") {
      if (link.optional) {
        return true;
      }
      link = link.callee;
    } else if (link.type === "TSNonNullExpression") {
      link = link.expression;
    } else {
      return false;
    }
  }
};

const isConditionalExecution = (node: Node): boolean =>
  node.type === "IfStatement" ||
  node.type === "ConditionalExpression" ||
  node.type === "SwitchStatement" ||
  node.type === "ForStatement" ||
  node.type === "ForInStatement" ||
  node.type === "ForOfStatement" ||
  node.type === "WhileStatement" ||
  node.type === "DoWhileStatement" ||
  node.type === "CatchClause" ||
  isOptionalChainCall(node);

const preconditionFields = (type: string | undefined): string[] => {
  switch (type) {
    case "updatedAt":
      return ["type", "field"];
    case "revision":
      return ["type", "fields"];
    case "deferred":
      return ["type", "baselineId"];
    case undefined:
      return [];
    default:
      return [];
  }
};

/** One mutation route the served table mounts, read off the route table. */
export type WriteRoute = {
  method: string;
  /** The path as mounted, prefix included. */
  path: string;
  /**
   * The handler export the route's definition is (`file` for a default
   * export, `file#name` for a named one), when handler discovery found it.
   */
  endpoint: string | undefined;
  /** The contract the safe factory recorded for the definition, if one built it. */
  recorded: unknown;
};

export type WriteRegistration = {
  /** `METHOD /path`. */
  key: string;
  endpoint: string | undefined;
  contract: string | undefined;
  precondition: string | undefined;
  baselineId: string | undefined;
  description: string | undefined;
  violations: string[];
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (
  record: Readonly<Record<string, unknown>> | undefined,
  name: string,
): string | undefined => {
  const value = record?.[name];
  return typeof value === "string" ? value : undefined;
};

const stringsField = (
  record: Readonly<Record<string, unknown>> | undefined,
  name: string,
): string[] | undefined => {
  const value = record?.[name];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: readonly unknown[] = value;
  const strings: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") {
      return undefined;
    }
    strings.push(item);
  }
  return strings;
};

const routeKey = ({ method, path: routePath }: WriteRoute) =>
  `${method} ${routePath}`;

type EnumerateWriteContractsOptions = {
  routes: readonly WriteRoute[];
  /** Contracts declared for routes no safe factory built, by route key. */
  raw: Readonly<Record<string, unknown>>;
  /** Reads repository sources, for the registered revisions and owner enforcement. */
  load: SourceLoader;
};

/**
 * Every served mutation route with the contract it declares: the one its safe
 * factory recorded, or its raw declaration. A replacement's owner enforcement
 * is traced in the source of the handler export the route mounts.
 */
export const enumerateWriteContracts = ({
  routes,
  raw,
  load,
}: EnumerateWriteContractsOptions): WriteRegistration[] => {
  const resolver = new WriteSourceResolver(load);
  const keys = new Set(routes.map(routeKey));
  for (const key of Object.keys(raw)) {
    if (!keys.has(key)) {
      panic(`Stale raw write contract: ${key}`);
    }
  }
  const revisionRegistry = resolver.binding({
    file: OWNER,
    name: "REVISION_PRECONDITIONS",
  });
  const revisions =
    revisionRegistry === undefined
      ? []
      : [...resolver.fields(revisionRegistry).values()].map(resolver.strings);
  return routes.map((route) => {
    const key = routeKey(route);
    const rawValue = raw[key];
    if (rawValue !== undefined && route.recorded !== undefined) {
      panic(`Raw write contract cannot override a safe handler: ${key}`);
    }
    // At most one of the two is declared: a raw override fails above.
    const declared = route.recorded ?? rawValue;
    const config = isRecord(declared) ? declared : undefined;
    const contract = stringField(config, "contract");
    const declaredPrecondition = config?.["precondition"];
    const precondition = isRecord(declaredPrecondition)
      ? declaredPrecondition
      : undefined;
    const violations: string[] = [];
    const type = stringField(precondition, "type");
    const allowedFields = preconditionFields(type);
    if (
      (declaredPrecondition !== undefined && precondition === undefined) ||
      Object.keys(precondition ?? {}).some(
        (field) => !allowedFields.includes(field),
      )
    ) {
      violations.push("Precondition fields must match the declared protocol");
    }
    if (
      type === "updatedAt" &&
      stringField(precondition, "field") !== "expectedUpdatedAt"
    ) {
      violations.push(
        "Timestamp precondition requires field expectedUpdatedAt",
      );
    }
    const revisionFields = stringsField(precondition, "fields");
    if (
      type === "revision" &&
      (revisionFields === undefined ||
        revisionFields.length === 0 ||
        !revisions.some(
          (revision) =>
            revision !== undefined &&
            JSON.stringify(revision) === JSON.stringify(revisionFields),
        ))
    ) {
      violations.push("Revision precondition requires registered fields");
    }
    if (
      contract === "replace" &&
      (type === "updatedAt" || type === "revision")
    ) {
      const required =
        type === "updatedAt"
          ? [stringField(precondition, "field")]
          : (revisionFields ?? []);
      if (route.endpoint === undefined) {
        violations.push(
          "Replacement must be an exported handler endpoint so its owner enforcement can be traced",
        );
      } else {
        const handler = `${route.endpoint}.handler`;
        resolver.config(handler);
        const enforced = resolver.enforcementFields(handler, type);
        for (const field of required) {
          if (field !== undefined && !enforced.has(field)) {
            violations.push(
              `Replacement must reach owner enforcement for ${field}`,
            );
          }
        }
      }
    }
    if (contract === "patch" && declaredPrecondition !== undefined) {
      violations.push("Patch contract cannot declare a precondition");
    }
    return {
      key,
      endpoint: route.endpoint,
      violations,
      contract,
      precondition: type,
      baselineId: stringField(precondition, "baselineId"),
      description: stringField(config, "description"),
    };
  });
};

const readWriteContractDebtIds = (load: SourceLoader): string[] => {
  const resolver = new WriteSourceResolver(load);
  const declaration = resolver.binding({
    file: OWNER,
    name: "REPLACE_CONTRACT_DEBT_IDS",
  });
  if (declaration?.node.type !== "ArrayExpression") {
    panic("Write contract debt IDs require a literal array");
  }
  return declaration.node.elements.map((element) => {
    const value =
      element === null
        ? undefined
        : resolver.text({ file: declaration.file, node: element });
    if (value === undefined) {
      panic("Write contract debt IDs require literal strings");
    }
    return value;
  });
};

type CheckWriteContractsOptions = {
  registrations: readonly WriteRegistration[];
  baseline: WriteContractBaseline;
  /** The base revision's baseline; undefined when this change introduces it. */
  previous: WriteContractBaseline | undefined;
  debtIds?: readonly string[] | undefined;
};
const writeRouteErrors = (route: WriteRegistration): string[] => {
  const errors = route.violations.map(
    (violation) => `${violation}: ${route.key}`,
  );
  if (route.contract !== "patch" && route.contract !== "replace") {
    errors.push(`Missing write contract: ${route.key}`);
  }
  if (
    /^Replace\b/iu.test(route.description?.trimStart() ?? "") &&
    route.contract !== "replace"
  ) {
    errors.push(`Replace description requires replace contract: ${route.key}`);
  }
  if (route.contract !== "replace") {
    return errors;
  }
  if (
    !["updatedAt", "revision", "deferred"].includes(route.precondition ?? "")
  ) {
    errors.push(`Replace route requires precondition: ${route.key}`);
  }
  if (route.precondition !== "deferred") {
    return errors;
  }
  // A deferred replacement is bound to its handler export, or to its route
  // when no exported handler backs it.
  if (route.baselineId !== (route.endpoint ?? route.key)) {
    errors.push(`Misbound deferred baseline ID: ${route.key}`);
  }
  return errors;
};

type WriteDebtOptions = Pick<
  CheckWriteContractsOptions,
  "baseline" | "debtIds"
>;
const writeDebtErrors = ({ baseline, debtIds }: WriteDebtOptions): string[] => {
  const errors: string[] = [];
  if (debtIds === undefined) {
    return errors;
  }
  const expectedIds = new Set(baseline.map((row) => row.baselineId));
  const declaredIds = new Set(debtIds);
  if (declaredIds.size !== debtIds.length) {
    errors.push("Duplicate write contract debt ID");
  }
  for (const id of declaredIds) {
    if (!expectedIds.has(id)) {
      errors.push(`Orphan write contract debt ID: ${id}`);
    }
  }
  for (const id of expectedIds) {
    if (!declaredIds.has(id)) {
      errors.push(`Missing write contract debt ID: ${id}`);
    }
  }
  return errors;
};

const collectDeferredRegistrations = (
  registrations: readonly WriteRegistration[],
) => {
  const counts = new Map<string, number>();
  const deferred = new Map<string, WriteRegistration>();
  for (const route of registrations) {
    if (route.contract !== "replace" || route.precondition !== "deferred") {
      continue;
    }
    counts.set(route.key, (counts.get(route.key) ?? 0) + 1);
    deferred.set(route.key, route);
  }
  return { counts, deferred };
};

/** The one reason a generated deferral row carries. */
export const DEFERRED_REPLACEMENT_REASON =
  "Existing replacement awaits required schema precondition and caller enrollment.";

/** The deferral rows the served routes need, as `--generate` writes them. */
export const writeContractBaseline = (
  registrations: readonly WriteRegistration[],
): WriteContractBaseline => {
  const { counts, deferred } = collectDeferredRegistrations(registrations);
  return [...deferred]
    .map(([key, route]) => ({
      key,
      count: counts.get(key) ?? 0,
      reason: DEFERRED_REPLACEMENT_REASON,
      baselineId: route.baselineId ?? "",
    }))
    .toSorted((left, right) => compareCodeUnit(left.key, right.key));
};

type WriteBaselineOptions = Pick<
  CheckWriteContractsOptions,
  "baseline" | "previous" | "registrations"
> &
  ReturnType<typeof collectDeferredRegistrations>;
const writeBaselineErrors = ({
  baseline,
  previous,
  registrations,
  counts,
  deferred,
}: WriteBaselineOptions): string[] => {
  const errors: string[] = [];
  // On introduction the rows must be exactly the generated ones: no
  // hand-written reason, and every count and id as the routes need them.
  const previousRows = new Map(
    (previous ?? writeContractBaseline(registrations)).map((row) => [
      row.key,
      row,
    ]),
  );
  const seen = new Set<string>();
  for (const row of baseline) {
    if (seen.has(row.key)) {
      errors.push(`Duplicate write baseline key: ${row.key}`);
    }
    seen.add(row.key);
    if (row.reason.trim() === "") {
      errors.push(`Missing write baseline reason: ${row.key}`);
    }
    if (row.count !== counts.get(row.key)) {
      errors.push(`Stale write baseline count: ${row.key}`);
    }
    if (row.baselineId !== deferred.get(row.key)?.baselineId) {
      errors.push(`Misbound write baseline ID: ${row.key}`);
    }
    const old = previousRows.get(row.key);
    if (
      old === undefined ||
      row.count > old.count ||
      row.reason !== old.reason ||
      row.baselineId !== old.baselineId
    ) {
      errors.push(`Write baseline may only shrink: ${row.key}`);
    }
  }
  for (const key of deferred.keys()) {
    if (!seen.has(key)) {
      errors.push(`Unbaselined deferred replace route: ${key}`);
    }
  }
  return errors;
};

export const checkWriteContracts = ({
  registrations,
  baseline,
  previous,
  debtIds,
}: CheckWriteContractsOptions): string[] => {
  const errors = registrations.flatMap(writeRouteErrors);
  const { counts, deferred } = collectDeferredRegistrations(registrations);
  errors.push(...writeDebtErrors({ baseline, debtIds }));
  errors.push(
    ...writeBaselineErrors({
      baseline,
      previous,
      registrations,
      counts,
      deferred,
    }),
  );
  return errors;
};

// --- CLI ------------------------------------------------------------------------

const MUTATION_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/**
 * The served mutation routes. Handler discovery seeds the API env defaults the
 * route modules read at load, so the route table is imported after it.
 */
const servedWriteRoutes = async (): Promise<WriteRoute[]> => {
  const { discoverSafeHandlers } =
    await import("../apps/api/scripts/lib/enumerate-safe-handlers");
  const discovery = await discoverSafeHandlers();
  if (discovery.importErrors.length > 0) {
    return panic(
      `Handler modules failed to import, so write routes cannot be traced: ${discovery.importErrors.map(({ id, message }) => `${id}: ${message}`).join("; ")}`,
    );
  }
  const endpointByDefinition = new Map<object, string>(
    discovery.endpoints.map((endpoint) => [endpoint.definition, endpoint.id]),
  );
  const { apiRoutes } = await import("../apps/api/src/api-routes");
  const { getWriteContract } =
    await import("../apps/api/src/lib/write-contract/write-contract");
  return apiRoutes
    .filter((entry) => MUTATION_METHODS.has(entry.method))
    .map((entry) => {
      const handler =
        "handler" in entry.definition ? entry.definition.handler : undefined;
      return {
        method: entry.method,
        path: entry.path,
        endpoint: endpointByDefinition.get(entry.definition),
        recorded:
          typeof handler === "function" ? getWriteContract(handler) : undefined,
      };
    });
};

const comparisonCommit = () => {
  const requested =
    process.env["BASE_SHA"] ?? process.env["BASE_REF"] ?? "origin/main";
  const reference = spawnSync(
    "git",
    ["rev-parse", "--verify", `${requested}^{commit}`],
    { maxBuffer: 2 ** 30, cwd: ROOT, encoding: "utf-8" },
  );
  if (reference.status !== 0) {
    panic(`Write contract comparison ref unavailable: ${requested}`);
  }
  const comparison =
    process.env["BASE_SHA"] !== undefined
      ? reference
      : spawnSync("git", ["merge-base", "HEAD", reference.stdout.trim()], {
          maxBuffer: 2 ** 30,
          cwd: ROOT,
          encoding: "utf-8",
        });
  if (comparison.status !== 0) {
    panic("Write contract merge-base unavailable");
  }
  return comparison.stdout.trim();
};

if (import.meta.main) {
  const commit = comparisonCommit();
  const load: SourceLoader = (file) =>
    existsSync(path.join(ROOT, file))
      ? readFileSync(path.join(ROOT, file), "utf-8")
      : undefined;
  const previousSource = spawnSync("git", ["show", `${commit}:${BASELINE}`], {
    maxBuffer: 2 ** 30,
    cwd: ROOT,
    encoding: "utf-8",
  });
  const previous =
    previousSource.status === 0
      ? v.parse(writeContractBaselineSchema, JSON.parse(previousSource.stdout))
      : undefined;
  const registrations = enumerateWriteContracts({
    routes: await servedWriteRoutes(),
    raw: Object.fromEntries(RAW_WRITE_CONTRACTS),
    load,
  });
  if (process.argv.includes("--generate")) {
    if (previous !== undefined) {
      panic(
        "The write contract baseline is shrink-only; generation is initial-only",
      );
    }
    writeFileSync(
      path.join(ROOT, BASELINE),
      `${JSON.stringify(writeContractBaseline(registrations), null, 2)}\n`,
    );
  } else {
    const baseline = v.parse(
      writeContractBaselineSchema,
      JSON.parse(readFileSync(path.join(ROOT, BASELINE), "utf-8")),
    );
    const errors = checkWriteContracts({
      registrations,
      baseline,
      previous,
      debtIds: readWriteContractDebtIds(load),
    });
    for (const error of errors) {
      process.stderr.write(`${error}\n`);
    }
    process.stdout.write(
      `Write contracts: ${registrations.length} surfaces, ${baseline.length} deferred entries\n`,
    );
    if (errors.length !== 0) {
      process.exitCode = 1;
    }
  }
  // The route table's modules open Redis clients at import (the rate
  // limiter connects at construction so a server's first requests reach it)
  // and never unref them, so this one-off script's event loop would hang.
  // The work is done here; exit explicitly like export-capability-catalog.ts.
  process.exit();
}
