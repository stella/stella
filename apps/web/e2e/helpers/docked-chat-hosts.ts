import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { repoRelativePath } from "@stll/portable-path";

import { selectAppFrame } from "../../src/routes/-app-frame.logic";

type DockedChatSurface = "inspector" | "reader" | "template";
export type DockedChatHost = {
  template: string;
  surfaces: DockedChatSurface[];
};

const SOURCE_ROOT = path.resolve(import.meta.dirname, "../../src");
const PROVIDER_SURFACES = new Map<string, DockedChatSurface>([
  ["components/ai-suggestions/file-viewer-with-ai.tsx", "reader"],
  ["routes/knowledge/-components/template-studio-chat.tsx", "template"],
]);

const parseSource = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(file, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

type ResolveSourceOptions = { from: string; specifier: string };
const resolveSource = ({
  from,
  specifier,
}: ResolveSourceOptions): string | undefined => {
  let base: string | undefined;
  if (specifier.startsWith("@/")) {
    base = path.join(SOURCE_ROOT, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(from), specifier);
  }
  if (base === undefined) {
    return undefined;
  }
  return [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, "index.tsx"),
    path.join(base, "index.ts"),
  ].find(
    (candidate) => existsSync(candidate) && /\.[cm]?[jt]sx?$/u.test(candidate),
  );
};

/** Follow rendered component imports, rather than utility imports or inherited shells. */
const renderedImports = (source: ts.SourceFile): string[] => {
  const rendered = new Set<string>();
  const dynamicImports = new Map<string, Set<string>>();
  const collect = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      rendered.add(node.tagName.getText(source).split(".").at(0) ?? "");
    }
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "component" &&
      ts.isIdentifier(node.initializer)
    ) {
      rendered.add(node.initializer.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const imports = new Set<string>();
      const visitInitializer = (child: ts.Node): void => {
        if (
          ts.isCallExpression(child) &&
          child.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
          const argument = child.arguments.at(0);
          if (argument !== undefined && ts.isStringLiteral(argument)) {
            imports.add(argument.text);
          }
        }
        ts.forEachChild(child, visitInitializer);
      };
      visitInitializer(node.initializer);
      if (imports.size > 0) {
        dynamicImports.set(node.name.text, imports);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const imports = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (
      clause === undefined ||
      clause.phaseModifier === ts.SyntaxKind.TypeKeyword
    ) {
      continue;
    }
    const named = clause.namedBindings;
    const isRendered =
      (clause.name !== undefined && rendered.has(clause.name.text)) ||
      (named !== undefined &&
        (ts.isNamespaceImport(named)
          ? rendered.has(named.name.text)
          : named.elements.some(
              (element) =>
                !element.isTypeOnly && rendered.has(element.name.text),
            )));
    if (isRendered) {
      imports.add(statement.moduleSpecifier.text);
    }
  }
  for (const name of rendered) {
    for (const specifier of dynamicImports.get(name) ?? []) {
      imports.add(specifier);
    }
  }
  return [...imports];
};

/** Resolve JSX bindings through imports so renaming the provider cannot hide a host. */
const mountsDockedChatProvider = (file: string): boolean => {
  const source = parseSource(file);
  const providerTags = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    if (
      resolveSource({
        from: file,
        specifier: statement.moduleSpecifier.text,
      }) !== path.join(SOURCE_ROOT, "components/chat/docked-chat-stack.tsx")
    ) {
      continue;
    }
    const clause = statement.importClause;
    const named = clause?.namedBindings;
    if (
      clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
      named === undefined
    ) {
      continue;
    }
    if (ts.isNamespaceImport(named)) {
      providerTags.add(`${named.name.text}.DockedChatStackProvider`);
      continue;
    }
    for (const element of named.elements) {
      if (
        !element.isTypeOnly &&
        (element.propertyName ?? element.name).text ===
          "DockedChatStackProvider"
      ) {
        providerTags.add(element.name.text);
      }
    }
  }
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      providerTags.has(node.tagName.getText(source))
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const isServerEndpoint = (file: string): boolean => {
  let serverHandlers = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText() === "server" &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      serverHandlers = node.initializer.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText() === "handlers",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(parseSource(file));
  return serverHandlers;
};

/** A source census: new provider owners and uncovered runtime hosts fail loudly. */
export const readDockedChatHosts = (): {
  hosts: DockedChatHost[];
  providerSources: string[];
} => {
  const sourceFiles = readdirSync(SOURCE_ROOT, {
    recursive: true,
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".tsx") &&
        !entry.name.includes(".test."),
    )
    .map((entry) => path.join(entry.parentPath, entry.name));
  const providerSources = sourceFiles
    .filter(mountsDockedChatProvider)
    .map((file) => repoRelativePath(SOURCE_ROOT, file))
    .toSorted();
  for (const provider of providerSources) {
    if (!PROVIDER_SURFACES.has(provider)) {
      throw new Error(`Classify new docked chat provider owner: ${provider}`);
    }
  }
  for (const provider of PROVIDER_SURFACES.keys()) {
    if (!providerSources.includes(provider)) {
      throw new Error(
        `Remove stale docked chat provider classification: ${provider}`,
      );
    }
  }
  const treePath = path.join(SOURCE_ROOT, "routeTree.gen.ts");
  const tree = parseSource(treePath);
  const routeSources = new Map<string, string>();
  for (const statement of tree.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const named = statement.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) {
      continue;
    }
    const routeSource = resolveSource({
      from: treePath,
      specifier: statement.moduleSpecifier.text,
    });
    for (const element of named.elements) {
      if (routeSource !== undefined) {
        routeSources.set(
          element.name.text.replace(/Import$/u, ""),
          routeSource,
        );
      }
    }
  }
  const routes = tree.statements.find(
    (statement) =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === "FileRoutesByTo",
  );
  if (routes === undefined || !ts.isInterfaceDeclaration(routes)) {
    throw new Error("Generated route tree lacks FileRoutesByTo");
  }
  // These owners render inherited docks; their descendant readers are not
  // a reader mounted by the route component being classified.
  const inheritedShells = new Set([
    "routes/-app-frame-host.tsx",
    "routes/-protected-app.tsx",
    "routes/law/-components/public-law-shell.tsx",
  ]);
  const importGraph = new Map<string, string[]>();
  const discover = (
    file: string,
    visiting = new Set<string>(),
  ): Set<DockedChatSurface> => {
    const surfaces = new Set<DockedChatSurface>();
    if (
      visiting.has(file) ||
      inheritedShells.has(repoRelativePath(SOURCE_ROOT, file))
    ) {
      return surfaces;
    }
    visiting.add(file);
    const provider = PROVIDER_SURFACES.get(repoRelativePath(SOURCE_ROOT, file));
    if (provider !== undefined) {
      surfaces.add(provider);
    }
    let children = importGraph.get(file);
    if (children === undefined) {
      children = renderedImports(parseSource(file))
        .map((specifier) => resolveSource({ from: file, specifier }))
        .filter((child): child is string => child !== undefined);
      importGraph.set(file, children);
    }
    for (const child of children) {
      for (const surface of discover(child, visiting)) {
        surfaces.add(surface);
      }
    }
    return surfaces;
  };
  const lawShell = readFileSync(
    path.join(SOURCE_ROOT, "routes/law/route.tsx"),
    "utf-8",
  );
  const lawShellOwnsInspector =
    /<PublicLawShell\b/u.test(lawShell) &&
    /<PublicLawInspector\b/u.test(
      readFileSync(
        path.join(SOURCE_ROOT, "routes/law/-components/public-law-shell.tsx"),
        "utf-8",
      ),
    );
  if (!lawShellOwnsInspector) {
    throw new Error(
      "Update the docked host census for the changed public-law inspector shell",
    );
  }
  const hosts: DockedChatHost[] = [];
  for (const member of routes.members) {
    if (
      !ts.isPropertySignature(member) ||
      !ts.isStringLiteral(member.name) ||
      member.type === undefined
    ) {
      throw new Error("Unknown generated route record in FileRoutesByTo");
    }
    const symbol = member.type
      .getText(tree)
      .replace(/^typeof\s+/u, "")
      .replace(/WithChildren$/u, "");
    const file = routeSources.get(symbol);
    if (file === undefined) {
      throw new Error(
        `No owning source for route ${member.name.text}: ${symbol}`,
      );
    }
    const source = readFileSync(file, "utf-8");
    if (isServerEndpoint(file)) {
      continue;
    }
    const routeId = /createFileRoute\(\s*["']([^"']+)["']/u.exec(source)?.at(1);
    if (routeId === undefined) {
      throw new Error(`No route id in ${file}`);
    }
    const routeIds = ["__root__", routeId];
    if (symbol.startsWith("Protected")) {
      routeIds.push("/_protected");
    }
    if (symbol.startsWith("Knowledge")) {
      routeIds.push("/knowledge");
    }
    const surfaces = new Set(discover(file));
    const memberFrame =
      selectAppFrame({
        routeIds,
        hasRouteUser: true,
        publicKnowledge: true,
        audience: "member",
      }) === "member";
    if (memberFrame || symbol.startsWith("Law")) {
      surfaces.add("inspector");
    }
    if (surfaces.size > 0) {
      hosts.push({
        template: member.name.text,
        surfaces: [...surfaces].toSorted(),
      });
    }
  }
  return {
    hosts: hosts.toSorted((a, b) => a.template.localeCompare(b.template)),
    providerSources,
  };
};
