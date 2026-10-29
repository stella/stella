import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  type ArrowFunctionExpression,
  type BindingPattern,
  type BindingRestElement,
  type CallExpression,
  type Expression as OxcExpression,
  type FormalParameterRest,
  type Function as FunctionNode,
  type MemberExpression,
  type Node,
  type ObjectExpression,
  type ObjectProperty as Property,
  parseSource,
  type SpreadElement,
  type Statement,
  type TSParameterProperty,
  walk,
} from "../packages/scripts/src/syntax-tree";
import { BASELINE_PATHS } from "./baseline-paths.ts";
import { runLedgerMembershipGuard } from "./ledger-membership.ts";

type Expression = OxcExpression | SpreadElement;

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const LEDGER_REL = BASELINE_PATHS.transferRead;
const BOUNDED_OWNER = "apps/api/src/lib/db/read-bounded.ts";

type FindingKind =
  | "numeric-timeout"
  | "total-timeout-body"
  | "constant-limit"
  | "fixed-page-size";
export type ReadFinding = {
  file: string;
  function: string;
  kind: FindingKind;
  line: number;
};
type BaselineEntry = {
  file: string;
  function: string;
  kind: FindingKind;
  count: number;
  reason: string;
};

/** Conservative syntax census: JSON/text may also carry user-sized content.
 * Existing bounded metadata and paginated reads retain explicit baseline reasons. */
type ImportedCallOptions = {
  call: CallExpression;
  module: string;
  name: string;
};

type SentinelBoundaryOptions = {
  cap: Expression;
  boundary: Expression;
};

type CursorPageConsumptionOptions = {
  following: Statement;
  rest: readonly Statement[];
  rowName: string;
  cap: Expression;
};

type OverflowExitOptions = {
  following: Statement;
  rowName: string;
  cap: Expression;
};

type PaginationReferenceOptions = {
  node: Node;
  inputs: ReadonlySet<string>;
  depth?: number;
};

type LimitDispositionOptions = {
  node: CallExpression;
  cap: Expression;
  root: Node;
};

const PAGINATION_INPUT =
  /^(?:cursor|page|offset|pageIndex|pageNumber|after|before)$/u;
class TransferReadInspector {
  readonly parsed;
  readonly parents = new Map<Node, Node>();
  readonly file: string;
  readonly source: string;
  constructor({ file, source }: { file: string; source: string }) {
    this.file = file;
    this.source = source;
    this.parsed = parseSource(file, source);
    walk(this.parsed.program, (node, ancestors) => {
      const parent = ancestors.at(-1);
      if (parent !== undefined) {
        this.parents.set(node, parent);
      }
    });
  }
  readonly parentOf = (node: Node): Node =>
    this.parents.get(node) ?? panic("Missing syntax parent");
  readonly textOf = (node: Node): string =>
    node.type === "Identifier"
      ? node.name
      : this.source.slice(node.start, node.end);
  readonly ancestorOf = (
    node: Node,
    predicate: (node: Node) => boolean,
  ): Node | undefined => {
    for (
      let current: Node | undefined = node;
      current !== undefined;
      current = this.parents.get(current)
    ) {
      if (predicate(current)) {
        return current;
      }
    }
    return undefined;
  };
  readonly unwrap = (node: Expression): Expression => {
    let value = node;
    while (
      value.type === "ParenthesizedExpression" ||
      value.type === "TSAsExpression" ||
      value.type === "TSSatisfiesExpression" ||
      value.type === "TSNonNullExpression" ||
      value.type === "TSTypeAssertion"
    ) {
      value = value.expression;
    }
    return value;
  };

  readonly propertyName = (node: Node): string | undefined => {
    if (node.type === "Identifier") {
      return node.name;
    }
    if (
      node.type === "Literal" &&
      (typeof node.value === "string" || typeof node.value === "number")
    ) {
      return String(node.value);
    }
    return undefined;
  };
  readonly propertyKey = (property: Property): string | undefined => {
    if (!property.computed) {
      return this.propertyName(property.key);
    }
    if (property.key.type === "PrivateIdentifier") {
      return undefined;
    }
    const key = this.unwrap(property.key);
    return key.type === "Literal" && typeof key.value === "string"
      ? key.value
      : undefined;
  };
  readonly memberName = (member: MemberExpression): string | undefined => {
    if (!member.computed) {
      return this.propertyName(member.property);
    }
    return member.property.type === "Literal" &&
      typeof member.property.value === "string"
      ? member.property.value
      : undefined;
  };
  readonly callName = (node: Expression): string | undefined => {
    const value = this.unwrap(node);
    if (value.type === "Identifier") {
      return value.name;
    }
    if (value.type === "MemberExpression") {
      return this.memberName(value);
    }
    return undefined;
  };
  readonly isFunction = (
    node: Node,
  ): node is FunctionNode | ArrowFunctionExpression =>
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression";
  readonly bindingNames = (
    name:
      | BindingPattern
      | BindingRestElement
      | FormalParameterRest
      | TSParameterProperty,
  ): string[] => {
    if (name.type === "TSParameterProperty") {
      return this.bindingNames(name.parameter);
    }
    if (name.type === "Identifier") {
      return [name.name];
    }
    if (name.type === "AssignmentPattern") {
      return this.bindingNames(name.left);
    }
    if (name.type === "RestElement") {
      return this.bindingNames(name.argument);
    }
    if (name.type === "ArrayPattern") {
      return name.elements.flatMap((element) =>
        element === null ? [] : this.bindingNames(element),
      );
    }
    return name.properties.flatMap((element) =>
      this.bindingNames(
        element.type === "RestElement" ? element.argument : element.value,
      ),
    );
  };
  /**
   * Finds a `name` variable declared directly in a block or this.source file. The
   * wrapper distinguishes "declared without a const initializer" from "absent".
   */
  readonly declarationIn = (
    scope: Node,
    name: string,
  ): { initializer: Expression | undefined } | undefined => {
    if (scope.type !== "BlockStatement" && scope.type !== "Program") {
      return undefined;
    }
    for (let statement of scope.body) {
      if (
        statement.type === "ExportNamedDeclaration" &&
        statement.declaration !== null
      ) {
        statement = statement.declaration;
      }
      if (statement.type !== "VariableDeclaration") {
        continue;
      }
      for (const declaration of statement.declarations) {
        if (
          declaration.id.type === "Identifier" &&
          declaration.id.name === name
        ) {
          return {
            initializer:
              statement.kind === "const"
                ? (declaration.init ?? undefined)
                : undefined,
          };
        }
      }
    }
    return undefined;
  };

  readonly bindingOf = (from: Node, name: string): Expression | undefined => {
    let scope = this.parentOf(from);
    while (scope.type !== "Program") {
      if (
        this.isFunction(scope) &&
        scope.params.some((parameter) =>
          this.bindingNames(parameter).includes(name),
        )
      ) {
        return undefined;
      }
      const declared = this.declarationIn(scope, name);
      if (declared !== undefined) {
        return declared.initializer;
      }
      scope = this.parentOf(scope);
    }
    return this.declarationIn(scope, name)?.initializer;
  };

  readonly resolve = (node: Expression, depth = 0): Expression => {
    const value = this.unwrap(node);
    if (value.type !== "Identifier" || depth >= 8) {
      return value;
    }
    const bound = this.bindingOf(value, value.name);
    return bound === undefined ? value : this.resolve(bound, depth + 1);
  };

  readonly timeoutProperties = (node: Expression, depth = 0): Node[] => {
    if (depth >= 8) {
      return [];
    }
    const value = this.resolve(node);
    if (value.type !== "ObjectExpression") {
      return [];
    }
    const hasExplicitPolicy = value.properties.some(
      (property) =>
        property.type === "Property" &&
        this.propertyKey(property) === "timeout",
    );
    const found: Node[] = [];
    for (const property of value.properties) {
      if (property.type === "SpreadElement") {
        found.push(...this.timeoutProperties(property.argument, depth + 1));
      } else if (
        ((!property.shorthand &&
          !property.method &&
          property.kind === "init") ||
          property.shorthand) &&
        this.propertyKey(property) === "timeoutMs" &&
        !hasExplicitPolicy
      ) {
        found.push(property);
      }
    }
    return found;
  };

  // Callback identities follow their enclosing declaration and call position,
  // rather than this.source locations, so moving code does not reset the budget.
  readonly scopeName = (
    node: FunctionNode | ArrowFunctionExpression,
  ): string => {
    if (node.type !== "ArrowFunctionExpression" && node.id !== null) {
      return this.textOf(node.id);
    }
    const method = this.parentOf(node);
    if (
      method.type === "MethodDefinition" ||
      (method.type === "Property" && method.method)
    ) {
      return this.textOf(method.key);
    }
    let parent = this.parentOf(node);
    while (
      parent.type === "ParenthesizedExpression" ||
      parent.type === "TSAsExpression" ||
      parent.type === "TSSatisfiesExpression"
    ) {
      parent = this.parentOf(parent);
    }
    if (parent.type === "VariableDeclarator") {
      return this.textOf(parent.id);
    }
    if (parent.type === "Property") {
      return this.textOf(parent.key);
    }
    if (parent.type === "CallExpression") {
      const index = parent.arguments.findIndex(
        (argument) =>
          argument === node ||
          (argument.type !== "SpreadElement" && this.unwrap(argument) === node),
      );
      const declaration = this.ancestorOf(
        parent,
        (ancestor) =>
          ancestor.type === "VariableDeclarator" || this.isFunction(ancestor),
      );
      const prefix =
        declaration?.type === "VariableDeclarator"
          ? `${this.textOf(declaration.id)}/`
          : "";
      return `${prefix}${this.callName(parent.callee) ?? "call"}[${index}]`;
    }
    return "callback";
  };

  readonly isConstant = (node: Expression, depth = 0): boolean => {
    if (depth >= 8) {
      return true;
    }
    const value = this.resolve(node);
    if (value.type === "Literal" && typeof value.value === "number") {
      return true;
    }
    if (value.type === "Identifier") {
      return /^[A-Z][A-Z_\d]*$/u.test(value.name);
    }
    if (value.type === "MemberExpression") {
      const root = value.object;
      return root.type === "Identifier" && /^[A-Z][A-Z_\d]*$/u.test(root.name);
    }
    if (value.type === "BinaryExpression") {
      // `#field in object` tests a private name, never a constant.
      return (
        value.left.type !== "PrivateIdentifier" &&
        this.isConstant(value.left, depth + 1) &&
        this.isConstant(value.right, depth + 1)
      );
    }
    // `??`, `||` and `&&` between constants pick a constant.
    if (value.type === "LogicalExpression") {
      return (
        this.isConstant(value.left, depth + 1) &&
        this.isConstant(value.right, depth + 1)
      );
    }
    return (
      value.type === "UnaryExpression" &&
      this.isConstant(value.argument, depth + 1)
    );
  };

  readonly isBodyAccess = (node: Node): boolean =>
    node.type === "MemberExpression" && this.memberName(node) === "body";
  readonly isOne = (node: Expression): boolean => {
    const value = this.resolve(node);
    return (
      value.type === "Literal" &&
      typeof value.value === "number" &&
      value.value === 1
    );
  };
  readonly queryChain = (node: CallExpression): CallExpression[] => {
    let top = node;
    for (;;) {
      const member = this.parentOf(top);
      const call = this.parents.get(member);
      if (
        member.type !== "MemberExpression" ||
        member.computed ||
        member.object !== top ||
        call?.type !== "CallExpression"
      ) {
        break;
      }
      top = call;
    }
    const calls: CallExpression[] = [];
    let current = this.unwrap(top);
    while (current.type === "CallExpression") {
      calls.push(current);
      const expression = this.unwrap(current.callee);
      if (expression.type !== "MemberExpression") {
        break;
      }
      current = this.unwrap(expression.object);
    }
    return calls;
  };
  readonly containsIdentifier = (node: Node, name: string): boolean => {
    let found = false;
    walk(node, (child) => {
      if (child.type === "Identifier" && child.name === name) {
        found = true;
      }
    });
    return found;
  };

  readonly sameExpression = (left: Expression, right: Expression): boolean =>
    this.textOf(this.resolve(left)).replace(/\s/gu, "") ===
    this.textOf(this.resolve(right)).replace(/\s/gu, "");

  readonly callsImported = ({
    call,
    module,
    name,
  }: ImportedCallOptions): boolean => {
    const expression = this.unwrap(call.callee);
    if (expression.type !== "Identifier") {
      return false;
    }
    return this.parsed.program.body.some(
      (statement) =>
        statement.type === "ImportDeclaration" &&
        statement.source.value === module &&
        statement.specifiers.some(
          (specifier) =>
            specifier.type === "ImportSpecifier" &&
            specifier.local.name === expression.name &&
            this.propertyName(specifier.imported) === name,
        ),
    );
  };

  readonly matchesSentinelBoundary = ({
    cap,
    boundary,
  }: SentinelBoundaryOptions): boolean => {
    const value = this.resolve(cap);
    if (
      value.type === "BinaryExpression" &&
      value.operator === "+" &&
      this.isOne(value.right)
    ) {
      return this.sameExpression(boundary, value.left);
    }
    const compared = this.resolve(boundary);
    return (
      value.type === "Literal" &&
      compared.type === "Literal" &&
      Number(value.value) > 1 &&
      Number(value.value) === Number(compared.value) + 1
    );
  };

  readonly queryResultBinding = (node: CallExpression) => {
    const declaration = this.ancestorOf(
      node,
      (ancestor) => ancestor.type === "VariableDeclarator",
    );
    if (
      declaration?.type !== "VariableDeclarator" ||
      declaration.id.type !== "Identifier"
    ) {
      return undefined;
    }
    const list = this.parentOf(declaration);
    if (list.type !== "VariableDeclaration" || list.declarations.length !== 1) {
      return undefined;
    }
    const chain = new Set(this.queryChain(node));
    let ancestor = this.parentOf(node);
    while (ancestor !== declaration) {
      if (
        ancestor.type === "CallExpression" &&
        !chain.has(ancestor) &&
        !["scopedDb", "safeDb", "await", "tryPromise"].includes(
          this.callName(ancestor.callee) ?? "",
        )
      ) {
        return undefined;
      }
      ancestor = this.parentOf(ancestor);
    }
    const statement = this.ancestorOf(
      declaration,
      (candidate) => candidate.type === "VariableDeclaration",
    );
    if (statement?.type !== "VariableDeclaration") {
      return undefined;
    }
    const block = this.parentOf(statement);
    if (block.type !== "BlockStatement") {
      return undefined;
    }
    const nextIndex = block.body.indexOf(statement) + 1;
    const following = block.body.at(nextIndex);
    if (following === undefined) {
      return undefined;
    }
    return {
      rowName: declaration.id.name,
      following,
      rest: block.body.slice(nextIndex + 1),
    };
  };

  readonly objectOption = (
    options: ObjectExpression,
    name: string,
  ): Expression | undefined => {
    const property = options.properties.find(
      (candidate) =>
        ((candidate.type === "Property" &&
          !candidate.method &&
          candidate.kind === "init") ||
          (candidate.type === "Property" && candidate.shorthand)) &&
        this.propertyKey(candidate) === name,
    );
    if (property === undefined) {
      return undefined;
    }
    if (
      property.type === "Property" &&
      !property.shorthand &&
      !property.method &&
      property.kind === "init"
    ) {
      return this.unwrap(property.value);
    }
    if (property.type === "Property" && property.shorthand) {
      return property.value;
    }
    return undefined;
  };

  readonly consumesCursorPage = ({
    following,
    rest,
    rowName,
    cap,
  }: CursorPageConsumptionOptions): boolean => {
    if (
      following.type !== "VariableDeclaration" ||
      following.declarations.length !== 1
    ) {
      return false;
    }
    const page = following.declarations.at(0);
    if (page?.id.type !== "Identifier" || page.init === null) {
      return false;
    }
    const call = this.unwrap(page.init);
    if (
      call.type !== "CallExpression" ||
      !this.callsImported({
        call,
        module: "@/api/lib/pagination",
        name: "createCursorPage",
      })
    ) {
      return false;
    }
    const options = call.arguments.at(0);
    if (options?.type !== "ObjectExpression") {
      return false;
    }
    const rows = this.objectOption(options, "rows");
    const limit = this.objectOption(options, "limit");
    if (
      rows?.type !== "Identifier" ||
      rows.name !== rowName ||
      limit === undefined ||
      !this.matchesSentinelBoundary({ cap, boundary: limit })
    ) {
      return false;
    }
    if (rest.some((item) => this.containsIdentifier(item, rowName))) {
      return false;
    }
    return rest.some(
      (item) =>
        item.type === "ReturnStatement" &&
        this.containsIdentifier(item, this.textOf(page.id)),
    );
  };

  readonly exitsOnOverflow = ({
    following,
    rowName,
    cap,
  }: OverflowExitOptions): boolean => {
    if (following.type !== "IfStatement") {
      return false;
    }
    const condition = this.unwrap(following.test);
    if (condition.type !== "BinaryExpression" || condition.operator !== ">") {
      return false;
    }
    const length = this.unwrap(condition.left);
    if (
      length.type !== "MemberExpression" ||
      this.propertyName(length.property) !== "length" ||
      length.object.type !== "Identifier" ||
      length.object.name !== rowName ||
      !this.matchesSentinelBoundary({ cap, boundary: condition.right })
    ) {
      return false;
    }
    const branch = following.consequent;
    const exit = branch.type === "BlockStatement" ? branch.body.at(-1) : branch;
    if (exit === undefined || this.containsIdentifier(branch, rowName)) {
      return false;
    }
    if (exit.type === "ReturnStatement" || exit.type === "ThrowStatement") {
      return true;
    }
    return (
      exit.type === "ExpressionStatement" &&
      exit.expression.type === "CallExpression" &&
      this.callsImported({
        call: exit.expression,
        module: "better-result",
        name: "panic",
      })
    );
  };

  // A sentinel is safe only when its own result is checked against its own cap,
  // before subsequent consumers, and the overflow branch exits without rows.
  readonly rejectsOverflow = (
    node: CallExpression,
    cap: Expression,
  ): boolean => {
    const binding = this.queryResultBinding(node);
    if (binding === undefined) {
      return false;
    }
    return (
      this.consumesCursorPage({ ...binding, cap }) ||
      this.exitsOnOverflow({
        following: binding.following,
        rowName: binding.rowName,
        cap,
      })
    );
  };

  readonly paginationNames = (root: Node): Set<string> =>
    new Set(
      this.isFunction(root)
        ? root.params.flatMap((parameter) => this.bindingNames(parameter))
        : [],
    );

  readonly referencesPagination = ({
    node,
    inputs,
    depth = 0,
  }: PaginationReferenceOptions): boolean => {
    if (depth >= 8) {
      return false;
    }
    if (node.type === "Identifier") {
      const parent = this.parents.get(node);
      if (
        parent?.type === "MemberExpression" &&
        !parent.computed &&
        parent.property === node
      ) {
        return false;
      }
      if (inputs.has(node.name) && PAGINATION_INPUT.test(node.name)) {
        return true;
      }
      const bound = this.bindingOf(node, node.name);
      if (
        bound !== undefined &&
        this.referencesPagination({ node: bound, inputs, depth: depth + 1 })
      ) {
        return true;
      }
    }
    if (
      node.type === "MemberExpression" &&
      !node.computed &&
      node.property.type === "Identifier" &&
      PAGINATION_INPUT.test(node.property.name) &&
      node.object.type === "Identifier" &&
      inputs.has(node.object.name)
    ) {
      return true;
    }
    let found = false;
    walk(node, (child, ancestors) => {
      if (ancestors.length === 1) {
        if (
          this.referencesPagination({ node: child, inputs, depth: depth + 1 })
        ) {
          found = true;
        }
        return "skip-children";
      }
      return undefined;
    });
    return found;
  };

  readonly limitDisposition = ({
    node,
    cap,
    root,
  }: LimitDispositionOptions):
    "exempt" | "fixed-page-size" | "constant-limit" => {
    if (this.isOne(cap) || this.rejectsOverflow(node, cap)) {
      return "exempt";
    }
    const chain = this.queryChain(node);
    const inputs = this.paginationNames(root);
    if (
      chain.some(
        (call) =>
          this.callName(call.callee) === "offset" &&
          call.arguments.some((argument) =>
            this.referencesPagination({ node: argument, inputs }),
          ),
      )
    ) {
      return "exempt";
    }
    if (
      chain.some(
        (call) =>
          this.callName(call.callee) === "where" &&
          call.arguments.some((argument) =>
            this.referencesPagination({ node: argument, inputs }),
          ),
      )
    ) {
      return "exempt";
    }
    if (
      this.referencesPagination({ node: root, inputs }) ||
      /(?:PAGE_SIZE|pageSize|pageLimit)/u.test(this.textOf(cap))
    ) {
      return "fixed-page-size";
    }
    return "constant-limit";
  };

  readonly isPredicateSubquery = (
    node: CallExpression,
    predicates: ReadonlyMap<string, number>,
  ) => {
    const parent = this.parentOf(node);
    if (
      parent.type !== "CallExpression" ||
      parent.callee.type !== "Identifier"
    ) {
      return false;
    }
    const name = parent.callee.name;
    const argument = predicates.get(name);
    if (argument === undefined || parent.arguments.at(argument) !== node) {
      return false;
    }
    let scope = this.parentOf(parent);
    while (scope.type !== "Program") {
      if (
        this.declarationIn(scope, name) !== undefined ||
        (this.isFunction(scope) &&
          (("id" in scope ? scope.id?.name : undefined) === name ||
            scope.params.some((parameter) =>
              this.bindingNames(parameter).includes(name),
            ))) ||
        (scope.type === "BlockStatement" &&
          scope.body.some(
            (statement) =>
              (statement.type === "FunctionDeclaration" ||
                statement.type === "ClassDeclaration") &&
              statement.id?.name === name,
          ))
      ) {
        return false;
      }
      scope = this.parentOf(scope);
    }
    return true;
  };

  readonly isSeparateScope = (node: Node, root: Node): boolean => {
    if (root.type === "Program" || ("id" in node && node.id !== null)) {
      return true;
    }
    const parent = this.parentOf(node);
    return (
      parent.type === "VariableDeclarator" ||
      parent.type === "MethodDefinition" ||
      (parent.type === "Property" && parent.method)
    );
  };
  scan = (): ReadFinding[] => {
    const imported = new Map<string, string>();
    const subqueryPredicates = new Map<string, number>();
    for (const statement of this.parsed.program.body) {
      if (statement.type !== "ImportDeclaration") {
        continue;
      }
      for (const element of statement.specifiers) {
        if (element.type !== "ImportSpecifier") {
          continue;
        }
        const name = this.propertyName(element.imported) ?? element.local.name;
        imported.set(element.local.name, name);
        if (statement.source.value !== "drizzle-orm") {
          continue;
        }
        switch (name) {
          case "inArray":
          case "notInArray":
            subqueryPredicates.set(element.local.name, 1);
            break;
          case "exists":
          case "notExists":
            subqueryPredicates.set(element.local.name, 0);
            break;
          default:
            break;
        }
      }
    }
    const findings: ReadFinding[] = [];
    const scanScope = (root: Node, name: string) => {
      const totalTimeouts: Node[] = [];
      // A mutable record: `visit` sets this from a closure, which control-flow
      // narrowing of a plain `let` would not see after `visit(root)` returns.
      const body = { read: false };
      const record = (kind: FindingKind, node: Node) =>
        findings.push({
          file: this.file,
          function: name,
          kind,
          line: this.parsed.locate(node.start).line,
        });
      const visit = (node: Node): "skip-children" | undefined => {
        if (
          node !== root &&
          this.isFunction(node) &&
          this.isSeparateScope(node, root)
        ) {
          scanScope(node, `${name}/${this.scopeName(node)}`);
          return "skip-children";
        }
        if (this.isBodyAccess(node)) {
          body.read = true;
        }
        if (node.type === "CallExpression") {
          const resolvedCall = this.resolve(node.callee);
          const named = this.callName(
            resolvedCall.type === "CallExpression"
              ? resolvedCall.callee
              : resolvedCall,
          );
          const called =
            named === undefined ? undefined : (imported.get(named) ?? named);
          if (
            called !== undefined &&
            [
              "arrayBuffer",
              "blob",
              "text",
              "json",
              "pipeTo",
              "pipeThrough",
              "getReader",
            ].includes(called)
          ) {
            body.read = true;
          }
          if (
            called === "timeout" &&
            resolvedCall.type === "MemberExpression" &&
            this.textOf(this.resolve(resolvedCall.object)) === "AbortSignal"
          ) {
            totalTimeouts.push(node);
          }
          if (called !== undefined && /fetch/iu.test(called)) {
            for (const argument of node.arguments) {
              for (const property of this.timeoutProperties(argument)) {
                record("numeric-timeout", property);
                totalTimeouts.push(property);
              }
            }
          }
          const cap = node.arguments.at(0);
          if (
            this.file !== BOUNDED_OWNER &&
            /^apps\/api\/src\/(?:handlers|lib)\//u.test(this.file) &&
            called === "limit" &&
            cap !== undefined &&
            this.isConstant(cap)
          ) {
            // Predicate subqueries stay in Postgres; their limit does not
            // truncate a collection transferred to the application.
            const disposition = this.isPredicateSubquery(
              node,
              subqueryPredicates,
            )
              ? "exempt"
              : this.limitDisposition({ node, cap, root });
            if (disposition !== "exempt") {
              record(disposition, node);
            }
          }
        }
        return undefined;
      };
      walk(root, visit);
      if (
        body.read &&
        !(
          this.file === "packages/fetch/src/index.ts" &&
          name === "module/executeFetchWithTimeout"
        )
      ) {
        for (const node of totalTimeouts) {
          record("total-timeout-body", node);
        }
      }
    };
    scanScope(this.parsed.program, "module");
    return findings;
  };
}
export const findTransferReads = (
  file: string,
  source: string,
): ReadFinding[] => {
  if (
    file.endsWith(".test.ts") ||
    file.endsWith(".test.tsx") ||
    file.includes("/tests/")
  ) {
    return [];
  }
  return new TransferReadInspector({ file, source }).scan();
};

const entryKey = ({
  file,
  function: fn,
  kind,
}: Pick<BaselineEntry, "file" | "function" | "kind">) =>
  `${file}::${fn}::${kind}`;

const isBaselineEntry = (value: unknown): value is BaselineEntry =>
  typeof value === "object" &&
  value !== null &&
  "file" in value &&
  typeof value.file === "string" &&
  "function" in value &&
  typeof value.function === "string" &&
  "kind" in value &&
  (value.kind === "numeric-timeout" ||
    value.kind === "total-timeout-body" ||
    value.kind === "constant-limit" ||
    value.kind === "fixed-page-size") &&
  "count" in value &&
  typeof value.count === "number" &&
  Number.isSafeInteger(value.count) &&
  value.count > 0 &&
  "reason" in value &&
  typeof value.reason === "string" &&
  value.reason.trim().length > 0;

export const parseTransferBaseline = (
  text: string,
  label: string,
): BaselineEntry[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every(isBaselineEntry)) {
    return panic(`${label} must contain reasoned transfer/read budgets`);
  }
  if (new Set(parsed.map(entryKey)).size !== parsed.length) {
    return panic(`${label} has duplicate file/function budgets`);
  }
  return parsed;
};

const membershipKey = (
  entry: Pick<BaselineEntry, "file" | "function" | "kind">,
): string =>
  entryKey({
    ...entry,
    kind: entry.kind === "fixed-page-size" ? "constant-limit" : entry.kind,
  });

// Keep relocated function budgets at their original identity until the move
// is in the comparison base; removing a rekey then leaves membership unchanged.
const TRANSFER_READ_PATH_REKEYS = [
  {
    file: "apps/api/src/lib/entity-versions/publish-folio-collab-checkpoint.ts",
    function: "module/loadRoomContributors",
    fromFile: "apps/api/src/handlers/entities/publish-folio-collab-version.ts",
  },
] as const;

export const transferMembership = (text: string, label: string): string[] => {
  const counts = new Map<string, number>();
  for (const entry of parseTransferBaseline(text, label)) {
    const rekey = TRANSFER_READ_PATH_REKEYS.find(
      (candidate) =>
        candidate.file === entry.file && candidate.function === entry.function,
    );
    const key = membershipKey({
      ...entry,
      file: rekey?.fromFile ?? entry.file,
    });
    counts.set(key, (counts.get(key) ?? 0) + entry.count);
  }
  return [...counts].flatMap(([key, count]) =>
    Array.from({ length: count }, (_, index) => `${key}::${index}`),
  );
};

export const compareTransferBaseline = (
  found: readonly ReadFinding[],
  baseline: readonly BaselineEntry[],
) => {
  const counts = new Map<string, number>();
  for (const item of found) {
    counts.set(entryKey(item), (counts.get(entryKey(item)) ?? 0) + 1);
  }
  const budgets = new Map(
    baseline.map((entry) => [entryKey(entry), entry.count]),
  );
  return {
    unlisted: found.filter(
      (item) =>
        (counts.get(entryKey(item)) ?? 0) > (budgets.get(entryKey(item)) ?? 0),
    ),
    stale: baseline.filter(
      (item) => (counts.get(entryKey(item)) ?? 0) < item.count,
    ),
  };
};

export const scanTransferTree = async (): Promise<ReadFinding[]> => {
  const found: ReadFinding[] = [];
  for (const pattern of [
    "apps/**/src/**/*.{ts,tsx}",
    "packages/**/src/**/*.{ts,tsx}",
  ]) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: REPO_ROOT })) {
      if (file.includes("/node_modules/") || file.endsWith(".d.ts")) {
        continue;
      }
      const source = await Bun.file(path.join(REPO_ROOT, file)).text();
      if (!/timeoutMs|AbortSignal|\blimit\b/u.test(source)) {
        continue;
      }
      found.push(...findTransferReads(file, source));
    }
  }
  // Code-unit order: keys are repository paths and identifiers, not display text.
  return found.toSorted((a, b) => {
    const left = entryKey(a);
    const right = entryKey(b);
    if (left === right) {
      return a.line - b.line;
    }
    return left < right ? -1 : 1;
  });
};

const DEFAULT_REASON = {
  "numeric-timeout":
    "Existing total timeout; select an explicit header or idle policy at the fetch owner.",
  "total-timeout-body":
    "Existing total timeout; select an explicit header or idle policy at the fetch owner.",
  "constant-limit":
    "Existing fixed read budget; migrate unbounded decisions and exports to readBounded or document the pagination/table-cap contract.",
  "fixed-page-size":
    "Existing fixed page budget; prove the cursor/page input reaches this read before treating its rows as a complete result.",
} as const satisfies Record<FindingKind, string>;

const writeBaseline = async () => {
  const baselineFile = Bun.file(path.join(REPO_ROOT, LEDGER_REL));
  const baseline = (await baselineFile.exists())
    ? parseTransferBaseline(await baselineFile.text(), LEDGER_REL)
    : undefined;
  const entries = new Map<string, BaselineEntry>();
  for (const finding of await scanTransferTree()) {
    const key = entryKey(finding);
    const existing = entries.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    const previous = baseline?.find(
      (entry) =>
        entryKey(entry) === key ||
        membershipKey(entry) === membershipKey(finding),
    );
    const reason =
      (finding.kind === "fixed-page-size" && previous?.kind === "constant-limit"
        ? undefined
        : previous?.reason) ?? DEFAULT_REASON[finding.kind];
    entries.set(key, {
      file: finding.file,
      function: finding.function,
      kind: finding.kind,
      count: 1,
      reason,
    });
  }
  if (baseline !== undefined) {
    const before = new Set(
      transferMembership(JSON.stringify(baseline), LEDGER_REL),
    );
    const added = transferMembership(
      JSON.stringify([...entries.values()]),
      LEDGER_REL,
    ).filter((entry) => !before.has(entry));
    if (added.length > 0) {
      panic(`Cannot grow the transfer/read baseline: ${added.join(", ")}`);
    }
  }
  writeFileSync(
    path.join(REPO_ROOT, LEDGER_REL),
    `${JSON.stringify([...entries.values()], null, 2)}\n`,
  );
};

const check = async () => {
  const baseline = parseTransferBaseline(
    readFileSync(path.join(REPO_ROOT, LEDGER_REL), "utf-8"),
    LEDGER_REL,
  );
  const { unlisted, stale } = compareTransferBaseline(
    await scanTransferTree(),
    baseline,
  );
  for (const item of unlisted) {
    console.error(
      `${item.file}:${item.line}: ${item.kind} in ${item.function}; use an explicit transfer policy or readBounded.`,
    );
  }
  for (const item of stale) {
    console.error(
      `${entryKey(item)}: lower or remove the stale baseline budget.`,
    );
  }
  // Reuse the shared shrink-only membership guard, expanding counts so an
  // existing function cannot hide a second unsafe read by raising its budget.
  const membership = runLedgerMembershipGuard({
    ledgerRel: LEDGER_REL,
    repoRoot: REPO_ROOT,
    parseLedger: transferMembership,
    label: "transfer-read",
    remediation: "use the owning helper rather than increasing a budget",
  });
  if (unlisted.length || stale.length) {
    return 1;
  }
  return membership;
};

if (import.meta.main) {
  if (process.argv.includes("--write")) {
    await writeBaseline();
  } else {
    process.exit(await check());
  }
}
