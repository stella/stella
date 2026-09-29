import { describe, expect, test } from "bun:test";
/**
 * The shared Knowledge views render whatever source and actions a route hands
 * them. Their runtime import graph must stay free of every module that reads
 * or writes data or knows who is signed in, so a view can only show what its
 * route chose to give it.
 */
import { existsSync, statSync } from "node:fs";
import nodePath from "node:path";

const webSourceRoot = nodePath.resolve(import.meta.dir, "../../..");
const viewsRoot = nodePath.resolve(webSourceRoot, "features/knowledge/views");

const fromSource = (path: string) => nodePath.resolve(webSourceRoot, path);

/** Modules a shared view must never reach, directly or through a helper. */
const FORBIDDEN_MODULES = [
  "lib/api.ts",
  "lib/auth-client.ts",
  "lib/auth-queries.ts",
  "lib/knowledge/queries.ts",
  "hooks/use-permissions.ts",
  "hooks/use-client-auth-status.ts",
  "lib/authenticated-user-context.tsx",
].map(fromSource);

/** Directories a shared view must never reach: route modules and adapters. */
const FORBIDDEN_DIRECTORIES = ["routes", "features/knowledge/member"].map(
  (path) => `${fromSource(path)}${nodePath.sep}`,
);

/** Packages a shared view must not import itself: views do not fetch. */
const FORBIDDEN_DIRECT_PACKAGES = ["@tanstack/react-query"];

const resolveWebModule = (
  importPath: string,
  importer: string,
): string | null => {
  let basePath: string;
  if (importPath.startsWith("@/")) {
    basePath = nodePath.resolve(webSourceRoot, importPath.slice("@/".length));
  } else if (importPath.startsWith(".")) {
    basePath = nodePath.resolve(nodePath.dirname(importer), importPath);
  } else {
    return null;
  }

  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    nodePath.resolve(basePath, "index.ts"),
    nodePath.resolve(basePath, "index.tsx"),
  ];
  return (
    candidates.find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    ) ?? null
  );
};

/** Runtime imports only: the scanner drops type-only imports, which never load. */
const scanImports = async (file: string): Promise<string[]> => {
  const source = await Bun.file(file).text();
  const loader = file.endsWith(".tsx") ? "tsx" : "ts";
  return new Bun.Transpiler({ loader })
    .scan(source)
    .imports.map(({ path }) => path);
};

const collectGraph = async (
  entrypoint: string,
  visited = new Map<string, string>(),
  importer = entrypoint,
): Promise<Map<string, string>> => {
  if (visited.has(entrypoint)) {
    return visited;
  }
  visited.set(entrypoint, importer);
  if (!/\.tsx?$/u.test(entrypoint)) {
    return visited;
  }
  const imports = await scanImports(entrypoint);
  for (const specifier of imports) {
    const resolved = resolveWebModule(specifier, entrypoint);
    if (resolved !== null) {
      await collectGraph(resolved, visited, entrypoint);
    }
  }
  return visited;
};

const sharedViewFiles = [
  ...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: viewsRoot }),
]
  .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
  .map((file) => nodePath.resolve(viewsRoot, file))
  .toSorted();

const isForbidden = (module: string) =>
  FORBIDDEN_MODULES.includes(module) ||
  FORBIDDEN_DIRECTORIES.some((directory) => module.startsWith(directory));

const relative = (module: string) => nodePath.relative(webSourceRoot, module);

describe("shared Knowledge views", () => {
  test("exist for the sections moved so far", () => {
    expect(sharedViewFiles.map(relative)).toContain(
      "features/knowledge/views/templates/template-list-view.tsx",
    );
  });

  test.each(sharedViewFiles.map((file) => [relative(file), file]))(
    "%s reaches no data, auth, route or adapter module",
    async (_name, file) => {
      const graph = await collectGraph(file);
      const reached = [...graph.entries()]
        .filter(([module]) => isForbidden(module))
        .map(
          ([module, importer]) =>
            `${relative(module)} (imported by ${relative(importer)})`,
        );
      expect(reached).toEqual([]);
    },
  );

  test.each(sharedViewFiles.map((file) => [relative(file), file]))(
    "%s imports no data-fetching package",
    async (_name, file) => {
      const imports = await scanImports(file);
      expect(
        imports.filter((specifier) =>
          FORBIDDEN_DIRECT_PACKAGES.includes(specifier),
        ),
      ).toEqual([]);
    },
  );

  // The guard is only as good as its reach: walking the member adapter must
  // find the tenant queries and the API client behind it.
  test("the walk finds the modules the member adapter reaches", async () => {
    const graph = await collectGraph(
      fromSource("features/knowledge/member/member-templates.ts"),
    );
    expect([...graph.keys()].filter(isForbidden).map(relative)).toEqual(
      expect.arrayContaining(["lib/api.ts", "lib/knowledge/queries.ts"]),
    );
  });
});
