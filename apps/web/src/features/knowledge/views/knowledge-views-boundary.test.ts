import { describe, expect, test } from "bun:test";
/**
 * The shared Knowledge views render whatever source and actions a route hands
 * them. Their runtime import graph must stay free of every module that reads
 * or writes data or knows who is signed in, so a view can only show what its
 * route chose to give it.
 */
import { existsSync, statSync } from "node:fs";
import nodePath from "node:path";

import { repoRelativePath } from "@stll/portable-path";

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

type ScannedImport = { path: string; dynamic: boolean };

/** Runtime imports only: the scanner drops type-only imports, which never
 *  load. `dynamic` marks an `import()`, which loads only when it runs. */
const scanModuleImports = async (file: string): Promise<ScannedImport[]> => {
  const source = await Bun.file(file).text();
  const loader = file.endsWith(".tsx") ? "tsx" : "ts";
  return new Bun.Transpiler({ loader })
    .scan(source)
    .imports.map(({ path, kind }) => ({
      path,
      dynamic: kind === "dynamic-import",
    }));
};

const scanImports = async (file: string): Promise<string[]> =>
  (await scanModuleImports(file)).map(({ path }) => path);

/**
 * Every module `entrypoint` can load, mapped to the module that imports it.
 * With `followDynamic: false` the walk stops at `import()`: what loads the
 * moment the entrypoint does, before any lazy branch is chosen.
 */
const collectGraph = async (
  entrypoint: string,
  {
    followDynamic = true,
    stopAt = new Set<string>(),
  }: { followDynamic?: boolean; stopAt?: ReadonlySet<string> } = {},
  visited = new Map<string, string>(),
  importer = entrypoint,
): Promise<Map<string, string>> => {
  if (visited.has(entrypoint)) {
    return visited;
  }
  visited.set(entrypoint, importer);
  // A module the walk is told to stop at is listed but not entered: a route's
  // page, which the bundler splits into a chunk of its own.
  if (!/\.tsx?$/u.test(entrypoint) || stopAt.has(entrypoint)) {
    return visited;
  }
  const imports = await scanModuleImports(entrypoint);
  for (const { path, dynamic } of imports) {
    if (dynamic && !followDynamic) {
      continue;
    }
    const resolved = resolveWebModule(path, entrypoint);
    if (resolved !== null) {
      await collectGraph(
        resolved,
        { followDynamic, stopAt },
        visited,
        entrypoint,
      );
    }
  }
  return visited;
};

/** The modules `entrypoint` loads lazily, directly or through its static graph. */
const collectDynamicImports = async (entrypoint: string) => {
  const graph = await collectGraph(entrypoint, { followDynamic: false });
  const lazy = new Set<string>();
  for (const module of graph.keys()) {
    if (!/\.tsx?$/u.test(module)) {
      continue;
    }
    for (const { path, dynamic } of await scanModuleImports(module)) {
      const resolved = dynamic ? resolveWebModule(path, module) : null;
      if (resolved !== null) {
        lazy.add(resolved);
      }
    }
  }
  return lazy;
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

const relative = (module: string) => repoRelativePath(webSourceRoot, module);

describe("shared Knowledge views", () => {
  test("exist for the sections moved so far", () => {
    expect(sharedViewFiles.map(relative)).toEqual(
      expect.arrayContaining([
        "features/knowledge/views/templates/template-list-view.tsx",
        "features/knowledge/views/playbooks/playbooks-page-view.tsx",
        "features/knowledge/views/tools/tools-catalogue-view.tsx",
        "features/knowledge/views/tools/tool-detail-panel-view.tsx",
      ]),
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

// ── Section routes ────────────────────────────────────

/** An organization's Knowledge: its adapter, its queries, its pages. */
const MEMBER_MODULES = ["lib/knowledge/queries.ts"].map(fromSource);
const MEMBER_DIRECTORIES = [
  "features/knowledge/member",
  "routes/knowledge/-member",
].map((path) => `${fromSource(path)}${nodePath.sep}`);

const isMemberModule = (module: string) =>
  MEMBER_MODULES.includes(module) ||
  MEMBER_DIRECTORIES.some((directory) => module.startsWith(directory));

/**
 * The switches that still pick a container from the session. Each may reach
 * member code only through a lazy import, so a visitor without an account
 * never evaluates it.
 */
const DISPATCHERS = [
  "routes/knowledge/index.tsx",
  "routes/knowledge/-knowledge-audience-gate.tsx",
  "routes/knowledge/-catalogue-template-actions.tsx",
].map(fromSource);

/** What a dispatcher loads lazily for a member, and nothing else. */
const LAZY_MEMBER_CONTAINERS = {
  "routes/knowledge/index.tsx": [
    "routes/knowledge/-member/member-knowledge-landing.tsx",
  ],
  "routes/knowledge/-catalogue-template-actions.tsx": [
    "routes/knowledge/-member/member-catalogue-template-actions.tsx",
  ],
} as const satisfies Record<string, readonly string[]>;

/**
 * An organization's own pages and the one module each route renders. The
 * route imports its page statically, so the bundler splits it into the
 * route's own chunk and the manifest preloads it; everything else the route
 * file loads (its options, its pending view) ships with the route tree and
 * must stay free of member code.
 */
const MEMBER_ROUTE_PAGES = {
  "routes/knowledge/templates.tsx":
    "routes/knowledge/-member/templates.page.tsx",
  "routes/knowledge/playbooks.tsx":
    "routes/knowledge/-member/playbooks.page.tsx",
  "routes/knowledge/tools.tsx": "routes/knowledge/-member/tools.page.tsx",
  "routes/knowledge/tools_.skills.$skillId.tsx":
    "routes/knowledge/-member/tool-skill.page.tsx",
} as const satisfies Record<string, string>;

/** Pages that read the same for every visitor: no member code, even lazily. */
const PUBLIC_ROUTES = [
  "routes/knowledge/templates_.catalogue.tsx",
  "routes/knowledge/templates_.catalogue.index.tsx",
  "routes/knowledge/playbooks_.catalogue.tsx",
  "routes/knowledge/tools_.catalogue.tsx",
  "routes/knowledge/tools_.$entry.tsx",
].map(fromSource);

/** The detail page reaches the member actions through its lazy dispatcher. */
const PUBLIC_ROUTES_WITH_DISPATCHER = [
  "routes/knowledge/templates_.catalogue.$packId.$templateId.tsx",
].map(fromSource);

const PUBLIC_CONTAINER_ROOT = fromSource("routes/knowledge/-public");

const publicContainerFiles = [
  ...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: PUBLIC_CONTAINER_ROOT }),
]
  .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
  .map((file) => nodePath.resolve(PUBLIC_CONTAINER_ROOT, file))
  .toSorted();

const memberReach = (graph: Map<string, string>) =>
  [...graph.entries()]
    .filter(([module]) => isMemberModule(module))
    .map(
      ([module, importer]) =>
        `${relative(module)} (imported by ${relative(importer)})`,
    );

describe("Knowledge section routes", () => {
  test.each(
    [...DISPATCHERS, ...PUBLIC_ROUTES_WITH_DISPATCHER].map((file) => [
      relative(file),
      file,
    ]),
  )(
    "%s loads no member module before a member is known",
    async (_name, file) => {
      const graph = await collectGraph(file, { followDynamic: false });
      expect(memberReach(graph)).toEqual([]);
    },
  );

  test.each(Object.entries(LAZY_MEMBER_CONTAINERS))(
    "%s reaches member code only through its lazy member container",
    async (dispatcher, containers) => {
      const lazyMember = [
        ...(await collectDynamicImports(fromSource(dispatcher))),
      ]
        .filter(isMemberModule)
        .map(relative)
        .toSorted();
      expect(lazyMember).toEqual([...containers].toSorted());
    },
  );

  test.each(Object.entries(MEMBER_ROUTE_PAGES))(
    "%s reaches member code only through its page, imported statically",
    async (route, page) => {
      const routeFile = fromSource(route);
      const staticImports = (await scanModuleImports(routeFile))
        .filter(({ dynamic }) => !dynamic)
        .map(({ path }) => resolveWebModule(path, routeFile));
      expect(staticImports).toContain(fromSource(page));
      expect(
        [...(await collectDynamicImports(routeFile))].filter(isMemberModule),
      ).toEqual([]);

      const eager = await collectGraph(routeFile, {
        followDynamic: false,
        stopAt: new Set([fromSource(page)]),
      });
      expect(
        memberReach(eager).filter((line) => !line.startsWith(`${page} `)),
      ).toEqual([]);
    },
  );

  test.each(PUBLIC_ROUTES.map((file) => [relative(file), file]))(
    "%s reaches no member module, even lazily",
    async (_name, file) => {
      expect(memberReach(await collectGraph(file))).toEqual([]);
    },
  );

  test("public containers exist for the sections opened so far", () => {
    expect(publicContainerFiles.map(relative)).toEqual(
      expect.arrayContaining([
        "routes/knowledge/-public/public-templates-catalogue.tsx",
        "routes/knowledge/-public/playbooks-catalogue.page.tsx",
        "routes/knowledge/-public/tools-catalogue.page.tsx",
        "routes/knowledge/-public/tool-entry.page.tsx",
      ]),
    );
  });

  // Including every lazy branch and every slot or action the container hands
  // to the shared views: a visitor's page has no path to member code at all.
  test.each(publicContainerFiles.map((file) => [relative(file), file]))(
    "%s reaches no member module, even lazily",
    async (_name, file) => {
      expect(memberReach(await collectGraph(file))).toEqual([]);
    },
  );

  // The walks must see through a lazy import and into a page, or the rules
  // above would pass for a route that loads member code eagerly as well.
  test("the walk tells a lazy member container from an eager one", async () => {
    const eager = await collectGraph(
      fromSource("routes/knowledge/-member/member-templates-page.tsx"),
      { followDynamic: false },
    );
    expect([...eager.keys()].some(isMemberModule)).toBe(true);
  });

  test("the walk stops at a page only where it is told to", async () => {
    const route = fromSource("routes/knowledge/templates.tsx");
    const whole = await collectGraph(route, { followDynamic: false });
    expect(
      memberReach(whole).some((line) =>
        line.startsWith("routes/knowledge/-member/member-templates-page.tsx "),
      ),
    ).toBe(true);
  });
});

const SIGNED_IN_FRAME = fromSource("routes/-protected-app.tsx");

/** Modules every page loads, or pages for visitors without an account. */
const FRAME_FREE_ENTRIES = [
  "routes/__root.tsx",
  "routes/-app-frame-host.tsx",
  "routes/-knowledge-public-frame.tsx",
  "routes/-protected-guard.ts",
  "routes/-protected-pending-skeleton.tsx",
  "routes/_protected.tsx",
  "routes/knowledge/route.tsx",
].map(fromSource);

describe("the signed-in frame", () => {
  test.each(FRAME_FREE_ENTRIES.map((file) => [relative(file), file]))(
    "%s does not load the signed-in frame eagerly",
    async (_name, file) => {
      const graph = await collectGraph(file, { followDynamic: false });
      expect(graph.has(SIGNED_IN_FRAME)).toBe(false);
    },
  );

  test("the frame host loads it lazily, once a member is known", async () => {
    const lazy = await collectDynamicImports(
      fromSource("routes/-app-frame-host.tsx"),
    );
    expect(lazy.has(SIGNED_IN_FRAME)).toBe(true);
  });
});
