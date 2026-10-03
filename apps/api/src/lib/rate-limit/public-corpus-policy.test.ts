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

type RouterSource = { source: string; exportName: string };

const mountedRoutes = ({ source, exportName }: RouterSource): string[] => {
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
    panic(`Missing public router ${exportName}`);
  }
  // A reference can alias or mutate the router outside its declaration chain.
  // Fail closed rather than let registrations bypass the policy census.
  const rejectRouterReferences = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === exportName &&
      node !== routerDeclarationName
    ) {
      panic(
        "Public route census requires all registrations in the declaration chain",
      );
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
    } else if (method !== "onBeforeHandle") {
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
    !prefixProperty ||
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
  ]);
  const legislation = sources.at(0);
  const caseLaw = sources.at(1);
  if (legislation === undefined || caseLaw === undefined) {
    panic("Missing public router source");
  }
  return [
    ...mountedRoutes({
      source: legislation,
      exportName: "publicLegislationRoute",
    }),
    ...mountedRoutes({ source: caseLaw, exportName: "publicCaseLawRoute" }),
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
