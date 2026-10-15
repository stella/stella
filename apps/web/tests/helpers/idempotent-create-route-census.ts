import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const apiRoot = path.resolve(import.meta.dirname, "../../../api/src");

type SourceOptions = { file: string; text: string };

const parse = ({ file, text }: SourceOptions) =>
  ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
const walk = (node: ts.Node, visit: (node: ts.Node) => void) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};
const property = (node: ts.ObjectLiteralExpression, name: string) =>
  node.properties.find(
    (entry): entry is ts.PropertyAssignment =>
      ts.isPropertyAssignment(entry) &&
      (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
      entry.name.text === name,
  )?.initializer;
const normalizeRoute = (route: string) =>
  route
    .split("/")
    .filter(Boolean)
    .filter((part, index) => index !== 0 || part !== "v1")
    .map((part) => (part.startsWith(":") ? "*" : part))
    .join("/");

const serverReceiver = ({ file, text }: SourceOptions) => {
  const tree = parse({ file, text });
  const imports = new Map<string, string>();
  const declarations = new Map<string, ts.Expression>();
  walk(tree, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (node.importClause.name) {
        imports.set(node.importClause.name.text, node.moduleSpecifier.text);
      }
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const entry of bindings.elements) {
          imports.set(entry.name.text, node.moduleSpecifier.text);
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      declarations.set(node.name.text, node.initializer);
    }
  });
  const prefix = (node: ts.Expression, depth = 0): string | undefined => {
    if (depth > 64) {
      return undefined;
    }
    if (ts.isNewExpression(node)) {
      const config = node.arguments?.at(0);
      const value =
        config && ts.isObjectLiteralExpression(config)
          ? property(config, "prefix")
          : undefined;
      return value && ts.isStringLiteral(value) ? value.text : "";
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      return prefix(node.expression.expression, depth + 1);
    }
    if (!ts.isIdentifier(node)) {
      return undefined;
    }
    const declaration = declarations.get(node.text);
    if (declaration) {
      return prefix(declaration, depth + 1);
    }
    let parent: ts.Node | undefined = node.parent;
    while (parent) {
      if (
        ts.isArrowFunction(parent) &&
        parent.parameters.some(
          (param) =>
            ts.isIdentifier(param.name) && param.name.text === node.text,
        )
      ) {
        const group = parent.parent;
        if (
          ts.isCallExpression(group) &&
          ts.isPropertyAccessExpression(group.expression) &&
          group.expression.name.text === "group"
        ) {
          const segment = group.arguments.at(0);
          const base = prefix(group.expression.expression, depth + 1);
          return base !== undefined && segment && ts.isStringLiteral(segment)
            ? base + segment.text
            : undefined;
        }
      }
      parent = parent.parent;
    }
    return undefined;
  };
  return { tree, imports, prefix };
};

// Resolve the receiver of each mount, including separate Elysia instances and
// nested group callbacks. A later group in a fluent chain must not change an
// earlier route's prefix.
type ServerCreateRoutesOptions = SourceOptions & {
  isCreate: (module: string) => boolean;
};

export const serverCreateRoutes = ({
  file,
  text,
  isCreate,
}: ServerCreateRoutesOptions) => {
  const { tree, imports, prefix } = serverReceiver({ file, text });
  const routes = new Set<string>();
  walk(tree, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression)
    ) {
      return;
    }
    const method = node.expression.name.text;
    if (method !== "put" && method !== "post") {
      return;
    }
    const route = node.arguments.at(0);
    const handler = node.arguments.at(1);
    if (
      !route ||
      !ts.isStringLiteral(route) ||
      !handler ||
      !ts.isPropertyAccessExpression(handler) ||
      !ts.isIdentifier(handler.expression)
    ) {
      return;
    }
    const module = imports.get(handler.expression.text);
    if (!module || !isCreate(module)) {
      return;
    }
    const base = prefix(node.expression.expression);
    if (base === undefined) {
      panic(`${file}: cannot resolve route prefix for ${module}`);
    }
    routes.add(`${method}:${normalizeRoute(base + route.text)}`);
  });
  return routes;
};

type ModuleOptions = { file: string; module: string };

const resolveModule = ({ file, module }: ModuleOptions) => {
  const target = module.startsWith("@/api/")
    ? path.join(apiRoot, module.slice("@/api/".length))
    : path.resolve(path.dirname(file), module);
  return target.endsWith(".ts") ? target : `${target}.ts`;
};

type RouteMount = { parent: string; prefix: string };

/** Compose imported route plugins with the receiver that mounts them. */
export const mountedServerCreateRoutes = (
  sources: ReadonlyMap<string, string>,
  isCreate: (options: ModuleOptions) => boolean,
) => {
  const mounts = new Map<string, RouteMount[]>();
  for (const [file, text] of sources) {
    if (!text.includes(".use(")) {
      continue;
    }
    const { tree, imports, prefix } = serverReceiver({ file, text });
    walk(tree, (node) => {
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression) ||
        node.expression.name.text !== "use"
      ) {
        return;
      }
      const mounted = node.arguments.at(0);
      const identifier =
        mounted && ts.isCallExpression(mounted) ? mounted.expression : mounted;
      if (!identifier || !ts.isIdentifier(identifier)) {
        return;
      }
      const module = imports.get(identifier.text);
      if (!module) {
        return;
      }
      const child = resolveModule({ file, module });
      if (!sources.has(child)) {
        return;
      }
      const receiverPrefix = prefix(node.expression.expression);
      if (receiverPrefix === undefined) {
        panic(`${file}: cannot resolve plugin mount prefix for ${module}`);
      }
      const existing = mounts.get(child);
      const edge = { parent: file, prefix: receiverPrefix };
      if (existing) {
        existing.push(edge);
      } else {
        mounts.set(child, [edge]);
      }
    });
  }
  const prefixes = (file: string, ancestors: ReadonlySet<string>): string[] => {
    if (ancestors.has(file)) {
      panic(`${file}: route plugins must not mount cyclically`);
    }
    const edges = mounts.get(file);
    if (!edges) {
      return [""];
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(file);
    return edges.flatMap((edge) =>
      prefixes(edge.parent, nextAncestors).map((base) => base + edge.prefix),
    );
  };
  const creates = new Set<string>();
  for (const [file, text] of sources) {
    if (!text.includes(".handler")) {
      continue;
    }
    const routes = serverCreateRoutes({
      file,
      text,
      isCreate: (module) => isCreate({ file, module }),
    });
    if (routes.size === 0) {
      continue;
    }
    for (const mount of prefixes(file, new Set())) {
      for (const route of routes) {
        const separator = route.indexOf(":");
        const method = route.slice(0, separator);
        const localPath = route.slice(separator + 1);
        creates.add(`${method}:${normalizeRoute(`${mount}/${localPath}`)}`);
      }
    }
  }
  return creates;
};

export const liveCreateRoutes = () => {
  const capabilityModules = new Set<string>();
  for (const file of new Bun.Glob(
    "mcp/generated/capability-dispatch/*.create.ts",
  ).scanSync({ cwd: apiRoot })) {
    walk(
      parse({ file, text: readFileSync(path.join(apiRoot, file), "utf-8") }),
      (node) => {
        if (
          !ts.isCallExpression(node) ||
          node.expression.kind !== ts.SyntaxKind.ImportKeyword
        ) {
          return;
        }
        const module = node.arguments.at(0);
        if (module && ts.isStringLiteral(module)) {
          capabilityModules.add(module.text);
        }
      },
    );
  }
  const isCreate = ({ file, module }: ModuleOptions) => {
    const target = module.startsWith("@/api/")
      ? path.join(apiRoot, module.slice("@/api/".length))
      : path.resolve(path.dirname(file), module);
    if (
      !target.startsWith(apiRoot) ||
      (!target.endsWith("/create") && !capabilityModules.has(module))
    ) {
      return false;
    }
    // Non-JSON/credential/public-auth exceptions are owned by the server census.
    return /idempotency:\s*\{\s*type:\s*"replay"/u.test(
      readFileSync(`${target}.ts`, "utf-8"),
    );
  };
  const sources = new Map<string, string>();
  for (const file of new Bun.Glob("handlers/**/*.ts").scanSync({
    cwd: apiRoot,
  })) {
    if (/\.(?:test|type-test)\./u.test(file)) {
      continue;
    }
    const absolute = path.join(apiRoot, file);
    sources.set(absolute, readFileSync(absolute, "utf-8"));
  }
  return mountedServerCreateRoutes(sources, isCreate);
};
