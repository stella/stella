import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import ts from "typescript";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import {
  PUBLIC_CORPUS_ROUTE_POLICY,
  resolvePublicCorpusPolicy,
} from "@/api/public-corpus-policy";

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "all",
]);

type RouterSource = {
  source: string;
  exportName: string;
  modules?: ReadonlyMap<string, string>;
  ancestors?: readonly string[];
};

const mountedRoutes = ({
  source,
  exportName,
  modules = new Map<string, string>(),
  ancestors = [],
}: RouterSource): string[] => {
  const identity = `${source}\n${exportName}`;
  if (ancestors.includes(identity)) {
    panic("Public route census rejects recursive composition");
  }
  const tree = ts.createSourceFile(
    "public-routes.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let initializer: ts.Expression | undefined;
  let routerDeclarationName: ts.Identifier | undefined;
  for (const statement of tree.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === exportName
      ) {
        initializer = declaration.initializer;
        routerDeclarationName = declaration.name;
      }
    }
  }
  if (!initializer) {
    for (const statement of tree.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) {
        continue;
      }
      const binding = bindings.elements.find(
        (item) => item.name.text === exportName,
      );
      if (!binding) {
        continue;
      }
      const importedSource = modules.get(statement.moduleSpecifier.text);
      if (importedSource === undefined) {
        panic("Public route census requires source for composed imports");
      }
      return mountedRoutes({
        source: importedSource,
        exportName: binding.propertyName?.text ?? binding.name.text,
        modules,
        ancestors: [...ancestors, identity],
      });
    }
    panic(`Public route census missing router ${exportName}`);
  }
  if (ts.isArrowFunction(initializer)) {
    if (ts.isBlock(initializer.body)) {
      panic("Public route census requires an expression-bodied router factory");
    }
    initializer = initializer.body;
  }
  // A reference can alias or mutate the router outside its declaration chain.
  // Fail closed rather than let registrations bypass the policy census.
  const rejectRouterReferences = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === exportName &&
      node !== routerDeclarationName
    ) {
      const plugin =
        ts.isCallExpression(node.parent) && node.parent.expression === node
          ? node.parent
          : node;
      const use = plugin.parent;
      if (
        !ts.isCallExpression(use) ||
        !ts.isPropertyAccessExpression(use.expression) ||
        use.expression.name.text !== "use" ||
        use.arguments.length !== 1 ||
        use.arguments.at(0) !== plugin
      ) {
        panic(
          "Public route census requires all registrations in the declaration chain",
        );
      }
    }
    ts.forEachChild(node, rejectRouterReferences);
  };
  rejectRouterReferences(tree);

  const routes: string[] = [];
  let expression = initializer;
  while (ts.isCallExpression(expression)) {
    if (!ts.isPropertyAccessExpression(expression.expression)) {
      panic("Public route census requires a direct Elysia chain");
    }
    const method = expression.expression.name.text;
    if (HTTP_METHODS.has(method)) {
      const routePath = expression.arguments.at(0);
      if (!routePath || !ts.isStringLiteralLike(routePath)) {
        panic("Public route census requires literal paths");
      }
      routes.push(`${method.toUpperCase()} ${routePath.text}`);
    } else if (method === "use") {
      const plugin = expression.arguments.at(0);
      if (!plugin || expression.arguments.length !== 1) {
        panic("Public route census requires one composed router");
      }
      const reference = ts.isCallExpression(plugin)
        ? plugin.expression
        : plugin;
      if (!ts.isIdentifier(reference)) {
        panic("Public route census requires a named composed router");
      }
      routes.push(
        ...mountedRoutes({
          source,
          exportName: reference.text,
          modules,
          ancestors: [...ancestors, identity],
        }),
      );
    } else if (method !== "onBeforeHandle" && method !== "onTransform") {
      panic(`Public route census does not support ${method} composition`);
    }
    expression = expression.expression.expression;
  }
  if (
    !ts.isNewExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "Elysia"
  ) {
    panic("Public route census requires an Elysia root");
  }
  const options = expression.arguments?.at(0);
  if (!options && !expression.arguments?.length) {
    return routes.toSorted();
  }
  if (!options || !ts.isObjectLiteralExpression(options)) {
    panic("Public route census requires literal options");
  }
  const prefixProperty = options.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === "prefix",
  );
  if (
    options.properties.some(
      (property) =>
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)),
    )
  ) {
    panic("Public route census requires literal option properties");
  }
  if (!prefixProperty) {
    return routes.toSorted();
  }
  if (
    !ts.isPropertyAssignment(prefixProperty) ||
    !ts.isStringLiteralLike(prefixProperty.initializer)
  ) {
    panic("Public route census requires a literal prefix");
  }
  const prefix = prefixProperty.initializer.text;
  return routes
    .map((route) => route.replace(" /", () => ` ${prefix}/`))
    .toSorted();
};

const readMountedRoutes = async () => {
  const sources = await Promise.all([
    Bun.file(
      new URL("../../handlers/legislation/public-routes.ts", import.meta.url),
    ).text(),
    Bun.file(
      new URL("../../handlers/case-law/public-routes.ts", import.meta.url),
    ).text(),
    Bun.file(new URL("../deployment-feature-route.ts", import.meta.url)).text(),
  ]);
  const legislation = sources.at(0);
  const caseLaw = sources.at(1);
  const featureGate = sources.at(2);
  if (
    legislation === undefined ||
    caseLaw === undefined ||
    featureGate === undefined
  ) {
    panic("Missing public router source");
  }
  const modules = new Map([
    ["@/api/lib/deployment-feature-route", featureGate],
  ]);
  return [
    ...mountedRoutes({
      source: legislation,
      exportName: "publicLegislationRoute",
      modules,
    }),
    ...mountedRoutes({
      source: caseLaw,
      exportName: "publicCaseLawRoute",
      modules,
    }),
  ].toSorted();
};

type CensusOptions = {
  mounted: readonly string[];
  classified: readonly string[];
};

const expectCompletePolicy = ({ mounted, classified }: CensusOptions) => {
  expect(
    [...classified].toSorted(),
    "Every mounted route must have exactly one policy; removed routes must leave no stale policy",
  ).toEqual([...mounted].toSorted());
};

describe("public corpus admission policy", () => {
  test("classifies exactly the routes mounted by both public corpus routers", async () => {
    const mounted = await readMountedRoutes();
    expect(mounted.length).toBeGreaterThan(0);
    expectCompletePolicy({
      mounted,
      classified: Object.keys(PUBLIC_CORPUS_ROUTE_POLICY),
    });
  });

  test("the census rejects an unclassified route and a stale removed route", () => {
    const initial =
      'export const publicRoute = new Elysia({ prefix: "/law" }).get("/statutes", handler);';
    const added = initial.replace(
      ".get",
      '.post("/new-expensive-route", handler).get',
    );
    const removed = initial.replace('.get("/statutes", handler)', "");
    const classified = mountedRoutes({
      source: initial,
      exportName: "publicRoute",
    });
    const newRoutes = mountedRoutes({
      source: added,
      exportName: "publicRoute",
    });
    const removedRoutes = mountedRoutes({
      source: removed,
      exportName: "publicRoute",
    });
    expect(newRoutes).toContain("POST /law/new-expensive-route");
    expect(removedRoutes).toEqual([]);
    expect(() =>
      expectCompletePolicy({ mounted: newRoutes, classified }),
    ).toThrow("Every mounted route");
    expect(() =>
      expectCompletePolicy({ mounted: removedRoutes, classified }),
    ).toThrow("Every mounted route");
  });

  test("source enumeration ignores comments and fails closed on indirect route mounts", () => {
    const source =
      'export const publicRoute = new Elysia({ prefix: "/law" }) /* .get("/fiction", handler) */ .get(`/statutes`, handler);';
    expect(mountedRoutes({ source, exportName: "publicRoute" })).toEqual([
      "GET /law/statutes",
    ]);
    for (const suffix of [
      ".get(path, handler)",
      ".use(otherRouter)",
      '.group("/nested", configure)',
      '.route("GET", "/statutes", handler)',
      '.ws("/socket", handler)',
      ".unknownPlugin(configure)",
    ]) {
      const indirect = `export const publicRoute = new Elysia({ prefix: "/law" })${suffix};`;
      expect(() =>
        mountedRoutes({ source: indirect, exportName: "publicRoute" }),
      ).toThrow("Public route census");
    }
  });

  test("composed imports enumerate nested routes and keep exact policy coverage", () => {
    const source =
      'import { gate as featureGate } from "gate"; export const publicRoute = new Elysia({ prefix: "/law" }).use(featureGate(enabled)).get("/statutes", handler);';
    const gate =
      'import { nested } from "nested"; export const gate = (enabled) => new Elysia().onTransform({ as: "scoped" }, hook).use(nested);';
    const nested =
      'export const nested = new Elysia({ prefix: "/extra" }).post("/resolve", handler);';
    const modules = new Map([
      ["gate", gate],
      ["nested", nested],
    ]);
    const mounted = mountedRoutes({
      source,
      exportName: "publicRoute",
      modules,
    });
    expect(mounted).toEqual(["GET /law/statutes", "POST /law/extra/resolve"]);
    const classified = ["GET /law/statutes"];
    expect(() => expectCompletePolicy({ mounted, classified })).toThrow(
      "Every mounted route",
    );
    const removed = mountedRoutes({
      source,
      exportName: "publicRoute",
      modules: new Map([
        ["gate", gate],
        ["nested", nested.replace('.post("/resolve", handler)', "")],
      ]),
    });
    expect(removed).toEqual(classified);
    expect(() =>
      expectCompletePolicy({ mounted: removed, classified: mounted }),
    ).toThrow("Every mounted route");
  });

  test("local routers and factories contribute their prefixed routes", () => {
    const source =
      'const nested = new Elysia({ prefix: "/extra" }).get("/items", handler); const plugin = () => new Elysia().use(nested); export const publicRoute = new Elysia({ prefix: "/law" }).use(plugin());';
    expect(mountedRoutes({ source, exportName: "publicRoute" })).toEqual([
      "GET /law/extra/items",
    ]);
  });

  test("composition fails closed when its source cannot be fully enumerated", () => {
    const source =
      'import { plugin } from "plugin"; export const publicRoute = new Elysia({ prefix: "/law" }).use(plugin());';
    for (const plugin of [
      "export const plugin = () => configure(new Elysia());",
      "export const plugin = () => { return new Elysia(); };",
      "export const plugin = () => new Elysia().get(path, handler);",
      "export const plugin = () => new Elysia().use(plugin());",
      'export const plugin = new Elysia(); plugin.get("/extra", handler);',
      "export const plugin = () => new Elysia({ ...options });",
      'export const plugin = () => new Elysia({ ["prefix"]: "/extra" });',
      "export const plugin = () => new Elysia({ prefix: prefix });",
    ]) {
      expect(() =>
        mountedRoutes({
          source,
          exportName: "publicRoute",
          modules: new Map([["plugin", plugin]]),
        }),
      ).toThrow("Public route census");
    }
    expect(() => mountedRoutes({ source, exportName: "publicRoute" })).toThrow(
      "source for composed imports",
    );
  });

  test("separate registrations and router aliases cannot bypass the census", () => {
    const declaration =
      'export const publicRoute = new Elysia({ prefix: "/law" }).get("/statutes", handler);';
    expect(
      mountedRoutes({ source: declaration, exportName: "publicRoute" }),
    ).toEqual(["GET /law/statutes"]);
    for (const registration of [
      'publicRoute.get("/unclassified", handler);',
      'publicRoute["post"]("/unclassified", handler);',
      'const alias = publicRoute; alias.get("/unclassified", handler);',
      'const { get } = publicRoute; get("/unclassified", handler);',
      "registerExtraRoutes(publicRoute);",
    ]) {
      expect(() =>
        mountedRoutes({
          source: `${declaration}\n${registration}`,
          exportName: "publicRoute",
        }),
      ).toThrow("all registrations in the declaration chain");
    }
  });

  test("search and aggregate endpoints use their expensive admission classes", () => {
    const expected = {
      "GET /law/statutes/search": "search",
      "POST /case/decisions/search": "search",
      "GET /case/decisions": "browse",
      "GET /law/statutes/facets": "aggregate",
      "GET /case/decisions/facets": "aggregate",
      "GET /case/provisions/citation-counts": "aggregate",
      "GET /case/provisions/citing-decisions": "aggregate",
      "POST /law/statutes/resolve": "aggregate",
      "GET /law/statutes/:documentId": "browse",
      "GET /case/decisions/:decisionId": "browse",
      "GET /law/sitemap/shards": "sitemap",
      "GET /law/sitemap/statutes/shard": "sitemap",
      "GET /case/sitemap/shards": "sitemap",
      "GET /case/sitemap/decisions/shard": "sitemap",
    } as const;
    for (const [route, admissionClass] of Object.entries(expected)) {
      const [method, path] = route.split(" ");
      if (!method || !path) {
        panic("Invalid policy route");
      }
      const url = `https://example.test${STELLA_API_VERSION_PREFIX}${path.replace(/:[^/]+/gu, "record-id")}`;
      expect(resolvePublicCorpusPolicy({ method, url })).toMatchObject({
        route,
        class: admissionClass,
      });
    }
  });

  test("every mounted route resolves with query strings, trailing slashes and GET HEAD parity", () => {
    for (const [route, admissionClass] of Object.entries(
      PUBLIC_CORPUS_ROUTE_POLICY,
    )) {
      const [method, path] = route.split(" ");
      if (!method || !path) {
        panic("Invalid policy route");
      }
      const concretePath = path.replace(/:[^/]+/gu, "record-id");
      for (const suffix of ["", "/", "?country=cz", "/?country=cz"]) {
        const url = `https://example.test${STELLA_API_VERSION_PREFIX}${concretePath}${suffix}`;
        expect(resolvePublicCorpusPolicy({ method, url })).toMatchObject({
          route,
          class: admissionClass,
        });
        if (method === "GET") {
          expect(
            resolvePublicCorpusPolicy({ method: "HEAD", url }),
          ).toMatchObject({ route, class: admissionClass });
        }
      }
    }
  });

  test("literal routes take precedence over identifier paths", () => {
    for (const route of [
      "GET /law/statutes/facets",
      "GET /law/statutes/search",
      "GET /law/statutes/by-eli",
      "GET /case/decisions/facets",
      "GET /case/decisions/status",
      "GET /case/decisions/latest",
    ] as const) {
      const path = route.slice(4);
      expect(
        resolvePublicCorpusPolicy({
          method: "GET",
          url: `https://example.test${STELLA_API_VERSION_PREFIX}${path}`,
        }),
      ).toMatchObject({ route, class: PUBLIC_CORPUS_ROUTE_POLICY[route] });
    }
  });

  test("unrelated routes, unsupported methods and unmatched extra segments remain outside admission", () => {
    for (const request of [
      {
        method: "POST",
        url: `https://example.test${STELLA_API_VERSION_PREFIX}/law/statutes/search`,
      },
      {
        method: "GET",
        url: `https://example.test${STELLA_API_VERSION_PREFIX}/case/decisions/id/extra`,
      },
      {
        method: "GET",
        url: `https://example.test${STELLA_API_VERSION_PREFIX}/lawyers/statutes`,
      },
      {
        method: "GET",
        url: `https://example.test${STELLA_API_VERSION_PREFIX}/health`,
      },
    ]) {
      expect(resolvePublicCorpusPolicy(request)).toBeUndefined();
    }
  });
});
