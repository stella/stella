import { panic } from "better-result";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";
import {
  type ExportAllDeclaration,
  type ExportNamedDeclaration,
  type Expression,
  type ImportDeclaration,
  type ImportExpression,
  type ModuleExportName,
  type Node,
  type ObjectProperty,
  type ParsedSource,
  parseSource,
  type Program,
  type VariableDeclarator,
  walk,
} from "@stll/scripts/src/syntax-tree";

import {
  discoverSafeHandlers,
  HANDLERS_GLOB,
  REPO_ROOT,
  type SafeHandlerDiscovery,
} from "./lib/enumerate-safe-handlers";
import {
  findHiddenEndpointMismatches,
  findStaleAllowlistEntries,
  INLINE_ENDPOINT_ALLOWLIST,
} from "./mcp-coverage-guard";

const FACTORY =
  /^createSafe(?:Root|Session|Token|Public|PublicSubject|PublicSubjectFollowUp)?Handler$/u;
const TERMINAL =
  /^(?:secureDocumentResponse|auditedPresignDownload|presignDownloadUrl|readTenantS3ArrayBuffer|getS3ObjectWithSignal|readS3Object\w*|readS3ArrayBuffer)$/u;
const isDeliveryOwner = (file: string) =>
  /(?:^|\/)lib\/(?:s3|s3-presign|secure-document-response|audited-download)(?:\.ts)?$/u.test(
    file,
  );

type SourceFile = {
  fileName: string;
  program: Program;
  locate: ParsedSource["locate"];
};

type BindingKind =
  | "variable"
  | "function"
  | "class"
  | "parameter"
  | "element"
  | "import"
  | "namespace";

/**
 * A declared name: a variable (or catch variable), function, class,
 * parameter, destructured element or import. Elements point at the binding
 * whose value they destructure.
 */
class Binding {
  readonly kind: BindingKind;
  /** The syntax that declares it; its range scopes the name. */
  readonly node: Node;
  readonly name: Node | undefined;
  /** A variable's value or a parameter's default. */
  readonly initializer: Expression | undefined;
  readonly owner: Binding | undefined;
  readonly declaration: ImportDeclaration | undefined;
  /** The exported name an `import { name }` reads. */
  readonly importedName: string | undefined;
  constructor(options: {
    kind: BindingKind;
    node: Node;
    name?: Node | undefined;
    initializer?: Expression | null | undefined;
    owner?: Binding | undefined;
    declaration?: ImportDeclaration | undefined;
    importedName?: string | undefined;
  }) {
    this.kind = options.kind;
    this.node = options.node;
    this.name = options.name?.type === "Identifier" ? options.name : undefined;
    this.initializer = options.initializer ?? undefined;
    this.owner = options.owner;
    this.declaration = options.declaration;
    this.importedName = options.importedName;
  }
}
type Traced = Node | Binding;

const isStringLike = (node: Traced | null | undefined) =>
  node !== null &&
  node !== undefined &&
  !(node instanceof Binding) &&
  ((node.type === "Literal" && typeof node.value === "string") ||
    (node.type === "TemplateLiteral" && node.expressions.length === 0));
const propertyName = (node: Traced | null | undefined) => {
  if (!node || node instanceof Binding) {
    return undefined;
  }
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.at(0)?.value.cooked ?? undefined;
  }
  return undefined;
};
const moduleExportName = (node: ModuleExportName) =>
  node.type === "Literal" ? node.value : node.name;
/** A `name: value` entry or a method, not a shorthand or accessor entry. */
const isPropertyAssignment = (
  node: Traced | undefined,
): node is ObjectProperty =>
  node !== undefined &&
  !(node instanceof Binding) &&
  node.type === "Property" &&
  node.kind === "init" &&
  !node.method &&
  !node.shorthand;
const keyName = (property: ObjectProperty) =>
  property.computed ? undefined : propertyName(property.key);
const isFunctionValue = (node: Expression | undefined) =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionExpression";
const isFunctionLike = (node: Node) =>
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression" ||
  node.type === "ArrowFunctionExpression" ||
  node.type === "TSDeclareFunction" ||
  node.type === "TSEmptyBodyFunctionExpression";
const isScope = (node: Node) =>
  node.type === "Program" ||
  node.type === "BlockStatement" ||
  node.type === "StaticBlock" ||
  isFunctionLike(node);
// TypeScript syntax that still runs; every other `TS…` node is a type.
const RUNTIME_TYPESCRIPT = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSEnumDeclaration",
  "TSEnumBody",
  "TSEnumMember",
  "TSModuleDeclaration",
  "TSModuleBlock",
  "TSImportEqualsDeclaration",
  "TSExternalModuleReference",
  "TSQualifiedName",
  "TSExportAssignment",
  "TSNamespaceExportDeclaration",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
  "TSParameterProperty",
  "TSAbstractMethodDefinition",
  "TSAbstractPropertyDefinition",
  "TSAbstractAccessorProperty",
  "TSIndexSignature",
]);
/** A node's direct children in source order. */
const children = (node: Node) => {
  const found: Node[] = [];
  walk(node, (child) => {
    if (child === node) {
      return undefined;
    }
    found.push(child);
    return "skip-children";
  });
  return found;
};
const isPatternPart = (node: Node, parent: Node | undefined) =>
  node.type === "ObjectPattern" ||
  node.type === "ArrayPattern" ||
  node.type === "AssignmentPattern" ||
  node.type === "RestElement" ||
  (node.type === "Property" && parent?.type === "ObjectPattern");

type AnalyzeContentDeliveryOptions = {
  files: readonly string[];
  readFile: (file: string) => string | undefined;
  resolveImport: (specifier: string, from: string) => string | undefined;
};

class ContentDeliveryInspector {
  private readonly options;
  constructor(options: AnalyzeContentDeliveryOptions) {
    this.options = options;
  }
  private readonly modules = new Map<string, SourceFile>();
  private readonly bindings = new Map<SourceFile, Map<string, Binding[]>>();
  // oxc nodes carry no parent or file links.
  private readonly parents = new Map<Node, Node>();
  private readonly files = new Map<Node, SourceFile>();
  private readonly bindingOf = new Map<Node, Binding>();
  private readonly errors = new Set<string>();
  private readonly fileOf = (node: Traced) =>
    this.files.get(node instanceof Binding ? node.node : node) ??
    panic("Content delivery guard reached a node outside its loaded files");
  /** Class heritage is a type position, as are type nodes and declarations. */
  private readonly runtime = (node: Node) => {
    const parent = this.parents.get(node);
    if (
      (parent?.type === "ClassDeclaration" ||
        parent?.type === "ClassExpression") &&
      parent.superClass === node
    ) {
      return false;
    }
    return !node.type.startsWith("TS") || RUNTIME_TYPESCRIPT.has(node.type);
  };
  private readonly lineOf = (node: Node) =>
    this.fileOf(node).locate(node.start).line;
  private readonly scope = (node: Node): Node => {
    let current: Node | undefined = node;
    while (current && !isScope(current)) {
      current = this.parents.get(current);
    }
    return current ?? panic("Content delivery guard lost a node's scope");
  };
  private readonly bindingScope = (binding: Binding) =>
    this.scope(
      binding.kind === "function"
        ? (this.parents.get(binding.node) ?? binding.node)
        : binding.node,
    );
  private readonly encloses = (outer: Node, inner: Node) =>
    this.fileOf(outer) === this.fileOf(inner) &&
    outer.start <= inner.start &&
    outer.end >= inner.end;
  /** The binding a destructuring pattern takes its value from. */
  private readonly patternOwner = (pattern: Node) => {
    const parent = this.parents.get(pattern);
    // A defaulted pattern (`{ a } = {}`) is declared by its default.
    const holder = parent?.type === "AssignmentPattern" ? parent : pattern;
    // A declarator, a property or a rest element holds a pattern it does
    // not declare on its own.
    return (
      this.bindingOf.get(holder) ??
      this.bindingOf.get(this.parents.get(holder) ?? holder)
    );
  };
  /** Whether a pattern declares names rather than assigns existing ones. */
  private readonly declaresNames = (pattern: Node) => {
    let node = pattern;
    let parent = this.parents.get(node);
    while (parent && isPatternPart(parent, this.parents.get(parent))) {
      node = parent;
      parent = this.parents.get(node);
    }
    return (
      (parent?.type === "VariableDeclarator" && parent.id === node) ||
      (parent?.type === "CatchClause" && parent.param === node) ||
      parent?.type === "TSParameterProperty" ||
      (parent !== undefined &&
        isFunctionLike(parent) &&
        "params" in parent &&
        parent.params.some((param) => param === node))
    );
  };
  private readonly declare = (
    names: Map<string, Binding[]>,
    binding: Binding,
  ) => {
    this.bindingOf.set(binding.node, binding);
    if (binding.name?.type === "Identifier") {
      const entries = names.get(binding.name.name) ?? [];
      entries.push(binding);
      names.set(binding.name.name, entries);
    }
  };
  private readonly indexBinding = (
    names: Map<string, Binding[]>,
    node: Node,
    parent: Node | undefined,
  ) => {
    if (node.type === "VariableDeclarator") {
      this.declare(
        names,
        new Binding({
          kind: "variable",
          node,
          name: node.id,
          initializer: node.init,
        }),
      );
      return;
    }
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "TSDeclareFunction"
    ) {
      this.declare(
        names,
        new Binding({ kind: "function", node, name: node.id ?? undefined }),
      );
      return;
    }
    if (node.type === "ClassDeclaration") {
      this.declare(
        names,
        new Binding({ kind: "class", node, name: node.id ?? undefined }),
      );
      return;
    }
    if (
      parent?.type === "ImportDeclaration" &&
      (node.type === "ImportSpecifier" ||
        node.type === "ImportDefaultSpecifier" ||
        node.type === "ImportNamespaceSpecifier")
    ) {
      const { local: importedBinding } = node;
      this.declare(
        names,
        new Binding({
          kind:
            node.type === "ImportNamespaceSpecifier" ? "namespace" : "import",
          node,
          name: importedBinding,
          declaration: parent,
          importedName:
            node.type === "ImportSpecifier"
              ? moduleExportName(node.imported)
              : undefined,
        }),
      );
      return;
    }
    if (parent?.type === "CatchClause" && parent.param === node) {
      // A catch variable declares a name without a value.
      this.declare(names, new Binding({ kind: "variable", node, name: node }));
      return;
    }
    const binding =
      this.parameterBinding(node, parent) ?? this.elementBinding(node, parent);
    if (binding !== undefined) {
      this.declare(names, binding);
    }
  };
  /** A function parameter, its default value included. */
  private readonly parameterBinding = (
    node: Node,
    parent: Node | undefined,
  ): Binding | undefined => {
    const isParameter =
      node.type === "TSParameterProperty" ||
      (parent !== undefined &&
        parent.type !== "TSParameterProperty" &&
        isFunctionLike(parent) &&
        "params" in parent &&
        parent.params.some((param) => param === node));
    if (!isParameter) {
      return undefined;
    }
    const pattern = node.type === "TSParameterProperty" ? node.parameter : node;
    let name: Node | undefined = pattern;
    let initializer: Expression | undefined;
    if (pattern.type === "AssignmentPattern") {
      name = pattern.left;
      initializer = pattern.right;
    } else if (pattern.type === "RestElement") {
      name = pattern.argument;
    }
    return new Binding({ kind: "parameter", node, name, initializer });
  };
  /** An entry of a pattern that declares names, tied to the value it reads. */
  private readonly elementBinding = (
    node: Node,
    parent: Node | undefined,
  ): Binding | undefined => {
    if (parent === undefined) {
      return undefined;
    }
    const isElement =
      (parent.type === "ObjectPattern" &&
        (node.type === "Property" || node.type === "RestElement")) ||
      parent.type === "ArrayPattern";
    if (!isElement || !this.declaresNames(parent)) {
      return undefined;
    }
    let target: Node = node;
    if (node.type === "Property") {
      target = node.value;
    }
    let name: Node | undefined = target;
    if (target.type === "AssignmentPattern") {
      name = target.left;
    } else if (target.type === "RestElement") {
      name = target.argument;
    }
    return new Binding({
      kind: "element",
      node,
      name,
      owner: this.patternOwner(parent),
    });
  };
  private readonly load = (file: string) => {
    const cached = this.modules.get(file);
    if (cached) {
      return cached;
    }
    const source = this.options.readFile(file);
    if (source === undefined) {
      this.errors.add(`Cannot inspect ${file}`);
      return undefined;
    }
    const { locate, program } = parseSource(file, source);
    const parsed: SourceFile = { fileName: file, locate, program };
    this.modules.set(file, parsed);
    walk(parsed.program, (node, ancestors) => {
      const parent = ancestors.at(-1);
      if (parent) {
        this.parents.set(node, parent);
      }
      this.files.set(node, parsed);
    });
    const names = new Map<string, Binding[]>();
    this.bindings.set(parsed, names);
    walk(parsed.program, (node, ancestors) => {
      if (!this.runtime(node)) {
        return "skip-children";
      }
      this.indexBinding(names, node, ancestors.at(-1));
      return undefined;
    });
    return parsed;
  };
  private readonly lookup = (reference: Node & { name: string }) => {
    const availableBindings =
      this.bindings.get(this.fileOf(reference))?.get(reference.name) ?? [];
    return availableBindings
      .filter((candidate) =>
        this.encloses(this.bindingScope(candidate), reference),
      )
      .toSorted(
        (a, b) =>
          this.bindingScope(a).end -
          this.bindingScope(a).start -
          (this.bindingScope(b).end - this.bindingScope(b).start),
      )
      .at(0);
  };
  private readonly importFile = (specifier: string, from: string) => {
    if (/\.(?:json|ttf|otf|woff2?|png|svg|docx)$/u.test(specifier)) {
      return undefined;
    }
    const resolved = this.options.resolveImport(specifier, from);
    if (
      !resolved &&
      (specifier.startsWith(".") || specifier.startsWith("@/"))
    ) {
      this.errors.add(`Unresolved local import ${specifier} from ${from}`);
    }
    return resolved ? this.load(resolved) : undefined;
  };
  private readonly exportsSeen = new Set<string>();
  private readonly resolveReexport = (
    statement: ExportNamedDeclaration | ExportAllDeclaration,
    file: SourceFile,
    name: string,
  ): Traced | undefined => {
    const target = statement.source
      ? this.importFile(statement.source.value, file.fileName)
      : file;
    if (!target) {
      if (statement.type === "ExportNamedDeclaration") {
        const entry = statement.specifiers.find(
          (item) =>
            moduleExportName(item.exported) === name &&
            item.exportKind !== "type",
        );
        if (entry) {
          return entry;
        }
      }
      return undefined;
    }
    if (statement.type === "ExportAllDeclaration") {
      // `export * as name` re-exports a namespace, not a definition.
      return statement.exported === null
        ? this.exported(target, name)
        : undefined;
    }
    const entry = statement.specifiers.find(
      (item) =>
        moduleExportName(item.exported) === name && item.exportKind !== "type",
    );
    if (!entry) {
      return undefined;
    }
    const { local: exportedBinding } = entry;
    const original = moduleExportName(exportedBinding);
    return target === file
      ? this.bindings.get(file)?.get(original)?.at(0)
      : this.exported(target, original);
  };
  private readonly exported = (
    file: SourceFile,
    name: string,
  ): Traced | undefined => {
    const key = `${file.fileName}#${name}`;
    if (this.exportsSeen.has(key)) {
      return undefined;
    }
    this.exportsSeen.add(key);
    for (const statement of file.program.body) {
      if (statement.type === "TSExportAssignment") {
        if (name === "default") {
          return statement.expression;
        }
        continue;
      }
      if (statement.type === "ExportDefaultDeclaration") {
        if (
          name === "default" &&
          statement.declaration.type !== "TSInterfaceDeclaration"
        ) {
          return statement.declaration;
        }
        continue;
      }
      if (
        statement.type === "ExportAllDeclaration" ||
        (statement.type === "ExportNamedDeclaration" &&
          statement.declaration === null)
      ) {
        if (statement.exportKind !== "type") {
          const found = this.resolveReexport(statement, file, name);
          if (found) {
            return found;
          }
        }
        continue;
      }
      if (statement.type !== "ExportNamedDeclaration") {
        continue;
      }
      const { declaration } = statement;
      if (
        (declaration?.type === "FunctionDeclaration" ||
          declaration?.type === "TSDeclareFunction" ||
          declaration?.type === "ClassDeclaration") &&
        declaration.id?.name === name
      ) {
        return declaration;
      }
      if (declaration?.type === "VariableDeclaration") {
        const found = declaration.declarations.find(
          (item) => propertyName(item.id) === name,
        );
        if (found) {
          return found;
        }
        const binding = this.bindings
          .get(file)
          ?.get(name)
          ?.find(
            (item) =>
              item.kind === "element" &&
              statement.start <= item.node.start &&
              statement.end >= item.node.end,
          );
        if (binding) {
          return binding;
        }
      }
    }
    return undefined;
  };
  private readonly candidates: {
    file: string;
    line: number;
    binding: string;
    terminals: string[];
    declared: boolean;
  }[] = [];
  private readonly value = (
    node: Traced | null | undefined,
    resolvedNodes = new Set<Traced>(),
  ): Traced | undefined => {
    if (!node || resolvedNodes.has(node)) {
      return undefined;
    }
    resolvedNodes.add(node);
    if (node instanceof Binding) {
      return node.kind === "variable"
        ? this.value(node.initializer, resolvedNodes)
        : node;
    }
    if (node.type === "Identifier") {
      return this.value(this.lookup(node), resolvedNodes);
    }
    if (isPropertyAssignment(node)) {
      return this.value(node.value, resolvedNodes);
    }
    if (
      node.type === "ParenthesizedExpression" ||
      node.type === "TSAsExpression" ||
      node.type === "TSSatisfiesExpression"
    ) {
      return this.value(node.expression, resolvedNodes);
    }
    if (node.type === "AwaitExpression") {
      return this.value(node.argument, resolvedNodes);
    }
    return node;
  };
  private readonly field = (node: Traced | null | undefined, name: string) => {
    const object = this.value(node);
    if (
      !object ||
      object instanceof Binding ||
      object.type !== "ObjectExpression"
    ) {
      return undefined;
    }
    return this.value(
      object.properties.find(
        (item) => isPropertyAssignment(item) && keyName(item) === name,
      ),
    );
  };

  private terminals = new Set<string>();
  private visited = new Set<Traced>();
  private readonly traceExport = (target: SourceFile, name: string) => {
    if (TERMINAL.test(name) && isDeliveryOwner(target.fileName)) {
      this.terminals.add(name);
      return;
    }
    this.exportsSeen.clear();
    const definition = this.exported(target, name);
    if (!definition) {
      this.errors.add(`Unresolved local symbol ${target.fileName}#${name}`);
      return;
    }
    this.trace(definition, true);
  };
  private readonly traceImport = (definition: Binding, member?: string) => {
    const current = definition.declaration;
    if (!current) {
      return;
    }
    if (
      current.attributes.some(
        (attribute) =>
          propertyName(attribute.key) === "type" &&
          (attribute.value.value === "text" ||
            attribute.value.value === "file"),
      )
    ) {
      return;
    }
    const name = member ?? definition.importedName ?? "default";
    const from = this.fileOf(current).fileName;
    const resolved = this.options.resolveImport(current.source.value, from);
    if (resolved && TERMINAL.test(name) && isDeliveryOwner(resolved)) {
      this.terminals.add(name);
      return;
    }
    const target = this.importFile(current.source.value, from);
    if (target) {
      this.traceExport(target, name);
    }
  };
  private readonly shouldDefer = (current: Binding, referenced: boolean) =>
    !referenced &&
    (current.kind === "function" ||
      (current.kind === "variable" && isFunctionValue(current.initializer)));
  private readonly traceNamespaceAccess = (current: Traced) => {
    if (current instanceof Binding) {
      const declaration = current.declaration;
      if (current.kind === "namespace" && declaration) {
        const specifier = declaration.source.value;
        const from = this.fileOf(declaration).fileName;
        if (this.options.resolveImport(specifier, from)) {
          this.errors.add(
            `Unresolved namespace member ${propertyName(current.name) ?? ""} in ${from}`,
          );
        } else {
          this.importFile(specifier, from);
        }
        return true;
      }
      return false;
    }
    if (
      current.type !== "MemberExpression" ||
      current.object.type !== "Identifier"
    ) {
      return false;
    }
    let member: string | undefined;
    if (!current.computed && current.property.type === "Identifier") {
      member = current.property.name;
    } else if (current.computed && isStringLike(current.property)) {
      member = propertyName(current.property);
    }
    if (member === undefined) {
      return false;
    }
    const definition = this.lookup(current.object);
    if (definition?.kind === "namespace") {
      this.traceImport(definition, member);
      return true;
    }
    return false;
  };
  private readonly detectOwner = (current: Binding) => {
    if (
      (current.kind === "variable" || current.kind === "function") &&
      isDeliveryOwner(this.fileOf(current).fileName)
    ) {
      const name = propertyName(current.name);
      if (name && TERMINAL.test(name)) {
        this.terminals.add(name);
        return true;
      }
    }
    return false;
  };
  private readonly traceBinding = (current: Binding, referenced: boolean) => {
    if (this.visited.has(current) || this.shouldDefer(current, referenced)) {
      return;
    }
    this.visited.add(current);
    if (this.detectOwner(current)) {
      return;
    }
    switch (current.kind) {
      case "import":
        this.traceImport(current);
        return;
      case "parameter":
        if (current.initializer) {
          this.trace(current.initializer);
        }
        return;
      case "namespace":
        this.traceNamespaceAccess(current);
        return;
      case "variable":
        if (
          current.initializer &&
          (referenced || !isFunctionValue(current.initializer))
        ) {
          this.trace(current.initializer);
        }
        return;
      case "element":
        if (current.owner) {
          this.trace(current.owner, true);
        }
        return;
      case "function":
      case "class":
        for (const child of children(current.node)) {
          this.trace(child);
        }
    }
  };
  private readonly trace = (input: Traced, referenced = false) => {
    const current =
      input instanceof Binding ? input : (this.bindingOf.get(input) ?? input);
    if (current instanceof Binding) {
      this.traceBinding(current, referenced);
      return;
    }
    if (this.visited.has(current) || !this.runtime(current)) {
      return;
    }
    this.visited.add(current);
    this.detectDisposition(current);
    this.detectStoreSigner(current);
    if (current.type === "ImportExpression") {
      this.traceDynamicImport(current);
      return;
    }
    if (this.traceNamespaceAccess(current)) {
      return;
    }
    if (current.type === "Identifier") {
      const parent = this.parents.get(current);
      if (
        (parent?.type === "MemberExpression" &&
          !parent.computed &&
          parent.property === current) ||
        (parent?.type === "Property" &&
          parent.kind === "init" &&
          !parent.computed &&
          parent.key === current) ||
        (parent?.type === "MethodDefinition" &&
          (parent.kind === "method" || parent.kind === "constructor") &&
          !parent.computed &&
          parent.key === current)
      ) {
        return;
      }
      const definition = this.lookup(current);
      if (definition && definition.name !== current) {
        this.trace(definition, true);
      }
      return;
    }
    for (const child of children(current)) {
      this.trace(child);
    }
  };

  /** Whether `identifier` names a binding a delivery owner module provides. */
  private readonly boundToOwner = (
    identifier: Node & { name: string },
  ): boolean => {
    const definition = this.lookup(identifier);
    if (!definition) {
      return false;
    }
    if (isDeliveryOwner(this.fileOf(definition).fileName)) {
      return true;
    }
    if (definition.kind === "variable") {
      return (
        definition.initializer !== undefined &&
        this.isOwnerStore(definition.initializer)
      );
    }
    const current = definition.declaration;
    if (!current) {
      return false;
    }
    const resolved = this.options.resolveImport(
      current.source.value,
      this.fileOf(current).fileName,
    );
    return resolved !== undefined && isDeliveryOwner(resolved);
  };
  /** An object store a delivery owner hands out: `getS3()`, `store.client()`, or a binding to one. */
  private readonly isOwnerStore = (expression: Node): boolean => {
    if (expression.type === "Identifier") {
      return this.boundToOwner(expression);
    }
    if (expression.type === "CallExpression") {
      return this.isOwnerStore(expression.callee);
    }
    if (expression.type === "MemberExpression" && !expression.computed) {
      return this.isOwnerStore(expression.object);
    }
    if (expression.type === "ParenthesizedExpression") {
      return this.isOwnerStore(expression.expression);
    }
    if (expression.type === "AwaitExpression") {
      return this.isOwnerStore(expression.argument);
    }
    return false;
  };
  // Presigning on a store from the S3 owner (`getS3().presign(key)`) grants
  // the same stored bytes as `presignDownloadUrl`.
  private readonly detectStoreSigner = (current: Node) => {
    if (
      current.type === "CallExpression" &&
      current.callee.type === "MemberExpression" &&
      !current.callee.computed &&
      current.callee.property.type === "Identifier" &&
      current.callee.property.name === "presign" &&
      this.isOwnerStore(current.callee.object)
    ) {
      this.terminals.add("presign");
    }
  };

  private readonly detectDisposition = (current: Node) => {
    const headerName = (key: Node | undefined) =>
      propertyName(this.value(key))?.toLowerCase() === "content-disposition";
    if (isPropertyAssignment(current) && headerName(current.key)) {
      this.terminals.add("Content-Disposition");
    }
    if (
      current.type === "AssignmentExpression" &&
      current.operator === "=" &&
      current.left.type === "MemberExpression" &&
      current.left.computed &&
      headerName(current.left.property)
    ) {
      this.terminals.add("Content-Disposition");
    }
    if (
      current.type === "CallExpression" &&
      current.callee.type === "MemberExpression" &&
      !current.callee.computed &&
      current.callee.property.type === "Identifier" &&
      ["set", "append"].includes(current.callee.property.name) &&
      headerName(current.arguments.at(0))
    ) {
      this.terminals.add("Content-Disposition");
    }
    if (
      current.type === "NewExpression" &&
      current.callee.type === "Identifier" &&
      current.callee.name === "Headers"
    ) {
      walk(current, (child) => {
        if (isStringLike(child) && headerName(child)) {
          this.terminals.add("Content-Disposition");
        }
      });
    }
  };
  /** Exports a dynamically imported namespace bound to a variable reaches. */
  private readonly traceDynamicBinding = (
    file: SourceFile,
    target: SourceFile,
    parent: VariableDeclarator,
  ) => {
    const declaration =
      this.bindingOf.get(parent) ??
      panic("Content delivery guard lost a variable binding");
    if (parent.id.type === "ObjectPattern") {
      for (const element of parent.id.properties) {
        const name = element.type === "Property" ? keyName(element) : undefined;
        if (!name) {
          this.errors.add(
            `Unresolved dynamic namespace binding in ${target.fileName}`,
          );
        } else {
          this.traceExport(target, name);
        }
      }
      return;
    }
    walk(file.program, (reference) => {
      if (!this.runtime(reference)) {
        return "skip-children";
      }
      if (
        reference.type !== "Identifier" ||
        reference === declaration.name ||
        this.lookup(reference) !== declaration
      ) {
        return undefined;
      }
      const referenceParent = this.parents.get(reference);
      if (
        referenceParent?.type === "MemberExpression" &&
        referenceParent.object === reference &&
        !referenceParent.computed &&
        referenceParent.property.type === "Identifier"
      ) {
        this.traceExport(target, referenceParent.property.name);
      } else if (
        referenceParent?.type === "MemberExpression" &&
        referenceParent.object === reference &&
        referenceParent.computed &&
        isStringLike(referenceParent.property)
      ) {
        this.traceExport(target, propertyName(referenceParent.property) ?? "");
      } else {
        this.errors.add(
          `Unresolved dynamic namespace use in ${target.fileName}`,
        );
      }
      return "skip-children";
    });
  };
  private readonly traceDynamicImport = (current: ImportExpression) => {
    const file = this.fileOf(current);
    const specifier = isStringLike(current.source)
      ? propertyName(current.source)
      : undefined;
    if (specifier === undefined) {
      this.errors.add(
        `Unresolved dynamic import at ${file.fileName}:${this.lineOf(current)}`,
      );
      return;
    }
    const target = this.importFile(specifier, file.fileName);
    if (!target) {
      return;
    }
    let use: Node = current;
    let parent = this.parents.get(use);
    while (
      parent?.type === "AwaitExpression" ||
      parent?.type === "ParenthesizedExpression"
    ) {
      use = parent;
      parent = this.parents.get(use);
    }
    if (
      parent?.type === "MemberExpression" &&
      !parent.computed &&
      parent.property.type === "Identifier"
    ) {
      this.traceExport(target, parent.property.name);
      return;
    }
    if (parent?.type === "VariableDeclarator" && parent.init === use) {
      this.traceDynamicBinding(file, target, parent);
      return;
    }
    // A reached module namespace can be injected or dispatched; all of its
    // runtime exports are possible callees, but its unused imports are not.
    for (const statement of target.program.body) {
      if (
        statement.type === "ExportNamedDeclaration" &&
        statement.declaration === null &&
        statement.exportKind !== "type"
      ) {
        for (const entry of statement.specifiers) {
          if (entry.exportKind !== "type") {
            this.traceExport(target, moduleExportName(entry.exported));
          }
        }
      }
      if (
        statement.type === "ExportAllDeclaration" &&
        statement.exportKind !== "type"
      ) {
        this.errors.add(
          `Unresolved dynamic namespace re-export in ${target.fileName}`,
        );
      }
      if (
        statement.type === "TSExportAssignment" ||
        statement.type === "ExportDefaultDeclaration"
      ) {
        this.trace(
          statement.type === "TSExportAssignment"
            ? statement.expression
            : statement.declaration,
          true,
        );
      }
      if (
        statement.type === "ExportNamedDeclaration" &&
        statement.declaration !== null
      ) {
        if (statement.declaration.type === "VariableDeclaration") {
          for (const declaration of statement.declaration.declarations) {
            this.trace(declaration, true);
          }
        } else {
          this.trace(statement.declaration, true);
        }
      }
    }
    return;
  };

  private readonly checkFactoryAliases = (node: Node) => {
    const file = this.fileOf(node).fileName;
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      const definition = this.value(node.callee);
      if (
        definition instanceof Binding &&
        definition.kind === "import" &&
        definition.importedName !== undefined &&
        FACTORY.test(definition.importedName) &&
        !FACTORY.test(node.callee.name)
      ) {
        this.errors.add(`Aliased safe factory cannot be enumerated in ${file}`);
      }
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.property.type === "Identifier" &&
      FACTORY.test(node.callee.property.name)
    ) {
      this.errors.add(`Namespace safe factory cannot be enumerated in ${file}`);
    }
  };
  private readonly isDeclared = (first: Node | undefined, subject: boolean) => {
    const config =
      subject && first?.type === "ObjectExpression"
        ? first.properties.find(
            (item) => isPropertyAssignment(item) && keyName(item) === "config",
          )
        : first;
    const configValue = isPropertyAssignment(config) ? config.value : config;
    const delivery = this.field(configValue, "contentDelivery");
    const type = propertyName(this.field(delivery, "type"));
    const reason = propertyName(this.field(delivery, "reason"));
    return (
      type === "audited" ||
      ((type === "public" || type === "none") && !!reason?.trim())
    );
  };
  private readonly inspectFactory = (node: Node) => {
    const file = this.fileOf(node).fileName;
    this.checkFactoryAliases(node);
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "Identifier" ||
      !FACTORY.test(node.callee.name)
    ) {
      return;
    }
    const first = node.arguments.at(0);
    const subject = node.callee.name.includes("Subject");
    const declared = this.isDeclared(first, subject);
    this.terminals = new Set<string>();
    this.visited = new Set<Traced>();
    if (subject && first?.type === "ObjectExpression") {
      for (const item of first.properties) {
        if (isPropertyAssignment(item) && keyName(item) !== "config") {
          this.trace(item.value);
        }
      }
    } else {
      const callback = node.arguments.at(1);
      if (!callback) {
        this.errors.add(`Missing callback in ${file}`);
      } else {
        this.trace(callback, true);
      }
    }
    let binding = "inline";
    const parent = this.parents.get(node);
    if (parent?.type === "VariableDeclarator") {
      binding = propertyName(parent.id) ?? "inline";
    } else if (
      parent?.type === "ExportDefaultDeclaration" ||
      parent?.type === "TSExportAssignment"
    ) {
      binding = "default";
    }
    if (this.terminals.size > 0) {
      this.candidates.push({
        file,
        binding,
        line: this.lineOf(node),
        terminals: [...this.terminals].toSorted(),
        declared,
      });
    }
  };

  analyze = () => {
    for (const file of this.options.files) {
      const source = this.load(file);
      if (source) {
        walk(source.program, (node) => {
          if (!this.runtime(node)) {
            return "skip-children";
          }
          this.inspectFactory(node);
          return undefined;
        });
      }
    }
    return { candidates: this.candidates, errors: [...this.errors].toSorted() };
  };
}

/** Trace runtime references, not module imports: an unused reader is not delivery. */
export const analyzeContentDelivery = (
  options: AnalyzeContentDeliveryOptions,
) => new ContentDeliveryInspector(options).analyze();

export const discoveryFailures = ({
  files,
  importErrors,
}: SafeHandlerDiscovery) => [
  ...importErrors.map(({ id, message }) => `Import failed ${id}: ${message}`),
  ...findHiddenEndpointMismatches({
    files,
    allowlist: INLINE_ENDPOINT_ALLOWLIST,
  }).map(({ id }) => `Hidden endpoint in ${id}`),
  ...findStaleAllowlistEntries({
    files,
    allowlist: INLINE_ENDPOINT_ALLOWLIST,
  }).map((id) => `Stale inline endpoint allowance ${id}`),
];

export const selfTestContentDelivery = () => {
  const result = analyzeContentDelivery({
    files: ["/route.ts"],
    readFile: () =>
      'import { readS3ArrayBuffer as read } from "@/api/lib/s3"; export default createSafeHandler({}, () => read("key"));',
    resolveImport: () => "/apps/api/src/lib/s3.ts",
  });
  if (
    result.errors.length ||
    result.candidates.length !== 1 ||
    result.candidates.at(0)?.declared !== false
  ) {
    panic(
      "content-delivery self-test failed to detect an undeclared byte route",
    );
  }
};

if (import.meta.main && Bun.argv.includes("--self-test")) {
  selfTestContentDelivery();
  console.log("content-delivery-guard self-test passed");
} else if (import.meta.main) {
  const discovery = await discoverSafeHandlers();
  const result = analyzeContentDelivery({
    // AST-only scan shares the discovery glob without importing helper scripts;
    // it also catches aliased factories the runtime text prefilter cannot see.
    files: [
      ...new Bun.Glob(HANDLERS_GLOB).scanSync({
        cwd: REPO_ROOT,
        absolute: true,
      }),
    ]
      .filter((file) => !file.endsWith(".test.ts"))
      .toSorted(),
    readFile: (file) =>
      existsSync(file) ? readFileSync(file, "utf-8") : undefined,
    resolveImport: (specifier, from) => {
      let base: string | undefined;
      if (specifier.startsWith("@/api/")) {
        base = path.join(REPO_ROOT, "apps/api/src", specifier.slice(6));
      } else if (specifier.startsWith(".")) {
        base = path.resolve(path.dirname(from), specifier);
      }
      if (!base) {
        return undefined;
      }
      return [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        path.join(base, "index.ts"),
      ].find(
        (file) =>
          existsSync(file) &&
          statSync(file).isFile() &&
          /\.[cm]?[jt]sx?$/u.test(file),
      );
    },
  });
  const failures = [
    ...discoveryFailures(discovery),
    ...result.errors,
    ...result.candidates
      .filter(({ declared }) => !declared)
      .map(
        ({ file, line, binding }) =>
          `Missing contentDelivery: ${repoRelativePath(REPO_ROOT, file)}:${line} (${binding})`,
      ),
  ];
  for (const { file, line, binding, terminals } of result.candidates) {
    console.log(
      `${repoRelativePath(REPO_ROOT, file)}:${line} (${binding}): ${terminals.join(", ")}`,
    );
  }
  for (const failure of failures) {
    console.error(failure);
  }
  console.log(
    `content-delivery-guard: ${result.candidates.length} delivery callbacks, ${failures.length} failures`,
  );
  process.exit(failures.length > 0 ? 1 : 0);
}
