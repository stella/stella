// The route tree's generator options, shared by the Start Vite plugin and
// scripts/generate-route-tree.ts so both write the same tree.
export const ROUTE_TREE_GENERATOR_OPTIONS = {
  routesDirectory: "src/routes",
  generatedRouteTree: "src/routeTree.gen.ts",
} as const;
