import { panic } from "better-result";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";
import {
  type ArrowFunctionExpression,
  type CallExpression,
  type ExportAllDeclaration,
  type ExportNamedDeclaration,
  type Function as OxcFunction,
  type ImportDeclaration,
  type JSXAttribute,
  type JSXMemberExpression,
  type JSXOpeningElement,
  type MemberExpression,
  type Node,
  type ParsedSource,
  parseSource,
  type TSType,
  walk,
} from "@stll/scripts/src/syntax-tree";

const TYPE_NODES = {
  TSAnyKeyword: true,
  TSBigIntKeyword: true,
  TSBooleanKeyword: true,
  TSIntrinsicKeyword: true,
  TSNeverKeyword: true,
  TSNullKeyword: true,
  TSNumberKeyword: true,
  TSObjectKeyword: true,
  TSStringKeyword: true,
  TSSymbolKeyword: true,
  TSUndefinedKeyword: true,
  TSUnknownKeyword: true,
  TSVoidKeyword: true,
  TSArrayType: true,
  TSConditionalType: true,
  TSConstructorType: true,
  TSFunctionType: true,
  TSImportType: true,
  TSIndexedAccessType: true,
  TSInferType: true,
  TSIntersectionType: true,
  TSLiteralType: true,
  TSMappedType: true,
  TSNamedTupleMember: true,
  TSTemplateLiteralType: true,
  TSThisType: true,
  TSTupleType: true,
  TSTypeLiteral: true,
  TSTypeOperator: true,
  TSTypePredicate: true,
  TSTypeQuery: true,
  TSTypeReference: true,
  TSUnionType: true,
  TSParenthesizedType: true,
  TSJSDocNullableType: true,
  TSJSDocNonNullableType: true,
  TSJSDocUnknownType: true,
} as const satisfies Record<TSType["type"], true>;

const visitChildren = (node: Node, visit: (child: Node) => void) => {
  walk(node, (child) => {
    if (child === node) {
      return undefined;
    }
    visit(child);
    return "skip-children";
  });
};
const nameOf = (node: Node): string => {
  const name: unknown = Reflect.get(node, "name");
  return typeof name === "string" ? name : String(Reflect.get(node, "value"));
};

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
  source: ParsedSource & { fileName: string };
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
    const source = {
      ...parseSource(file, readFileSync(file, "utf-8")),
      fileName: file,
    };
    const module: Module = {
      source,
      definitions: new Map(),
      imports: new Map(),
      exports: new Map(),
      exportStars: [],
    };
    this.modules.set(file, module);
    for (const statement of source.program.body) {
      this.indexDefinition(statement, module);
      if (statement.type === "ImportDeclaration") {
        this.indexImport(statement, module);
      }
      if (
        statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportAllDeclaration"
      ) {
        this.indexExport(statement, module);
      }
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
      module.definitions.set("default", node.declaration);
      if (
        node.declaration.type === "FunctionDeclaration" &&
        node.declaration.id
      ) {
        module.definitions.set(node.declaration.id.name, node.declaration);
      }
      return;
    }
    if (node.type === "FunctionDeclaration") {
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
  indexImport(node: ImportDeclaration, module: Module) {
    if (node.importKind === "type") {
      return;
    }
    for (const binding of node.specifiers) {
      if (binding.type === "ImportSpecifier" && binding.importKind === "type") {
        continue;
      }
      let name = "*";
      if (binding.type === "ImportSpecifier") {
        name = nameOf(binding.imported);
      }
      if (binding.type === "ImportDefaultSpecifier") {
        name = "default";
      }
      module.imports.set(binding.local.name, {
        module: node.source.value,
        name,
      });
    }
  }
  indexExport(
    node: ExportNamedDeclaration | ExportAllDeclaration,
    module: Module,
  ) {
    if (node.exportKind === "type") {
      return;
    }
    const specifier = node.source?.value ?? "";
    if (node.type === "ExportNamedDeclaration") {
      for (const exported of node.specifiers) {
        if (exported.exportKind === "type") {
          continue;
        }
        module.exports.set(nameOf(exported.exported), {
          module: specifier,
          name: nameOf(exported.local),
        });
      }
      return;
    }
    if (specifier) {
      module.exportStars.push(specifier);
    }
  }
  text(file: string, node: Node) {
    return this.load(file).source.sourceText.slice(node.start, node.end);
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
    if (
      node.type === "TSTypeAnnotation" ||
      Object.hasOwn(TYPE_NODES, node.type)
    ) {
      return [];
    }
    if (node.type === "JSXClosingElement") {
      return [];
    }
    if (node.type === "JSXOpeningElement" && this.isInlineLoader(file, node)) {
      return [];
    }
    if (node.type === "JSXAttribute") {
      return this.inspectAttribute(file, node, visited, locals);
    }
    if (
      node.type === "JSXMemberExpression" &&
      node.object.type === "JSXIdentifier"
    ) {
      return this.inspectJsxMember(file, node, visited);
    }

    if (
      node.type === "MemberExpression" &&
      !node.computed &&
      node.object.type === "Identifier"
    ) {
      return this.inspectPropertyAccess(file, node, visited);
    }
    if (node.type === "ImportExpression") {
      const specifier = node.source;
      if (specifier.type === "Literal" && typeof specifier.value === "string") {
        if (specifier.value === LOGO_LOADER_MODULE) {
          return [`${specifier.value}#default`];
        }
        const target = this.resolveModule(file, specifier.value);
        return target ? this.inspectSymbol(target, "default", visited) : [];
      }
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
      return this.inspectNode(file, node.value, visited, locals);
    }
    if (node.type === "Identifier" || node.type === "JSXIdentifier") {
      const local = locals.get(node.name);
      if (local) {
        const key = `${file}:${local.start}`;
        if (visited.has(key)) {
          return [];
        }
        visited.add(key);
        return this.inspectNode(file, local, visited, locals);
      }
      return this.inspectSymbol(file, node.name, visited);
    }
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionExpression"
    ) {
      return this.inspectFunction(file, node, visited, locals);
    }
    const findings: string[] = [];
    visitChildren(node, (child) => {
      findings.push(...this.inspectNode(file, child, visited, locals));
    });
    return findings;
  }
  inspectJsxMember(
    file: string,
    node: JSXMemberExpression,
    visited: Set<string>,
  ): string[] {
    if (node.object.type !== "JSXIdentifier") {
      return [];
    }
    const imported = this.load(file).imports.get(node.object.name);
    if (
      imported?.module === LOGO_LOADER_MODULE ||
      (imported?.name === "*" && SHELL_SYMBOLS.has(node.property.name))
    ) {
      return [`${imported.module}#${node.property.name}`];
    }
    if (imported?.name !== "*") {
      return [];
    }
    const target = this.resolveModule(file, imported.module);
    return target
      ? this.inspectSymbol(target, node.property.name, visited)
      : [];
  }
  inspectPropertyAccess(
    file: string,
    node: MemberExpression,
    visited: Set<string>,
  ): string[] {
    if (
      node.object.type !== "Identifier" ||
      node.computed ||
      node.property.type !== "Identifier"
    ) {
      return [];
    }
    const imported = this.load(file).imports.get(node.object.name);
    if (imported?.module === LOGO_LOADER_MODULE) {
      return [`${imported.module}#${nameOf(node.property)}`];
    }
    if (imported?.name === "*") {
      if (SHELL_SYMBOLS.has(nameOf(node.property))) {
        return [`${imported.module}#${nameOf(node.property)}`];
      }
      const target = this.resolveModule(file, imported.module);
      return target
        ? this.inspectSymbol(target, nameOf(node.property), visited)
        : [];
    }
    // Data/query members in JSX props are not rendered component symbols.
    return [];
  }
  inspectFunction(
    file: string,
    // Every function form oxc parses: declarations, expressions and arrows.
    node: OxcFunction | ArrowFunctionExpression,
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
    const declarations = (child: Node) => {
      if (
        child.type === "VariableDeclarator" &&
        child.id.type === "Identifier" &&
        child.init
      ) {
        scopedLocals.set(child.id.name, child.init);
      }
      if (child.type === "FunctionDeclaration") {
        if (child.id) {
          scopedLocals.set(child.id.name, child);
        }
        return;
      }
      if (
        child.type === "ArrowFunctionExpression" ||
        child.type === "FunctionExpression"
      ) {
        return;
      }
      visitChildren(child, declarations);
    };
    visitChildren(body, declarations);
    const returns = (child: Node) => {
      if (child.type === "ReturnStatement" && child.argument) {
        findings.push(
          ...this.inspectNode(file, child.argument, visited, scopedLocals),
        );
        return;
      }
      if (
        child.type === "FunctionDeclaration" ||
        child.type === "ArrowFunctionExpression" ||
        child.type === "FunctionExpression"
      ) {
        return;
      }
      visitChildren(child, returns);
    };
    visitChildren(body, returns);
    return findings;
  }
  inspectAttribute(
    file: string,
    node: JSXAttribute,
    visited: Set<string>,
    locals: Map<string, Node>,
  ): string[] {
    if (this.text(file, node.name) === "data-slot") {
      const value = node.value;
      const expression =
        value?.type === "JSXExpressionContainer" ? value.expression : value;
      if (expression?.type === "Literal" && expression.value === "sidebar") {
        return ["DOM#data-slot=sidebar"];
      }
    }
    if (/^on[A-Z]/u.test(this.text(file, node.name))) {
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
    if (
      node.attributes.some(
        (attribute) => attribute.type === "JSXSpreadAttribute",
      )
    ) {
      return false;
    }
    const sizes = node.attributes.filter(
      (attribute) =>
        attribute.type === "JSXAttribute" &&
        this.text(file, attribute.name) === "size",
    );
    const size = sizes.at(0);
    if (sizes.length !== 1 || !size || size.type !== "JSXAttribute") {
      return false;
    }
    const value = size.value;
    const expression =
      value?.type === "JSXExpressionContainer" ? value.expression : value;
    if (
      !expression ||
      expression.type !== "Literal" ||
      expression.value !== "sm"
    ) {
      return false;
    }
    // The owner defines sm as progress next to a control; md/lg occupy a region.
    if (node.name.type === "JSXIdentifier") {
      return this.isCanonicalLoader(file, node.name.name, new Set());
    }
    if (
      node.name.type !== "JSXMemberExpression" ||
      node.name.object.type !== "JSXIdentifier"
    ) {
      return false;
    }
    const imported = this.load(file).imports.get(node.name.object.name);
    if (!imported) {
      return false;
    }
    if (imported.module === LOGO_LOADER_MODULE) {
      return node.name.property.name === "Loader";
    }
    const target = this.resolveModule(file, imported.module);
    return (
      target !== undefined &&
      this.isCanonicalLoader(target, node.name.property.name, new Set())
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
    const callee = node.callee;
    const module = this.load(file);
    const named =
      callee.type === "Identifier"
        ? module.imports.get(callee.name)
        : undefined;
    const namespace =
      callee.type === "MemberExpression" && callee.object.type === "Identifier"
        ? module.imports.get(callee.object.name)
        : undefined;
    const isCreateElement =
      (named?.module === "react" && named.name === "createElement") ||
      (namespace?.module === "react" &&
        callee.type === "MemberExpression" &&
        nameOf(callee.property) === "createElement");
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
    if (
      node.callee.type === "MemberExpression" &&
      nameOf(node.callee.property) === "then"
    ) {
      const receiver = node.callee.object;
      const callback = node.arguments.at(0);
      if (
        receiver.type === "ImportExpression" &&
        callback?.type === "ArrowFunctionExpression"
      ) {
        const specifier = receiver.source;
        const parameter = callback.params.at(0);
        if (
          specifier.type === "Literal" &&
          typeof specifier.value === "string" &&
          parameter?.type === "Identifier"
        ) {
          if (specifier.value === LOGO_LOADER_MODULE) {
            return [`${specifier.value}#Loader`];
          }
          const target = this.resolveModule(file, specifier.value);
          const findings: string[] = [];
          const namedExports = (child: Node) => {
            if (
              target &&
              child.type === "MemberExpression" &&
              !child.computed &&
              child.object.type === "Identifier" &&
              child.object.name === parameter.name
            ) {
              findings.push(
                ...this.inspectSymbol(target, nameOf(child.property), visited),
              );
            }
            visitChildren(child, namedExports);
          };
          namedExports(callback.body);
          return findings;
        }
      }
    }
    return undefined;
  }
}

export const checkRouteFallbacks = (sourceDirectory: string) => {
  const srcDirectory = path.resolve(sourceDirectory);
  const symbols = new FallbackSymbols(srcDirectory);
  const boundaries: Boundary[] = [];
  const addBoundary = (
    file: string,
    kind: Boundary["kind"],
    expression: Node,
  ) => {
    boundaries.push({
      file: repoRelativePath(srcDirectory, file),
      kind,
      expression,
      line: symbols.load(file).source.locate(expression.start).line,
    });
  };
  const routeTree = symbols.load(path.join(srcDirectory, "routeTree.gen.ts"));
  const registeredRoutes = new Set<string>();
  for (const imported of routeTree.imports.values()) {
    if (imported.name !== "Route" || !imported.module.startsWith("./routes/")) {
      continue;
    }
    const file = symbols.resolveModule(
      routeTree.source.fileName,
      imported.module,
    );
    if (file) {
      registeredRoutes.add(file);
    }
  }
  if (registeredRoutes.size === 0) {
    panic("Route fallback census found no registered routes");
  }
  const collect = (file: string) => {
    const visit = (node: Node) => {
      if (
        node.type === "Property" &&
        (node.key.type === "Identifier" || node.key.type === "Literal")
      ) {
        const name = nameOf(node.key);
        if (name === "pendingComponent" && registeredRoutes.has(file)) {
          addBoundary(file, name, node.value);
        }
        if (
          name === "defaultPendingComponent" &&
          file === path.join(srcDirectory, "router.tsx")
        ) {
          addBoundary(file, name, node.value);
        }
      }
      if (node.type === "JSXOpeningElement") {
        const name = symbols.text(file, node.name);
        const imported =
          node.name.type === "JSXIdentifier"
            ? symbols.load(file).imports.get(name)
            : undefined;
        const namespace =
          node.name.type === "JSXMemberExpression" &&
          node.name.object.type === "JSXIdentifier"
            ? symbols.load(file).imports.get(node.name.object.name)
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
              symbols.text(file, attribute.name) === "fallback" &&
              attribute.value
            ) {
              addBoundary(file, "Suspense", attribute.value);
            }
          }
        }
      }
    };
    walk(symbols.load(file).source.program, visit);
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
        symbols.text(
          path.join(srcDirectory, boundary.file),
          expression.expression.openingElement.name,
        ) === candidate.component &&
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
