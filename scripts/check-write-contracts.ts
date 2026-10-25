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
import ts from "typescript6";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

import { SAFE_HANDLER_FACTORIES } from "../apps/api/src/lib/safe-handler-factories";
import { RAW_WRITE_CONTRACTS } from "../apps/api/src/lib/write-contract";
import { BASELINE_PATHS } from "./baseline-paths";

const ROOT = path.resolve(import.meta.dir, "..");
const OWNER = "apps/api/src/lib/write-contract.ts";
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
type LexicalScope = ReadonlyMap<string, ts.Expression | undefined>;
type LocatedExpression = {
  file: string;
  node: ts.Expression;
  scope?: LexicalScope | undefined;
};

const unwrap = (node: ts.Expression): ts.Expression => {
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    return unwrap(node.expression);
  }
  return node;
};
/** Recognize only a returned value or an immediate conflict early return. */
const propagatesConflict = (call: ts.CallExpression): boolean => {
  let expression: ts.Node = call;
  while (
    ts.isAwaitExpression(expression.parent) ||
    ts.isParenthesizedExpression(expression.parent) ||
    ts.isAsExpression(expression.parent) ||
    ts.isSatisfiesExpression(expression.parent)
  ) {
    expression = expression.parent;
  }
  const parent = expression.parent;
  if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) {
    return true;
  }
  if (
    !ts.isVariableDeclaration(parent) ||
    !ts.isIdentifier(parent.name) ||
    !ts.isVariableDeclarationList(parent.parent) ||
    !isConstDeclarationList(parent.parent) ||
    parent.parent.declarations.length !== 1 ||
    !ts.isVariableStatement(parent.parent.parent)
  ) {
    return false;
  }
  const statement = parent.parent.parent;
  const block = statement.parent;
  if (!ts.isBlock(block)) {
    return false;
  }
  const next = block.statements.at(block.statements.indexOf(statement) + 1);
  const name = parent.name.text;
  const returnsConflict = (node: ts.Statement): boolean => {
    if (ts.isBlock(node)) {
      const only = node.statements.at(0);
      return (
        node.statements.length === 1 &&
        only !== undefined &&
        returnsConflict(only)
      );
    }
    return (
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      ts.isIdentifier(unwrap(node.expression)) &&
      unwrap(node.expression).getText() === name
    );
  };
  if (next === undefined) {
    return false;
  }
  if (ts.isReturnStatement(next)) {
    return returnsConflict(next);
  }
  if (!ts.isIfStatement(next) || next.elseStatement !== undefined) {
    return false;
  }
  const condition = unwrap(next.expression);
  const nonNull =
    (ts.isIdentifier(condition) && condition.text === name) ||
    (ts.isBinaryExpression(condition) &&
      (condition.operatorToken.kind ===
        ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        condition.operatorToken.kind ===
          ts.SyntaxKind.ExclamationEqualsToken) &&
      ((ts.isIdentifier(condition.left) &&
        condition.left.text === name &&
        condition.right.kind === ts.SyntaxKind.NullKeyword) ||
        (ts.isIdentifier(condition.right) &&
          condition.right.text === name &&
          condition.left.kind === ts.SyntaxKind.NullKeyword)));
  return nonNull && returnsConflict(next.thenStatement);
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

const isConstDeclarationList = (node: ts.VariableDeclarationList) =>
  node.getFirstToken()?.kind === ts.SyntaxKind.ConstKeyword;

type BindingReference = { file: string; name: string };
type BindingReferenceOptions = BindingReference & { statement: ts.Statement };
type BindingOptions = { file: string; name: string; visited?: Set<string> };
type FactoryBindingOptions = {
  file: string;
  expression: ts.Expression;
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
  value: LocatedExpression & { node: ts.CallExpression };
};
type SafeCall = LocatedExpression & {
  node: ts.CallExpression;
  configArgument: (typeof SAFE_HANDLER_FACTORIES)[keyof typeof SAFE_HANDLER_FACTORIES]["configArgument"];
};

const bindingNames = (name: ts.BindingName): string[] => {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : [],
  );
};

const wrapperScope = ({ node, scope }: LocatedExpression): LexicalScope => {
  const bindings = new Map(scope);
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) {
    return bindings;
  }
  for (const parameter of node.parameters) {
    for (const name of bindingNames(parameter.name)) {
      bindings.set(name, undefined);
    }
  }
  if (!ts.isBlock(node.body)) {
    return bindings;
  }
  return blockScope(node.body, bindings);
};

const blockScope = (block: ts.Block, parent: LexicalScope): LexicalScope => {
  const bindings = new Map(parent);
  for (const statement of block.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      bindings.set(statement.name.text, undefined);
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      const initializer =
        ts.isIdentifier(declaration.name) &&
        isConstDeclarationList(statement.declarationList)
          ? declaration.initializer
          : undefined;
      for (const name of bindingNames(declaration.name)) {
        bindings.set(name, initializer);
      }
    }
  }
  return bindings;
};

const wrapperReturn = (
  wrapper: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | undefined => {
  if (
    wrapper.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ) ||
    (ts.isFunctionExpression(wrapper) && wrapper.asteriskToken !== undefined)
  ) {
    return undefined;
  }
  if (!ts.isBlock(wrapper.body)) {
    return wrapper.body;
  }
  const direct = wrapper.body.statements.filter(ts.isReturnStatement);
  if (direct.length !== 1) {
    return undefined;
  }
  let returns = 0;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isReturnStatement(node)) {
      returns += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(wrapper.body);
  return returns === 1 ? direct.at(0)?.expression : undefined;
};

type FactoryImportOptions = {
  file: string;
  node: ts.Identifier | ts.PropertyAccessExpression;
  name: string;
  statement: ts.Statement;
};
const factoryImport = ({
  file,
  node,
  name,
  statement,
}: FactoryImportOptions) => {
  if (
    !ts.isImportDeclaration(statement) ||
    !ts.isStringLiteral(statement.moduleSpecifier)
  ) {
    return undefined;
  }
  const target = modulePath(file, statement.moduleSpecifier.text);
  const imports = statement.importClause?.namedBindings;
  if (
    target === undefined ||
    imports === undefined ||
    statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
  ) {
    return undefined;
  }
  if (ts.isNamedImports(imports) && ts.isIdentifier(node)) {
    const found = imports.elements.find(
      (item) => item.name.text === name && !item.isTypeOnly,
    );
    if (found !== undefined) {
      return {
        module: target,
        imported: found.propertyName?.text ?? found.name.text,
      };
    }
  }
  if (
    ts.isNamespaceImport(imports) &&
    imports.name.text === name &&
    ts.isPropertyAccessExpression(node)
  ) {
    return { module: target, imported: node.name.text };
  }
  return undefined;
};

class WriteSourceResolver {
  private readonly load: SourceLoader;
  constructor(load: SourceLoader) {
    this.load = load;
  }
  private readonly sources = new Map<string, ts.SourceFile>();
  source = (file: string) => {
    const cached = this.sources.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const content = this.load(file);
    if (content === undefined) {
      return undefined;
    }
    const parsed = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    this.sources.set(file, parsed);
    return parsed;
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
    for (const statement of parsed.statements) {
      if (name === "default" && ts.isExportAssignment(statement)) {
        return this.resolve({ file, node: statement.expression }, visited);
      }
      if (
        ts.isVariableStatement(statement) &&
        isConstDeclarationList(statement.declarationList)
      ) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name &&
            declaration.initializer !== undefined
          ) {
            return this.resolve(
              { file, node: declaration.initializer },
              visited,
            );
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
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const clause = statement.importClause;
      const target = modulePath(file, statement.moduleSpecifier.text);
      if (target === undefined || clause === undefined) {
        return undefined;
      }
      if (clause.name?.text === name) {
        return { file: target, name: "default" };
      }
      if (
        clause.namedBindings === undefined ||
        !ts.isNamedImports(clause.namedBindings)
      ) {
        return undefined;
      }
      const found = clause.namedBindings.elements.find(
        (item) => item.name.text === name,
      );
      return found === undefined
        ? undefined
        : { file: target, name: found.propertyName?.text ?? found.name.text };
    }
    if (
      !ts.isExportDeclaration(statement) ||
      statement.exportClause === undefined ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      return undefined;
    }
    const found = statement.exportClause.elements.find(
      (item) => item.name.text === name,
    );
    if (found === undefined) {
      return undefined;
    }
    const target =
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
        ? modulePath(file, statement.moduleSpecifier.text)
        : file;
    return target === undefined
      ? undefined
      : { file: target, name: found.propertyName?.text ?? found.name.text };
  };
  resolve = (
    { file, node, scope }: LocatedExpression,
    visited = new Set<string>(),
  ): LocatedExpression | undefined => {
    const value = unwrap(node);
    if (ts.isIdentifier(value)) {
      if (scope?.has(value.text)) {
        const initializer = scope.get(value.text);
        if (initializer === undefined) {
          return undefined;
        }
        const key = `${file}#local:${value.text}:${initializer.pos}`;
        if (visited.has(key)) {
          return undefined;
        }
        visited.add(key);
        return this.resolve({ file, node: initializer, scope }, visited);
      }
      return this.binding({ file, name: value.text, visited });
    }
    if (ts.isPropertyAccessExpression(value)) {
      const property = this.fields({ file, node: value.expression, scope }).get(
        value.name.text,
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
    if (
      resolved === undefined ||
      !ts.isObjectLiteralExpression(resolved.node)
    ) {
      return result;
    }
    const identity = `${resolved.file}:${resolved.node.pos}`;
    if (visited.has(identity)) {
      return result;
    }
    visited.add(identity);
    for (const property of resolved.node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = this.resolve({
          file: resolved.file,
          node: property.expression,
          scope: resolved.scope,
        });
        if (
          spread === undefined ||
          !ts.isObjectLiteralExpression(spread.node)
        ) {
          // An opaque later spread may overwrite every preceding declaration.
          result.clear();
          continue;
        }
        for (const [name, item] of this.fields(spread, new Set(visited))) {
          result.set(name, item);
        }
      } else if (ts.isPropertyAssignment(property)) {
        const name =
          ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
            ? property.name.text
            : undefined;
        if (name === undefined) {
          result.clear();
        } else {
          result.set(name, {
            file: resolved.file,
            node: property.initializer,
            scope: resolved.scope,
          });
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        result.set(property.name.text, {
          file: resolved.file,
          node: property.name,
          scope: resolved.scope,
        });
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
    if (
      ts.isStringLiteral(resolved.node) ||
      ts.isNoSubstitutionTemplateLiteral(resolved.node)
    ) {
      return resolved.node.text;
    }
    if (
      ts.isBinaryExpression(resolved.node) &&
      resolved.node.operatorToken.kind === ts.SyntaxKind.PlusToken
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
    if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) {
      return undefined;
    }
    let name: string | undefined;
    if (ts.isIdentifier(node)) {
      name = node.text;
    } else if (ts.isIdentifier(node.expression)) {
      name = node.expression.text;
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
    for (const statement of this.source(file)?.statements ?? []) {
      const imported = factoryImport({ file, node, name, statement });
      if (imported !== undefined) {
        return imported;
      }
      if (ts.isVariableStatement(statement) && ts.isIdentifier(node)) {
        const found = statement.declarationList.declarations.find(
          (item) => ts.isIdentifier(item.name) && item.name.text === name,
        );
        if (found?.initializer !== undefined) {
          return this.factoryBinding({
            file,
            expression: found.initializer,
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
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        ts.isVariableDeclarationList(node.parent)
      ) {
        const wrapper = ts.findAncestor(
          node,
          (ancestor) =>
            ts.isArrowFunction(ancestor) || ts.isFunctionExpression(ancestor),
        );
        if (
          wrapper !== undefined &&
          (ts.isArrowFunction(wrapper) || ts.isFunctionExpression(wrapper)) &&
          ts.isBlock(wrapper.body) &&
          node.parent.parent.parent === wrapper.body
        ) {
          candidates.push({
            file,
            node: node.name,
            scope: wrapperScope({ file, node: wrapper }),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    const source = this.source(file);
    if (source !== undefined) {
      visit(source);
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
    if (ts.isConditionalExpression(resolved.node)) {
      const left = this.safeCalls({
        value: {
          file: resolved.file,
          node: resolved.node.whenTrue,
          scope: resolved.scope,
        },
        seen: new Set(seen),
        handler,
      });
      const right = this.safeCalls({
        value: {
          file: resolved.file,
          node: resolved.node.whenFalse,
          scope: resolved.scope,
        },
        seen: new Set(seen),
        handler,
      });
      return left === undefined || right === undefined
        ? undefined
        : left.concat(right);
    }
    if (!ts.isCallExpression(resolved.node)) {
      return undefined;
    }
    const imported = this.factoryBinding({
      file: resolved.file,
      expression: resolved.node.expression,
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
      node: resolved.node.expression,
      scope: resolved.scope,
    });
    if (
      wrapper === undefined ||
      (!ts.isArrowFunction(wrapper.node) &&
        !ts.isFunctionExpression(wrapper.node))
    ) {
      return undefined;
    }
    const key = `${wrapper.file}:${wrapper.node.pos}`;
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
      (!ts.isArrowFunction(resolved.node) &&
        !ts.isFunctionExpression(resolved.node))
    ) {
      return result;
    }
    const key = `${resolved.file}:${resolved.node.pos}`;
    if (seen.has(key)) {
      return result;
    }
    seen.add(key);
    const scope = wrapperScope(resolved);
    const visit = (node: ts.Node, currentScope: LexicalScope) => {
      // Only unconditional, propagated comparisons count: a branch, loop, catch, short
      // circuit or optional call may skip the comparison on some write path.
      if (ts.isFunctionLike(node) || isConditionalExecution(node)) {
        return;
      }
      if (
        ts.isBinaryExpression(node) &&
        isShortCircuit(node.operatorToken.kind)
      ) {
        visit(node.left, currentScope);
        return;
      }
      // A catch can swallow a failure, and a finally can override a return.
      // Only propagation from the finally block survives either boundary.
      if (
        ts.isTryStatement(node) &&
        (node.catchClause !== undefined || node.finallyBlock !== undefined)
      ) {
        if (node.finallyBlock !== undefined) {
          visit(node.finallyBlock, currentScope);
        }
        return;
      }
      const nestedScope = ts.isBlock(node)
        ? blockScope(node, currentScope)
        : currentScope;
      if (ts.isCallExpression(node) && propagatesConflict(node)) {
        for (const field of this.callEnforcement({
          value: { file: resolved.file, node, scope: nestedScope },
          type,
          seen,
        })) {
          result.add(field);
        }
      }
      if (ts.isBlock(node)) {
        for (const statement of node.statements) {
          visit(statement, nestedScope);
          if (
            ts.isReturnStatement(statement) ||
            ts.isThrowStatement(statement)
          ) {
            break;
          }
        }
        return;
      }
      ts.forEachChild(node, (child) => visit(child, nestedScope));
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
      expression: value.node.expression,
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
      ts.isPropertyAccessExpression(value.node.expression) &&
      value.node.expression.name.text === "transaction"
        ? value.node.arguments
        : [];
    for (const expression of [value.node.expression, ...callbacks]) {
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
    if (resolved === undefined || !ts.isArrayLiteralExpression(resolved.node)) {
      return undefined;
    }
    const result: string[] = [];
    for (const element of resolved.node.elements) {
      const literal = this.text({
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

const isShortCircuit = (kind: ts.SyntaxKind): boolean =>
  kind === ts.SyntaxKind.AmpersandAmpersandToken ||
  kind === ts.SyntaxKind.BarBarToken ||
  kind === ts.SyntaxKind.QuestionQuestionToken ||
  kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
  kind === ts.SyntaxKind.BarBarEqualsToken ||
  kind === ts.SyntaxKind.QuestionQuestionEqualsToken;

const isConditionalExecution = (node: ts.Node): boolean =>
  ts.isIfStatement(node) ||
  ts.isConditionalExpression(node) ||
  ts.isSwitchStatement(node) ||
  ts.isIterationStatement(node, false) ||
  ts.isCatchClause(node) ||
  (ts.isCallExpression(node) && ts.isOptionalChain(node));

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
  if (
    declaration === undefined ||
    !ts.isArrayLiteralExpression(declaration.node)
  ) {
    panic("Write contract debt IDs require a literal array");
  }
  return declaration.node.elements.map((element) => {
    const value = resolver.text({ file: declaration.file, node: element });
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
    await import("../apps/api/src/lib/write-contract");
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
    { cwd: ROOT, encoding: "utf-8" },
  );
  if (reference.status !== 0) {
    panic(`Write contract comparison ref unavailable: ${requested}`);
  }
  const comparison =
    process.env["BASE_SHA"] !== undefined
      ? reference
      : spawnSync("git", ["merge-base", "HEAD", reference.stdout.trim()], {
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
