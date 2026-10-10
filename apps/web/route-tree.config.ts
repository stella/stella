// The route tree's generator options, shared by the Start Vite plugin and
// scripts/generate-route-tree.ts so both write the same tree. Paths are in the
// Start plugin's form: `srcDirectory` from the web root, the rest from it.
export const ROUTE_TREE_OPTIONS = {
  srcDirectory: "src",
  routesDirectory: "routes",
  generatedRouteTree: "routeTree.gen.ts",
} as const;

// Exclude both the route file and directory before Start builds its module graph.
// Serving always includes fixtures, even with `vite dev --mode production`.
export const routeTreeOptions = (command: "serve" | "build") => ({
  ...ROUTE_TREE_OPTIONS,
  ...(command === "build" ? { routeFileIgnorePattern: "^dev(?:$|[.])" } : {}),
});
