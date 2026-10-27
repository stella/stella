import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  type CallExpression,
  type Node,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree.ts";

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
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
]);

/** A gate call anywhere under `root`; `direct` stops at nested functions. */
const hasGateCall = (
  root: Node,
  gateNames: ReadonlySet<string>,
  { direct }: { direct: boolean },
): boolean => {
  let found = false;
  walk(root, (node) => {
    if (found || (direct && FUNCTION_TYPES.has(node.type))) {
      return "skip-children";
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      gateNames.has(node.callee.name)
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
  for (const statement of source.module.staticImports) {
    if (statement.moduleRequest.value !== TIME_BILLING_HOOK) {
      continue;
    }
    for (const entry of statement.entries) {
      // oxc-parser declares ImportNameKind as an ambient const enum of strings.
      const kind: string = entry.importName.kind;
      if (
        kind === "Name" &&
        entry.importName.name?.startsWith("isTimeBilling")
      ) {
        gateNames.add(entry.localName.value);
      }
    }
  }
  let declaration: CallExpression | undefined;
  walk(source.program, (node) => {
    if (declaration !== undefined) {
      return "skip-children";
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "CallExpression" &&
      node.callee.callee.type === "Identifier" &&
      node.callee.callee.name === "createFileRoute"
    ) {
      declaration = node;
    }
    return undefined;
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
        property.kind === "init" &&
        !property.shorthand &&
        !property.computed &&
        source.sourceText.slice(property.key.start, property.key.end) ===
          "beforeLoad" &&
        (property.value.type === "ArrowFunctionExpression" ||
          property.value.type === "FunctionExpression") &&
        property.value.body !== null &&
        hasGateCall(property.value.body, gateNames, { direct: true }),
    );
  if (
    gateNames.size > 0 &&
    !dedicated &&
    (!MIXED_ROUTE_REASONS.has(routePath) ||
      !hasGateCall(source.program, gateNames, { direct: false }))
  ) {
    throw new Error(`Time-billing route lost its beforeLoad gate: ${filePath}`);
  }
  return { filePath, routePath, dedicated };
};

/** Real dedicated guards plus descendants that inherit their beforeLoad. */
export const listTimeBillingRoutes = (routesDirectory = ROUTES_DIRECTORY) => {
  const routes = readdirSync(routesDirectory, {
    recursive: true,
    encoding: "utf-8",
  })
    .filter((file) => file.endsWith(".tsx"))
    .flatMap((file) => {
      const route = readRoute(path.join(routesDirectory, file));
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
