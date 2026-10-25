import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  type CallExpression,
  type Node,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree";

const ROUTES_DIRECTORY = path.resolve(import.meta.dirname, "../../src/routes");
const TIME_BILLING_HOOK = "@/hooks/use-time-billing-preview";
const MIXED_ROUTE_REASONS = new Map([
  [
    "/_protected/admin",
    "Only matched settings admission and the time-policy prefetch are gated.",
  ],
  [
    "/_protected/workspaces/$workspaceId/$viewId",
    "The overview conditionally prefetches billing alongside unrelated matter data.",
  ],
]);

const hasGateCall = (node: Node, gateNames: ReadonlySet<string>): boolean => {
  let found = false;
  walk(node, (child) => {
    if (
      child.type === "CallExpression" &&
      child.callee.type === "Identifier" &&
      gateNames.has(child.callee.name)
    ) {
      found = true;
    }
    return undefined;
  });
  return found;
};
const hasDirectGateCall = (
  node: Node,
  gateNames: ReadonlySet<string>,
): boolean => {
  let found = false;
  walk(node, (child) => {
    if (
      [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
      ].includes(child.type)
    ) {
      return "skip-children";
    }
    if (
      child.type === "CallExpression" &&
      child.callee.type === "Identifier" &&
      gateNames.has(child.callee.name)
    ) {
      found = true;
    }
    return undefined;
  });
  return found;
};
const readRoute = (filePath: string) => {
  const source = parseSource(filePath, readFileSync(filePath, "utf-8"));
  const gateNames = new Set<string>();
  for (const statement of source.program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.source.value !== TIME_BILLING_HOOK
    ) {
      continue;
    }
    for (const element of statement.specifiers) {
      if (element.type !== "ImportSpecifier") {
        continue;
      }
      const exportedName =
        element.imported.type === "Identifier"
          ? element.imported.name
          : element.imported.value;
      if (exportedName.startsWith("isTimeBilling")) {
        gateNames.add(element.local.name);
      }
    }
  }
  let declaration: CallExpression | undefined;
  walk(source.program, (node) => {
    if (
      declaration === undefined &&
      node.type === "CallExpression" &&
      node.callee.type === "CallExpression" &&
      node.callee.callee.type === "Identifier" &&
      node.callee.callee.name === "createFileRoute"
    ) {
      declaration = node;
    }
  });
  if (declaration?.callee.type !== "CallExpression") {
    return null;
  }
  const routeArgument = declaration.callee.arguments.at(0);
  if (
    routeArgument?.type !== "Literal" ||
    typeof routeArgument.value !== "string"
  ) {
    return null;
  }
  const routePath = routeArgument.value.replace(/\/$/u, "");
  const options = declaration.arguments.at(0);
  const dedicated =
    options?.type === "ObjectExpression" &&
    options.properties.some(
      (property) =>
        property.type === "Property" &&
        source.sourceText.slice(property.key.start, property.key.end) ===
          "beforeLoad" &&
        (property.value.type === "ArrowFunctionExpression" ||
          property.value.type === "FunctionExpression") &&
        hasDirectGateCall(property.value.body, gateNames),
    );
  if (
    gateNames.size > 0 &&
    !dedicated &&
    (!MIXED_ROUTE_REASONS.has(routePath) ||
      !hasGateCall(source.program, gateNames))
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
