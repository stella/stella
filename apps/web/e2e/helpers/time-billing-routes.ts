import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROUTES_DIRECTORY = path.resolve(import.meta.dirname, "../../src/routes");
const TIME_BILLING_HOOK = "@/hooks/use-time-billing-preview";
const MIXED_ROUTE_REASONS = new Map([
  [
    "/_protected/settings/organization",
    "Only the time-policy prefetch is gated.",
  ],
  [
    "/_protected/workspaces/$workspaceId/$viewId",
    "The overview conditionally prefetches billing alongside unrelated matter data.",
  ],
]);

const hasGateCall = (
  node: ts.Node,
  gateNames: ReadonlySet<string>,
): boolean => {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    gateNames.has(node.expression.text)
  ) {
    return true;
  }
  return (
    ts.forEachChild(node, (child) => hasGateCall(child, gateNames)) ?? false
  );
};

const hasDirectGateCall = (
  node: ts.Node,
  gateNames: ReadonlySet<string>,
): boolean => {
  if (ts.isFunctionLike(node)) {
    return false;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    gateNames.has(node.expression.text)
  ) {
    return true;
  }
  return (
    ts.forEachChild(node, (child) => hasDirectGateCall(child, gateNames)) ??
    false
  );
};

const readRoute = (filePath: string) => {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const gateNames = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== TIME_BILLING_HOOK
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      const exportedName = element.propertyName?.text ?? element.name.text;
      if (exportedName.startsWith("isTimeBilling")) {
        gateNames.add(element.name.text);
      }
    }
  }
  const findRouteDeclaration = (
    node: ts.Node,
  ): ts.CallExpression | undefined => {
    if (
      ts.isCallExpression(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "createFileRoute"
    ) {
      return node;
    }
    return ts.forEachChild(node, findRouteDeclaration);
  };
  const declaration = findRouteDeclaration(source);
  if (
    declaration === undefined ||
    !ts.isCallExpression(declaration.expression)
  ) {
    return null;
  }
  const routeArgument = declaration.expression.arguments.at(0);
  if (routeArgument === undefined || !ts.isStringLiteral(routeArgument)) {
    return null;
  }
  const routePath = routeArgument.text.replace(/\/$/u, "");
  const options = declaration.arguments.at(0);
  const dedicated =
    options !== undefined &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText(source) === "beforeLoad" &&
        (ts.isArrowFunction(property.initializer) ||
          ts.isFunctionExpression(property.initializer)) &&
        hasDirectGateCall(property.initializer.body, gateNames),
    );
  if (
    gateNames.size > 0 &&
    !dedicated &&
    (!MIXED_ROUTE_REASONS.has(routePath) || !hasGateCall(source, gateNames))
  ) {
    throw new Error(`Time-billing route lost its beforeLoad gate: ${filePath}`);
  }
  return { filePath, routePath, dedicated };
};

/** Real dedicated guards plus descendants that inherit their beforeLoad. */
export const listTimeBillingRoutes = () => {
  const routes = readdirSync(ROUTES_DIRECTORY, {
    recursive: true,
    encoding: "utf-8",
  })
    .filter((file) => file.endsWith(".tsx"))
    .flatMap((file) => {
      const route = readRoute(path.join(ROUTES_DIRECTORY, file));
      return route === null ? [] : [route];
    });
  const guarded = routes.filter((route) => route.dedicated);
  return routes.flatMap((route) => {
    const guard = guarded.find(
      (candidate) =>
        route.routePath === candidate.routePath ||
        route.routePath.startsWith(`${candidate.routePath}/`),
    );
    return guard === undefined
      ? []
      : [
          {
            filePath: route.filePath,
            routePath: route.routePath,
            guardFilePath: guard.filePath,
          },
        ];
  });
};
