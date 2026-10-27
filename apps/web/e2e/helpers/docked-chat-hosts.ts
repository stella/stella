import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";
import {
  type JSXOpeningElement,
  type Node,
  type ParsedSource,
  parseSource as parseSyntax,
  walk,
} from "@stll/scripts/src/syntax-tree";

import type { AppFrameScope } from "../../src/routes/-app-frame-scope";
import { APP_FRAME_SCOPE } from "../../src/routes/-app-frame-scope";
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

const parseSource = (file: string) => ({
  ...parseSyntax(file, readFileSync(file, "utf-8")),
  fileName: file,
});
type Source = ParsedSource & { fileName: string };
const textOf = (node: { start: number; end: number }, source: ParsedSource) =>
  source.sourceText.slice(node.start, node.end);

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

/** Read route metadata only; route component implementation is irrelevant. */
export const declaredAppFrameScope = (
  source: Source,
): AppFrameScope | undefined => {
  const scopeImports = new Set<string>();
  for (const statement of source.program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      !/(?:^|\/)-app-frame-scope$/u.test(statement.source.value)
    ) {
      continue;
    }
    for (const binding of statement.specifiers) {
      if (
        binding.type === "ImportSpecifier" &&
        (binding.imported.type === "Identifier"
          ? binding.imported.name
          : binding.imported.value) === "APP_FRAME_SCOPE"
      ) {
        scopeImports.add(binding.local.name);
      }
    }
  }
  let scope: AppFrameScope | undefined;
  const visit = (node: Node): undefined => {
    if (
      node.type === "Property" &&
      textOf(node.key, source) === "staticData" &&
      node.value.type === "ObjectExpression"
    ) {
      for (const property of node.value.properties) {
        if (
          property.type !== "Property" ||
          textOf(property.key, source) !== "appFrame"
        ) {
          continue;
        }
        const value = property.value;
        if (
          value.type !== "MemberExpression" ||
          value.computed ||
          value.property.type !== "Identifier" ||
          value.object.type !== "Identifier" ||
          !scopeImports.has(value.object.name)
        ) {
          throw new Error(
            `Unsupported appFrame metadata in ${source.fileName}`,
          );
        }
        switch (value.property.name) {
          case "none":
            scope = APP_FRAME_SCOPE.none;
            break;
          case "member":
            scope = APP_FRAME_SCOPE.member;
            break;
          case "knowledge":
            scope = APP_FRAME_SCOPE.knowledge;
            break;
          default:
            throw new Error(`Unknown appFrame metadata in ${source.fileName}`);
        }
      }
    }
  };
  walk(source.program, visit);
  return scope;
};

/** A preview-only PDF viewer returns its viewport without the docked chat
 * reader it otherwise wraps, so it mounts no reader dock. */
const mountsNoReaderDock = (node: JSXOpeningElement, source: Source): boolean =>
  textOf(node.name, source) === "PeekPdfViewer" &&
  node.attributes.some(
    (attribute) =>
      attribute.type === "JSXAttribute" &&
      textOf(attribute.name, source) === "interactionMode" &&
      attribute.value?.type === "Literal" &&
      attribute.value.value === "preview-only",
  );

/** Follow rendered component imports, rather than utility imports or inherited shells. */
export const renderedImports = (source: Source): string[] => {
  const rendered = new Set<string>();
  const dynamicImports = new Map<string, Set<string>>();
  walk(source.program, (node) => {
    if (
      node.type === "JSXOpeningElement" &&
      !mountsNoReaderDock(node, source)
    ) {
      rendered.add(textOf(node.name, source).split(".").at(0) ?? "");
    }
    if (
      node.type === "Property" &&
      textOf(node.key, source) === "component" &&
      node.value.type === "Identifier"
    ) {
      rendered.add(node.value.name);
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init
    ) {
      const imports = new Set<string>();
      walk(node.init, (child) => {
        if (
          child.type === "ImportExpression" &&
          child.source.type === "Literal" &&
          typeof child.source.value === "string"
        ) {
          imports.add(child.source.value);
        }
      });
      if (imports.size > 0) {
        dynamicImports.set(node.id.name, imports);
      }
    }
  });
  const imports = new Set<string>();
  for (const statement of source.program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.importKind === "type"
    ) {
      continue;
    }
    if (
      statement.specifiers.some(
        (binding) =>
          (binding.type !== "ImportSpecifier" ||
            binding.importKind !== "type") &&
          rendered.has(binding.local.name),
      )
    ) {
      imports.add(statement.source.value);
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
  for (const statement of source.program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    if (
      resolveSource({
        from: file,
        specifier: statement.source.value,
      }) !== path.join(SOURCE_ROOT, "components/chat/docked-chat-stack.tsx")
    ) {
      continue;
    }
    if (statement.importKind === "type") {
      continue;
    }
    for (const binding of statement.specifiers) {
      if (binding.type === "ImportNamespaceSpecifier") {
        providerTags.add(`${binding.local.name}.DockedChatStackProvider`);
      }
      if (
        binding.type === "ImportSpecifier" &&
        binding.importKind !== "type" &&
        (binding.imported.type === "Identifier"
          ? binding.imported.name
          : binding.imported.value) === "DockedChatStackProvider"
      ) {
        providerTags.add(binding.local.name);
      }
    }
  }
  let found = false;
  const visit = (node: Node): undefined => {
    if (
      node.type === "JSXOpeningElement" &&
      providerTags.has(textOf(node.name, source))
    ) {
      found = true;
    }
  };
  walk(source.program, visit);
  return found;
};

const isServerEndpoint = (file: string): boolean => {
  let serverHandlers = false;
  const visit = (node: Node): undefined => {
    if (
      node.type === "Property" &&
      textOf(node.key, source) === "server" &&
      node.value.type === "ObjectExpression"
    ) {
      serverHandlers = node.value.properties.some(
        (property) =>
          property.type === "Property" &&
          textOf(property.key, source) === "handlers",
      );
    }
  };
  const source = parseSource(file);
  walk(source.program, visit);
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
  for (const statement of tree.program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const routeSource = resolveSource({
      from: treePath,
      specifier: statement.source.value,
    });
    for (const element of statement.specifiers) {
      if (element.type === "ImportSpecifier" && routeSource !== undefined) {
        routeSources.set(
          element.local.name.replace(/Import$/u, ""),
          routeSource,
        );
      }
    }
  }
  const parentSymbols = new Map<string, string>();
  for (const statement of tree.program.body) {
    if (statement.type !== "VariableDeclaration") {
      continue;
    }
    for (const declaration of statement.declarations) {
      if (
        declaration.id.type !== "Identifier" ||
        !declaration.init ||
        declaration.init.type !== "CallExpression"
      ) {
        continue;
      }
      const argument = declaration.init.arguments.at(0);
      const options =
        argument?.type === "TSAsExpression" ? argument.expression : argument;
      if (!options || options.type !== "ObjectExpression") {
        continue;
      }
      for (const property of options.properties) {
        if (
          property.type === "Property" &&
          textOf(property.key, tree) === "getParentRoute" &&
          property.value.type === "ArrowFunctionExpression" &&
          property.value.body.type === "Identifier"
        ) {
          parentSymbols.set(
            declaration.id.name,
            property.value.body.name.replace(/Import$/u, ""),
          );
        }
      }
    }
  }
  const scopeForRoute = (symbol: string): AppFrameScope => {
    const visited = new Set<string>();
    for (
      let current: string | undefined = symbol;
      current !== undefined;
      current = parentSymbols.get(current)
    ) {
      if (visited.has(current)) {
        throw new Error(`Cyclic route parents: ${current}`);
      }
      visited.add(current);
      const file = routeSources.get(current);
      if (file === undefined) {
        throw new Error(`Missing route source: ${current}`);
      }
      const scope = declaredAppFrameScope(parseSource(file));
      if (scope !== undefined) {
        return scope;
      }
    }
    throw new Error(`No appFrame metadata for route: ${symbol}`);
  };
  const routes = tree.program.body
    .map((statement) =>
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement,
    )
    .find(
      (statement) =>
        statement?.type === "TSInterfaceDeclaration" &&
        statement.id.name === "FileRoutesByTo",
    );
  if (routes?.type !== "TSInterfaceDeclaration") {
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
  for (const member of routes.body.body) {
    if (
      member.type !== "TSPropertySignature" ||
      member.key.type !== "Literal" ||
      typeof member.key.value !== "string" ||
      member.typeAnnotation === null
    ) {
      throw new Error("Unknown generated route record in FileRoutesByTo");
    }
    const symbol = textOf(member.typeAnnotation.typeAnnotation, tree)
      .replace(/^typeof\s+/u, "")
      .replace(/WithChildren$/u, "");
    const file = routeSources.get(symbol);
    if (file === undefined) {
      throw new Error(
        `No owning source for route ${member.key.value}: ${symbol}`,
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
    const surfaces = new Set(discover(file));
    const memberFrame =
      selectAppFrame({
        scope: scopeForRoute(symbol),
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
        template: member.key.value,
        surfaces: [...surfaces].toSorted(),
      });
    }
  }
  return {
    hosts: hosts.toSorted((a, b) => a.template.localeCompare(b.template)),
    providerSources,
  };
};
