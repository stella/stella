import { panic } from "better-result";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

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
  expression: ts.Node;
};
type Module = {
  source: ts.SourceFile;
  definitions: Map<string, ts.Node>;
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
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf-8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const module: Module = {
      source,
      definitions: new Map(),
      imports: new Map(),
      exports: new Map(),
      exportStars: [],
    };
    this.modules.set(file, module);
    for (const statement of source.statements) {
      this.indexDefinition(statement, module);
      if (ts.isImportDeclaration(statement)) {
        this.indexImport(statement, module);
      }
      if (ts.isExportDeclaration(statement)) {
        this.indexExport(statement, module);
      }
    }
    return module;
  }
  indexDefinition(node: ts.Statement, module: Module) {
    if (ts.isExportAssignment(node)) {
      module.definitions.set("default", node.expression);
      return;
    }
    if (ts.isFunctionDeclaration(node)) {
      if (node.name) {
        module.definitions.set(node.name.text, node);
      }
      if (
        node.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
        )
      ) {
        module.definitions.set("default", node);
      }
      return;
    }
    if (!ts.isVariableStatement(node)) {
      return;
    }
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        module.definitions.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  indexImport(node: ts.ImportDeclaration, module: Module) {
    if (!ts.isStringLiteral(node.moduleSpecifier)) {
      return;
    }
    const specifier = node.moduleSpecifier.text;
    const clause = node.importClause;
    if (!clause || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) {
      return;
    }
    if (clause.name) {
      module.imports.set(clause.name.text, {
        module: specifier,
        name: "default",
      });
    }
    const bindings = clause.namedBindings;
    if (!bindings) {
      return;
    }
    if (ts.isNamespaceImport(bindings)) {
      module.imports.set(bindings.name.text, { module: specifier, name: "*" });
      return;
    }
    for (const imported of bindings.elements) {
      if (imported.isTypeOnly) {
        continue;
      }
      module.imports.set(imported.name.text, {
        module: specifier,
        name: imported.propertyName?.text ?? imported.name.text,
      });
    }
  }
  indexExport(node: ts.ExportDeclaration, module: Module) {
    if (node.isTypeOnly) {
      return;
    }
    const specifier =
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : "";
    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const exported of node.exportClause.elements) {
        if (exported.isTypeOnly) {
          continue;
        }
        module.exports.set(exported.name.text, {
          module: specifier,
          name: exported.propertyName?.text ?? exported.name.text,
        });
      }
      return;
    }
    if (specifier) {
      module.exportStars.push(specifier);
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
    if (imported) {
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
    node: ts.Node,
    visited: Set<string>,
    locals = new Map<string, ts.Node>(),
  ): string[] {
    if (ts.isTypeNode(node)) {
      return [];
    }
    if (ts.isJsxClosingElement(node)) {
      return [];
    }
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      this.isInlineLoader(file, node)
    ) {
      return [];
    }
    if (ts.isJsxAttribute(node)) {
      return this.inspectAttribute(file, node, visited, locals);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression)
    ) {
      return this.inspectPropertyAccess(file, node, visited);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = node.arguments.at(0);
      if (specifier && ts.isStringLiteral(specifier)) {
        if (specifier.text === LOGO_LOADER_MODULE) {
          return [`${specifier.text}#default`];
        }
        const target = this.resolveModule(file, specifier.text);
        return target ? this.inspectSymbol(target, "default", visited) : [];
      }
    }
    if (ts.isCallExpression(node)) {
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
    if (ts.isPropertyAssignment(node)) {
      return this.inspectNode(file, node.initializer, visited, locals);
    }
    if (ts.isIdentifier(node)) {
      const local = locals.get(node.text);
      if (local) {
        const key = `${file}:${local.pos}`;
        if (visited.has(key)) {
          return [];
        }
        visited.add(key);
        return this.inspectNode(file, local, visited, locals);
      }
      return this.inspectSymbol(file, node.text, visited);
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      return this.inspectFunction(file, node, visited, locals);
    }
    const findings: string[] = [];
    ts.forEachChild(node, (child) => {
      findings.push(...this.inspectNode(file, child, visited, locals));
    });
    return findings;
  }
  inspectPropertyAccess(
    file: string,
    node: ts.PropertyAccessExpression,
    visited: Set<string>,
  ): string[] {
    if (!ts.isIdentifier(node.expression)) {
      return [];
    }
    const imported = this.load(file).imports.get(node.expression.text);
    if (imported?.module === LOGO_LOADER_MODULE) {
      return [`${imported.module}#${node.name.text}`];
    }
    if (imported?.name === "*") {
      if (SHELL_SYMBOLS.has(node.name.text)) {
        return [`${imported.module}#${node.name.text}`];
      }
      const target = this.resolveModule(file, imported.module);
      return target ? this.inspectSymbol(target, node.name.text, visited) : [];
    }
    // Data/query members in JSX props are not rendered component symbols.
    return [];
  }
  inspectFunction(
    file: string,
    node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
    visited: Set<string>,
    locals: Map<string, ts.Node>,
  ): string[] {
    const findings: string[] = [];
    const body = node.body;
    if (!body) {
      return findings;
    }
    if (!ts.isBlock(body)) {
      return this.inspectNode(file, body, visited, locals);
    }
    const scopedLocals = new Map(locals);
    const declarations = (child: ts.Node) => {
      if (
        ts.isVariableDeclaration(child) &&
        ts.isIdentifier(child.name) &&
        child.initializer
      ) {
        scopedLocals.set(child.name.text, child.initializer);
      }
      if (ts.isFunctionDeclaration(child)) {
        if (child.name) {
          scopedLocals.set(child.name.text, child);
        }
        return;
      }
      if (ts.isArrowFunction(child) || ts.isFunctionExpression(child)) {
        return;
      }
      ts.forEachChild(child, declarations);
    };
    ts.forEachChild(body, declarations);
    const returns = (child: ts.Node) => {
      if (ts.isReturnStatement(child) && child.expression) {
        findings.push(
          ...this.inspectNode(file, child.expression, visited, scopedLocals),
        );
        return;
      }
      if (
        ts.isFunctionDeclaration(child) ||
        ts.isArrowFunction(child) ||
        ts.isFunctionExpression(child)
      ) {
        return;
      }
      ts.forEachChild(child, returns);
    };
    ts.forEachChild(body, returns);
    return findings;
  }
  inspectAttribute(
    file: string,
    node: ts.JsxAttribute,
    visited: Set<string>,
    locals: Map<string, ts.Node>,
  ): string[] {
    if (node.name.getText() === "data-slot") {
      const value = node.initializer;
      const expression =
        value && ts.isJsxExpression(value) ? value.expression : value;
      if (
        expression &&
        ts.isStringLiteral(expression) &&
        expression.text === "sidebar"
      ) {
        return ["DOM#data-slot=sidebar"];
      }
    }
    if (/^on[A-Z]/u.test(node.name.getText())) {
      return [];
    }
    return node.initializer
      ? this.inspectNode(file, node.initializer, visited, locals)
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
    if (imported) {
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
    if (definition && ts.isIdentifier(definition)) {
      return this.isCanonicalLoader(file, definition.text, visited);
    }
    for (const specifier of module.exportStars) {
      const target = this.resolveModule(file, specifier);
      if (target && this.isCanonicalLoader(target, name, visited)) {
        return true;
      }
    }
    return false;
  }
  isInlineLoader(
    file: string,
    node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  ): boolean {
    if (node.attributes.properties.some(ts.isJsxSpreadAttribute)) {
      return false;
    }
    const sizes = node.attributes.properties.filter(
      (attribute) =>
        ts.isJsxAttribute(attribute) && attribute.name.getText() === "size",
    );
    const size = sizes.at(0);
    if (sizes.length !== 1 || !size || !ts.isJsxAttribute(size)) {
      return false;
    }
    const value = size.initializer;
    const expression =
      value && ts.isJsxExpression(value) ? value.expression : value;
    if (
      !expression ||
      !ts.isStringLiteral(expression) ||
      expression.text !== "sm"
    ) {
      return false;
    }
    // The owner defines sm as progress next to a control; md/lg occupy a region.
    if (ts.isIdentifier(node.tagName)) {
      return this.isCanonicalLoader(file, node.tagName.text, new Set());
    }
    if (
      !ts.isPropertyAccessExpression(node.tagName) ||
      !ts.isIdentifier(node.tagName.expression)
    ) {
      return false;
    }
    const imported = this.load(file).imports.get(node.tagName.expression.text);
    if (!imported) {
      return false;
    }
    if (imported.module === LOGO_LOADER_MODULE) {
      return node.tagName.name.text === "Loader";
    }
    const target = this.resolveModule(file, imported.module);
    return (
      target !== undefined &&
      this.isCanonicalLoader(target, node.tagName.name.text, new Set())
    );
  }
  inspectRenderCall(
    file: string,
    node: ts.CallExpression,
    visited: Set<string>,
    locals: Map<string, ts.Node>,
  ): string[] {
    const findings = this.inspectNode(file, node.expression, visited, locals);
    for (const argument of node.arguments) {
      if (
        ts.isArrowFunction(argument) ||
        ts.isFunctionExpression(argument) ||
        ts.isJsxElement(argument) ||
        ts.isJsxSelfClosingElement(argument) ||
        ts.isJsxFragment(argument)
      ) {
        findings.push(...this.inspectNode(file, argument, visited, locals));
      }
    }
    return findings;
  }
  inspectReactElement(
    file: string,
    node: ts.CallExpression,
    visited: Set<string>,
    locals: Map<string, ts.Node>,
  ): string[] | undefined {
    const callee = node.expression;
    const module = this.load(file);
    const named = ts.isIdentifier(callee)
      ? module.imports.get(callee.text)
      : undefined;
    const namespace =
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression)
        ? module.imports.get(callee.expression.text)
        : undefined;
    const isCreateElement =
      (named?.module === "react" && named.name === "createElement") ||
      (namespace?.module === "react" &&
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "createElement");
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
    node: ts.CallExpression,
    visited: Set<string>,
  ): string[] | undefined {
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "then"
    ) {
      const receiver = node.expression.expression;
      const callback = node.arguments.at(0);
      if (
        ts.isCallExpression(receiver) &&
        receiver.expression.kind === ts.SyntaxKind.ImportKeyword &&
        callback &&
        ts.isArrowFunction(callback)
      ) {
        const specifier = receiver.arguments.at(0);
        const parameter = callback.parameters.at(0)?.name;
        if (
          specifier &&
          ts.isStringLiteral(specifier) &&
          parameter &&
          ts.isIdentifier(parameter)
        ) {
          if (specifier.text === LOGO_LOADER_MODULE) {
            return [`${specifier.text}#Loader`];
          }
          const target = this.resolveModule(file, specifier.text);
          const findings: string[] = [];
          const namedExports = (child: ts.Node) => {
            if (
              target &&
              ts.isPropertyAccessExpression(child) &&
              ts.isIdentifier(child.expression) &&
              child.expression.text === parameter.text
            ) {
              findings.push(
                ...this.inspectSymbol(target, child.name.text, visited),
              );
            }
            ts.forEachChild(child, namedExports);
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
    expression: ts.Node,
  ) => {
    boundaries.push({
      file: path.relative(srcDirectory, file),
      kind,
      expression,
      line:
        symbols
          .load(file)
          .source.getLineAndCharacterOfPosition(expression.getStart()).line + 1,
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
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      ) {
        const name = node.name.text;
        if (name === "pendingComponent" && registeredRoutes.has(file)) {
          addBoundary(file, name, node.initializer);
        }
        if (
          name === "defaultPendingComponent" &&
          file === path.join(srcDirectory, "router.tsx")
        ) {
          addBoundary(file, name, node.initializer);
        }
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const name = node.tagName.getText();
        const imported = ts.isIdentifier(node.tagName)
          ? symbols.load(file).imports.get(name)
          : undefined;
        const namespace =
          ts.isPropertyAccessExpression(node.tagName) &&
          ts.isIdentifier(node.tagName.expression)
            ? symbols.load(file).imports.get(node.tagName.expression.text)
            : undefined;
        const namespacedSuspense =
          ts.isPropertyAccessExpression(node.tagName) &&
          node.tagName.name.text === "Suspense" &&
          namespace?.module === "react";
        if (
          namespacedSuspense ||
          name === "Suspense" ||
          (imported?.module === "react" && imported.name === "Suspense")
        ) {
          for (const attribute of node.attributes.properties) {
            if (
              ts.isJsxAttribute(attribute) &&
              attribute.name.getText() === "fallback" &&
              attribute.initializer
            ) {
              addBoundary(file, "Suspense", attribute.initializer);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(symbols.load(file).source);
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
        ts.isJsxExpression(expression) &&
        expression.expression !== undefined &&
        ts.isJsxSelfClosingElement(expression.expression) &&
        expression.expression.tagName.getText() === candidate.component &&
        expression.expression.attributes.properties.length === 0
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
