import { panic } from "better-result";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";
import {
  type ArrowFunctionExpression,
  type CallExpression,
  type Function as FunctionNode,
  type ImportExpression,
  isObjectLiteralProperty,
  type JSXAttribute,
  type JSXElementName,
  type JSXOpeningElement,
  type ModuleExportName,
  type Node,
  type ObjectProperty,
  type ParsedSource,
  parseSource,
  type Statement,
  type StaticImportEntry,
  walk,
} from "@stll/scripts/src/syntax-tree";

// These boundaries install the first frame; their descendants already have one.
export const FIRST_FRAME_OWNERS = [
  {
    file: "routes/__root.tsx",
    kind: "pendingComponent",
    reason: "Root first load, before AppFrameHost mounts",
  },
  {
    file: "routes/-app-frame-host.tsx",
    kind: "Suspense",
    component: "ProtectedPendingSkeleton",
    reason: "Lazy first member/public frame, before its chrome mounts",
  },
  {
    file: "routes/law/route.tsx",
    kind: "pendingComponent",
    reason:
      "AppFrameHost selects none for law; this layout owns its only shell",
  },
] as const;

type Boundary = {
  file: string;
  line: number;
  kind: "pendingComponent" | "defaultPendingComponent" | "Suspense";
  expression: Node;
};
type Module = {
  source: ParsedSource | undefined;
  definitions: Map<string, Node>;
  imports: Map<string, { module: string; name: string }>;
  exports: Map<string, { module: string; name: string }>;
  exportStars: string[];
};

const SHELL_SYMBOLS = new Set([
  "Sidebar",
  "SidebarHeader",
  "AppSidebar",
  "WorkspaceShell",
  "WorkspaceFrame",
  "PublicWorkspaceShell",
  "StellaWordmark",
  "StellaWordmarkLatin",
  "StellaWordmarkArabic",
  "StellaMark",
]);
const LOGO_LOADER_MODULE = "@stll/ui/loader";
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/u;
// TypeScript-only syntax that still holds expressions or bindings; every
// other `TS*` node is a type, which never renders a fallback.
const TYPE_SYNTAX_WITH_VALUES = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSParameterProperty",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "TSTypeParameter",
  "TSTypeParameterDeclaration",
]);

const isTypeSyntax = (node: Node) =>
  node.type.startsWith("TS") && !TYPE_SYNTAX_WITH_VALUES.has(node.type);

const childNodes = (node: Node): Node[] => {
  const children: Node[] = [];
  walk(node, (child) => {
    if (child === node) {
      return "visit";
    }
    children.push(child);
    return "skip-children";
  });
  return children;
};

/** Object and class methods, getters, setters and constructors hold their
 * function as a value; the walk treats them as members, not as functions. */
const isMethodHolder = (node: Node | undefined) =>
  node?.type === "MethodDefinition" ||
  node?.type === "TSAbstractMethodDefinition" ||
  (node?.type === "Property" && (node.method || node.kind !== "init"));

/** Whether a scan of a function body stops here: nested functions own their
 * declarations and returns, while member bodies stay part of the scan. */
const opensFunctionScope = (node: Node, parent: Node | undefined) =>
  node.type === "FunctionDeclaration" ||
  node.type === "TSDeclareFunction" ||
  node.type === "ArrowFunctionExpression" ||
  (node.type === "FunctionExpression" && !isMethodHolder(parent));

const importedName = (entry: StaticImportEntry) => {
  // oxc-parser declares ImportNameKind as an ambient const enum of strings.
  const kind: string = entry.importName.kind;
  if (kind === "Default") {
    return "default";
  }
  if (kind === "NamespaceObject") {
    return "*";
  }
  return entry.importName.name ?? entry.localName.value;
};

/** The binding a callback's first parameter introduces, defaulted or rest. */
const firstParameterName = ({ params }: ArrowFunctionExpression) => {
  let binding: Node | undefined = params.at(0);
  if (binding?.type === "AssignmentPattern") {
    binding = binding.left;
  } else if (binding?.type === "RestElement") {
    binding = binding.argument;
  }
  return binding?.type === "Identifier" ? binding.name : undefined;
};

const propertyKeyName = ({ key }: ObjectProperty) => {
  if (key.type === "Identifier") {
    return key.name;
  }
  return key.type === "Literal" && typeof key.value === "string"
    ? key.value
    : undefined;
};

const identifierName = (node: Node): string | undefined => {
  if (node.type === "Identifier") {
    return node.name;
  }
  return node.type === "JSXIdentifier" && node.name !== "this"
    ? node.name
    : undefined;
};

/** `object.name` with a plain identifier receiver, in code or a JSX tag. */
const namedAccess = (
  node: Node,
): { object: string; name: string } | undefined => {
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier"
  ) {
    return {
      object: node.object.name,
      name:
        node.property.type === "PrivateIdentifier"
          ? `#${node.property.name}`
          : node.property.name,
    };
  }
  if (
    node.type === "JSXMemberExpression" &&
    node.object.type === "JSXIdentifier" &&
    node.object.name !== "this"
  ) {
    return { object: node.object.name, name: node.property.name };
  }
  return undefined;
};

const elementName = (node: JSXElementName): string => {
  if (node.type === "JSXIdentifier") {
    return node.name;
  }
  if (node.type === "JSXNamespacedName") {
    return `${node.namespace.name}:${node.name.name}`;
  }
  return `${elementName(node.object)}.${node.property.name}`;
};

const attributeName = ({ name }: JSXAttribute) =>
  name.type === "JSXIdentifier"
    ? name.name
    : `${name.namespace.name}:${name.name.name}`;

/** A JSX attribute's string value, written bare or inside braces. */
const attributeString = ({ value }: JSXAttribute) => {
  const expression =
    value?.type === "JSXExpressionContainer" ? value.expression : value;
  return expression?.type === "Literal" && typeof expression.value === "string"
    ? expression.value
    : undefined;
};

const exportName = (node: ModuleExportName) =>
  node.type === "Literal" ? node.value : node.name;

class FallbackSymbols {
  private readonly modules = new Map<string, Module>();
  private readonly srcDirectory: string;
  constructor(srcDirectory: string) {
    this.srcDirectory = srcDirectory;
  }
  resolveModule(file: string, specifier: string) {
    if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
      return undefined;
    }
    const base = specifier.startsWith("@/")
      ? path.join(this.srcDirectory, specifier.slice(2))
      : path.resolve(path.dirname(file), specifier);
    for (const candidate of [
      base,
      `${base}.tsx`,
      `${base}.ts`,
      path.join(base, "index.tsx"),
      path.join(base, "index.ts"),
    ]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    }
    return panic(`Unresolved fallback dependency: ${specifier} from ${file}`);
  }
  load(file: string): Module {
    const cached = this.modules.get(file);
    if (cached) {
      return cached;
    }
    // Stylesheets, images and data files declare no components.
    const source = SCRIPT_FILE.test(file)
      ? parseSource(file, readFileSync(file, "utf-8"))
      : undefined;
    const module: Module = {
      source,
      definitions: new Map(),
      imports: new Map(),
      exports: new Map(),
      exportStars: [],
    };
    this.modules.set(file, module);
    if (source === undefined) {
      return module;
    }
    for (const { moduleRequest, entries } of source.module.staticImports) {
      for (const entry of entries) {
        if (entry.isType) {
          continue;
        }
        module.imports.set(entry.localName.value, {
          module: moduleRequest.value,
          name: importedName(entry),
        });
      }
    }
    for (const statement of source.program.body) {
      this.indexDefinition(statement, module);
      this.indexExport(statement, module);
    }
    return module;
  }
  indexDefinition(node: Node, module: Module) {
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        this.indexDefinition(node.declaration, module);
      }
      return;
    }
    if (node.type === "ExportDefaultDeclaration") {
      const declaration = node.declaration;
      if (
        declaration.type === "FunctionDeclaration" ||
        declaration.type === "TSDeclareFunction"
      ) {
        if (declaration.id) {
          module.definitions.set(declaration.id.name, declaration);
        }
        module.definitions.set("default", declaration);
      } else if (
        declaration.type !== "ClassDeclaration" &&
        declaration.type !== "TSInterfaceDeclaration"
      ) {
        module.definitions.set("default", declaration);
      }
      return;
    }
    if (node.type === "TSExportAssignment") {
      module.definitions.set("default", node.expression);
      return;
    }
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "TSDeclareFunction"
    ) {
      if (node.id) {
        module.definitions.set(node.id.name, node);
      }
      return;
    }
    if (node.type !== "VariableDeclaration") {
      return;
    }
    for (const declaration of node.declarations) {
      if (declaration.id.type === "Identifier" && declaration.init) {
        module.definitions.set(declaration.id.name, declaration.init);
      }
    }
  }
  indexExport(node: Statement, module: Module) {
    if (node.type === "ExportAllDeclaration") {
      // `export * as name` re-exports a namespace; follow it like `export *`.
      if (node.exportKind !== "type") {
        module.exportStars.push(node.source.value);
      }
      return;
    }
    if (
      node.type !== "ExportNamedDeclaration" ||
      node.declaration ||
      node.exportKind === "type"
    ) {
      return;
    }
    for (const { exportKind, exported, local } of node.specifiers) {
      if (exportKind === "type") {
        continue;
      }
      module.exports.set(exportName(exported), {
        module: node.source?.value ?? "",
        name: exportName(local),
      });
    }
  }
  inspectSymbol(file: string, name: string, visited: Set<string>): string[] {
    const key = `${file}#${name}`;
    if (visited.has(key)) {
      return [];
    }
    visited.add(key);
    const module = this.load(file);
    const imported = module.imports.get(name) ?? module.exports.get(name);
    // `export { Name }` names a local binding: inspect its definition below
    // instead of following the export back to the key already visited.
    const localSelfExport =
      imported !== undefined && !imported.module && imported.name === name;
    if (imported && !localSelfExport) {
      if (imported.module === LOGO_LOADER_MODULE) {
        return [`${imported.module}#${imported.name}`];
      }
      if (SHELL_SYMBOLS.has(imported.name)) {
        return [`${imported.module}#${imported.name}`];
      }
      const target = imported.module
        ? this.resolveModule(file, imported.module)
        : file;
      return target ? this.inspectSymbol(target, imported.name, visited) : [];
    }
    const definition = module.definitions.get(name);
    if (definition) {
      return this.inspectNode(file, definition, visited);
    }
    const findings: string[] = [];
    for (const specifier of module.exportStars) {
      const target = this.resolveModule(file, specifier);
      if (target) {
        findings.push(...this.inspectSymbol(target, name, visited));
      }
    }
    return findings;
  }
  inspectNode(
    file: string,
    node: Node,
    visited: Set<string>,
    locals = new Map<string, Node>(),
  ): string[] {
    if (isTypeSyntax(node) || node.type === "JSXClosingElement") {
      return [];
    }
    if (node.type === "JSXOpeningElement" && this.isInlineLoader(file, node)) {
      return [];
    }
    if (node.type === "JSXAttribute") {
      return this.inspectAttribute(file, node, visited, locals);
    }
    const access = namedAccess(node);
    if (access) {
      return this.inspectPropertyAccess(file, access, visited);
    }
    if (node.type === "ImportExpression") {
      return this.inspectLazyModule(file, node, visited);
    }
    if (node.type === "CallExpression") {
      const constructed = this.inspectReactElement(file, node, visited, locals);
      if (constructed) {
        return constructed;
      }
      const named = this.inspectNamedImport(file, node, visited);
      if (named) {
        return named;
      }
      return this.inspectRenderCall(file, node, visited, locals);
    }
    if (node.type === "Property") {
      if (isMethodHolder(node)) {
        return this.inspectMember(file, node, visited, locals);
      }
      // An object entry renders its value; a shorthand entry is its own value.
      return this.inspectNode(file, node.value, visited, locals);
    }
    if (
      node.type === "MethodDefinition" ||
      node.type === "TSAbstractMethodDefinition"
    ) {
      return this.inspectMember(file, node, visited, locals);
    }
    if (node.type === "ObjectPattern") {
      return node.properties.flatMap((property) =>
        property.type === "Property" && !property.shorthand
          ? [
              ...this.inspectNode(file, property.key, visited, locals),
              ...this.inspectNode(file, property.value, visited, locals),
            ]
          : this.inspectNode(file, property, visited, locals),
      );
    }
    const name = identifierName(node);
    if (name !== undefined) {
      const local = locals.get(name);
      if (local) {
        const key = `${file}:${local.start}`;
        if (visited.has(key)) {
          return [];
        }
        visited.add(key);
        return this.inspectNode(file, local, visited, locals);
      }
      return this.inspectSymbol(file, name, visited);
    }
    // Member functions never get here: inspectMember walks them.
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionExpression"
    ) {
      return this.inspectFunction(file, node, visited, locals);
    }
    const findings: string[] = [];
    for (const child of childNodes(node)) {
      // A heritage clause names a type, never a rendered component.
      if (
        (node.type === "ClassDeclaration" || node.type === "ClassExpression") &&
        child === node.superClass
      ) {
        continue;
      }
      findings.push(...this.inspectNode(file, child, visited, locals));
    }
    return findings;
  }
  inspectLazyModule(
    file: string,
    node: ImportExpression,
    visited: Set<string>,
  ): string[] {
    const specifier = node.source;
    if (specifier.type !== "Literal" || typeof specifier.value !== "string") {
      return [];
    }
    if (specifier.value === LOGO_LOADER_MODULE) {
      return [`${specifier.value}#default`];
    }
    const target = this.resolveModule(file, specifier.value);
    return target ? this.inspectSymbol(target, "default", visited) : [];
  }
  /** Walks a member's key, then its function's parameters and body as plain
   * syntax rather than as a component's returned elements. */
  inspectMember(
    file: string,
    { key, value }: { key: Node; value: Node },
    visited: Set<string>,
    locals: Map<string, Node>,
  ): string[] {
    const findings = this.inspectNode(file, key, visited, locals);
    if (value.type !== "FunctionExpression") {
      return [...findings, ...this.inspectNode(file, value, visited, locals)];
    }
    for (const child of [value.typeParameters, ...value.params, value.body]) {
      if (child) {
        findings.push(...this.inspectNode(file, child, visited, locals));
      }
    }
    return findings;
  }
  inspectPropertyAccess(
    file: string,
    access: { object: string; name: string },
    visited: Set<string>,
  ): string[] {
    const imported = this.load(file).imports.get(access.object);
    if (imported?.module === LOGO_LOADER_MODULE) {
      return [`${imported.module}#${access.name}`];
    }
    if (imported?.name === "*") {
      if (SHELL_SYMBOLS.has(access.name)) {
        return [`${imported.module}#${access.name}`];
      }
      const target = this.resolveModule(file, imported.module);
      return target ? this.inspectSymbol(target, access.name, visited) : [];
    }
    // Data/query members in JSX props are not rendered component symbols.
    return [];
  }
  inspectFunction(
    file: string,
    node: FunctionNode | ArrowFunctionExpression,
    visited: Set<string>,
    locals: Map<string, Node>,
  ): string[] {
    const findings: string[] = [];
    const body = node.body;
    if (!body) {
      return findings;
    }
    if (body.type !== "BlockStatement") {
      return this.inspectNode(file, body, visited, locals);
    }
    const scopedLocals = new Map(locals);
    walk(body, (child, ancestors) => {
      if (
        child.type === "VariableDeclarator" &&
        child.id.type === "Identifier" &&
        child.init
      ) {
        scopedLocals.set(child.id.name, child.init);
      }
      if (
        child.type === "FunctionDeclaration" ||
        child.type === "TSDeclareFunction"
      ) {
        if (child.id) {
          scopedLocals.set(child.id.name, child);
        }
        return "skip-children";
      }
      return opensFunctionScope(child, ancestors.at(-1))
        ? "skip-children"
        : "visit";
    });
    walk(body, (child, ancestors) => {
      if (child.type === "ReturnStatement" && child.argument) {
        findings.push(
          ...this.inspectNode(file, child.argument, visited, scopedLocals),
        );
        return "skip-children";
      }
      return opensFunctionScope(child, ancestors.at(-1))
        ? "skip-children"
        : "visit";
    });
    return findings;
  }
  inspectAttribute(
    file: string,
    node: JSXAttribute,
    visited: Set<string>,
    locals: Map<string, Node>,
  ): string[] {
    const name = attributeName(node);
    if (name === "data-slot" && attributeString(node) === "sidebar") {
      return ["DOM#data-slot=sidebar"];
    }
    if (/^on[A-Z]/u.test(name)) {
      return [];
    }
    return node.value
      ? this.inspectNode(file, node.value, visited, locals)
      : [];
  }
  isCanonicalLoader(file: string, name: string, visited: Set<string>): boolean {
    const key = `${file}#${name}`;
    if (visited.has(key)) {
      return false;
    }
    visited.add(key);
    const module = this.load(file);
    const imported = module.imports.get(name) ?? module.exports.get(name);
    // `export { Name }` names a local binding: inspect its definition below
    // instead of following the export back to the key already visited.
    const localSelfExport =
      imported !== undefined && !imported.module && imported.name === name;
    if (imported && !localSelfExport) {
      if (imported.module === LOGO_LOADER_MODULE) {
        return imported.name === "Loader";
      }
      const target = imported.module
        ? this.resolveModule(file, imported.module)
        : file;
      return (
        target !== undefined &&
        this.isCanonicalLoader(target, imported.name, visited)
      );
    }
    const definition = module.definitions.get(name);
    if (definition?.type === "Identifier") {
      return this.isCanonicalLoader(file, definition.name, visited);
    }
    for (const specifier of module.exportStars) {
      const target = this.resolveModule(file, specifier);
      if (target && this.isCanonicalLoader(target, name, visited)) {
        return true;
      }
    }
    return false;
  }
  isInlineLoader(file: string, node: JSXOpeningElement): boolean {
    const attributes: JSXAttribute[] = [];
    for (const attribute of node.attributes) {
      if (attribute.type === "JSXSpreadAttribute") {
        return false;
      }
      attributes.push(attribute);
    }
    const sizes = attributes.filter(
      (attribute) => attributeName(attribute) === "size",
    );
    const size = sizes.at(0);
    if (sizes.length !== 1 || !size || attributeString(size) !== "sm") {
      return false;
    }
    // The owner defines sm as progress next to a control; md/lg occupy a region.
    const tag = identifierName(node.name);
    if (tag !== undefined) {
      return this.isCanonicalLoader(file, tag, new Set());
    }
    const access = namedAccess(node.name);
    if (!access) {
      return false;
    }
    const imported = this.load(file).imports.get(access.object);
    if (!imported) {
      return false;
    }
    if (imported.module === LOGO_LOADER_MODULE) {
      return access.name === "Loader";
    }
    const target = this.resolveModule(file, imported.module);
    return (
      target !== undefined &&
      this.isCanonicalLoader(target, access.name, new Set())
    );
  }
  inspectRenderCall(
    file: string,
    node: CallExpression,
    visited: Set<string>,
    locals: Map<string, Node>,
  ): string[] {
    const findings = this.inspectNode(file, node.callee, visited, locals);
    for (const argument of node.arguments) {
      if (
        argument.type === "ArrowFunctionExpression" ||
        argument.type === "FunctionExpression" ||
        argument.type === "JSXElement" ||
        argument.type === "JSXFragment"
      ) {
        findings.push(...this.inspectNode(file, argument, visited, locals));
      }
    }
    return findings;
  }
  inspectReactElement(
    file: string,
    node: CallExpression,
    visited: Set<string>,
    locals: Map<string, Node>,
  ): string[] | undefined {
    const module = this.load(file);
    const callee = identifierName(node.callee);
    const named = callee === undefined ? undefined : module.imports.get(callee);
    const access = namedAccess(node.callee);
    const namespace = access ? module.imports.get(access.object) : undefined;
    const isCreateElement =
      (named?.module === "react" && named.name === "createElement") ||
      (namespace?.module === "react" && access?.name === "createElement");
    if (!isCreateElement) {
      return undefined;
    }
    const findings: string[] = [];
    for (const argument of node.arguments) {
      findings.push(...this.inspectNode(file, argument, visited, locals));
    }
    return findings;
  }
  inspectNamedImport(
    file: string,
    node: CallExpression,
    visited: Set<string>,
  ): string[] | undefined {
    const callee = node.callee;
    if (
      callee.type !== "MemberExpression" ||
      callee.computed ||
      callee.property.name !== "then" ||
      callee.object.type !== "ImportExpression"
    ) {
      return undefined;
    }
    const specifier = callee.object.source;
    const callback = node.arguments.at(0);
    if (
      callback?.type !== "ArrowFunctionExpression" ||
      specifier.type !== "Literal" ||
      typeof specifier.value !== "string"
    ) {
      return undefined;
    }
    const binding = firstParameterName(callback);
    if (binding === undefined) {
      return undefined;
    }
    if (specifier.value === LOGO_LOADER_MODULE) {
      return [`${specifier.value}#Loader`];
    }
    const target = this.resolveModule(file, specifier.value);
    const findings: string[] = [];
    walk(callback.body, (child) => {
      const access = namedAccess(child);
      if (target && access?.object === binding) {
        findings.push(...this.inspectSymbol(target, access.name, visited));
      }
    });
    return findings;
  }
}

export const checkRouteFallbacks = (sourceDirectory: string) => {
  const srcDirectory = path.resolve(sourceDirectory);
  const symbols = new FallbackSymbols(srcDirectory);
  const boundaries: Boundary[] = [];
  const addBoundary = (
    file: string,
    source: ParsedSource,
    kind: Boundary["kind"],
    expression: Node,
  ) => {
    boundaries.push({
      file: repoRelativePath(srcDirectory, file),
      kind,
      expression,
      line: source.locate(expression.start).line,
    });
  };
  const routeTreeFile = path.join(srcDirectory, "routeTree.gen.ts");
  const routeTree = symbols.load(routeTreeFile);
  const registeredRoutes = new Set<string>();
  for (const imported of routeTree.imports.values()) {
    if (imported.name !== "Route" || !imported.module.startsWith("./routes/")) {
      continue;
    }
    const file = symbols.resolveModule(routeTreeFile, imported.module);
    if (file) {
      registeredRoutes.add(file);
    }
  }
  if (registeredRoutes.size === 0) {
    panic("Route fallback census found no registered routes");
  }
  const collect = (file: string) => {
    const source = symbols.load(file).source;
    if (source === undefined) {
      return;
    }
    walk(source.program, (node, ancestors) => {
      if (
        isObjectLiteralProperty(node, ancestors.at(-1)) &&
        !node.method &&
        !node.shorthand &&
        !node.computed &&
        node.kind === "init"
      ) {
        const name = propertyKeyName(node);
        if (name === "pendingComponent" && registeredRoutes.has(file)) {
          addBoundary(file, source, name, node.value);
        }
        if (
          name === "defaultPendingComponent" &&
          file === path.join(srcDirectory, "router.tsx")
        ) {
          addBoundary(file, source, name, node.value);
        }
      }
      if (node.type === "JSXOpeningElement") {
        const name = elementName(node.name);
        const tag = identifierName(node.name);
        const imported =
          tag === undefined ? undefined : symbols.load(file).imports.get(tag);
        const access = namedAccess(node.name);
        const namespace = access
          ? symbols.load(file).imports.get(access.object)
          : undefined;
        const namespacedSuspense =
          node.name.type === "JSXMemberExpression" &&
          node.name.property.name === "Suspense" &&
          namespace?.module === "react";
        if (
          namespacedSuspense ||
          name === "Suspense" ||
          (imported?.module === "react" && imported.name === "Suspense")
        ) {
          for (const attribute of node.attributes) {
            if (
              attribute.type === "JSXAttribute" &&
              attributeName(attribute) === "fallback" &&
              attribute.value
            ) {
              addBoundary(file, source, "Suspense", attribute.value);
            }
          }
        }
      }
    });
  };
  const routeFiles = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        routeFiles(file);
      } else if (
        /\.tsx?$/u.test(entry.name) &&
        !/\.(test|logic)\./u.test(entry.name)
      ) {
        collect(file);
      }
    }
  };
  routeFiles(path.join(srcDirectory, "routes"));
  collect(path.join(srcDirectory, "router.tsx"));
  const census = boundaries.map(({ expression, ...boundary }) => {
    const owner = FIRST_FRAME_OWNERS.find((candidate) => {
      if (
        candidate.file !== boundary.file ||
        candidate.kind !== boundary.kind
      ) {
        return false;
      }
      if (!("component" in candidate)) {
        return true;
      }
      return (
        expression.type === "JSXExpressionContainer" &&
        expression.expression.type === "JSXElement" &&
        expression.expression.openingElement.selfClosing &&
        elementName(expression.expression.openingElement.name) ===
          candidate.component &&
        expression.expression.openingElement.attributes.length === 0
      );
    });
    const chrome = [
      ...new Set(
        symbols.inspectNode(
          path.join(srcDirectory, boundary.file),
          expression,
          new Set(),
        ),
      ),
    ];
    return { ...boundary, chrome, exception: owner?.reason };
  });
  return {
    registeredRoutes: registeredRoutes.size,
    census,
    violations: census.filter(
      ({ chrome, exception }) => chrome.length > 0 && !exception,
    ),
  };
};
