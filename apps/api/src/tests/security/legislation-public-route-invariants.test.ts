import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { publicLegislationRoute } from "@/api/handlers/legislation/public-routes";
import { isSafePublicHandler } from "@/api/lib/api-handlers";
import {
  apiSourceRoot,
  collectApiImports,
  scanModuleImports,
} from "@/api/tests/api-module-graph";

const PUBLIC_LEGISLATION_ROUTES = [
  "GET /law/sitemap/shards",
  "GET /law/sitemap/statutes/shard",
  "GET /law/statutes",
  "GET /law/statutes/:documentId",
  "GET /law/statutes/:documentId/provisions/:anchor/history",
  "GET /law/statutes/:documentId/provisions/:anchor/preview",
  "GET /law/statutes/:documentId/versions",
  "GET /law/statutes/by-eli",
  "GET /law/statutes/by-slug/:slug",
  "GET /law/statutes/facets",
  "GET /law/statutes/search",
  "GET /law/statutes/shelf",
  "POST /law/statutes/resolve",
] as const;

const routesFile = nodePath.resolve(
  apiSourceRoot,
  "handlers/legislation/public-routes.ts",
);
const handlerFactoryFile = nodePath.resolve(
  apiSourceRoot,
  "lib/api-handlers.ts",
);

// Shared schema loads these domain declarations; none runs auth or a model.
// Keep traversing them so an execution dependency added later still fails.
const PUBLIC_SCHEMA_DOMAIN_IMPORTS = new Set([
  "@/api/handlers/chat/chat-turn-state",
  "@/api/lib/chat/ai-data-policy",
  "@/api/lib/chat/thread-name-kinds",
]);

const isForbiddenPublicRuntimeImport = (path: string): boolean => {
  const modulePath = path.replace(/\.tsx?$/u, "");
  if (PUBLIC_SCHEMA_DOMAIN_IMPORTS.has(modulePath)) {
    return false;
  }
  return (
    /^@\/api\/(?:lib\/auth(?:$|\/)|lib\/chat\/|lib\/tanstack-ai-models|handlers\/chat\/)/u.test(
      modulePath,
    ) ||
    /^(?:@tanstack\/ai(?:$|-)|@ai-sdk\/|openai$|@anthropic-ai\/sdk$)/u.test(
      modulePath,
    )
  );
};

// The factory module also owns signed-in factories. Its public execution
// branch is selected by the runtime stamp census, not its shared imports.
const collectPublicOperationGraph = async (
  entrypoint: string,
  visited = new Set<string>(),
): Promise<Set<string>> => {
  if (entrypoint === handlerFactoryFile || visited.has(entrypoint)) {
    return visited;
  }
  visited.add(entrypoint);
  const imports = await collectApiImports(entrypoint);
  await Promise.all(
    imports.map(
      async (dependency) =>
        await collectPublicOperationGraph(dependency, visited),
    ),
  );
  return visited;
};

describe("public legislation route boundary", () => {
  test("every declared public legislation route uses a public-safe handler", () => {
    const declared = publicLegislationRoute.routes.filter(
      (route) => typeof route.handler === "function",
    );
    expect(
      declared
        .filter((route) => !isSafePublicHandler(route.handler))
        .map((route) => `${route.method} ${route.path}`),
    ).toEqual([]);
    expect(
      declared.map((route) => `${route.method} ${route.path}`).toSorted(),
    ).toEqual([...PUBLIC_LEGISLATION_ROUTES]);
  });

  test("public legislation operations cannot import authentication or model execution", async () => {
    const modules = await collectPublicOperationGraph(routesFile);
    for (const path of [
      "handlers/legislation/public-search.ts",
      "handlers/legislation/search.ts",
      "lib/legislation-public-read-db.ts",
    ]) {
      expect(modules.has(nodePath.resolve(apiSourceRoot, path))).toBe(true);
    }

    const forbiddenImports: string[] = [];
    for (const module of modules) {
      const relativePath = nodePath.relative(apiSourceRoot, module);
      if (isForbiddenPublicRuntimeImport(`@/api/${relativePath}`)) {
        forbiddenImports.push(relativePath);
      }
      for (const path of await scanModuleImports(module)) {
        if (isForbiddenPublicRuntimeImport(path)) {
          forbiddenImports.push(
            `${nodePath.relative(apiSourceRoot, module)} -> ${path}`,
          );
        }
      }
    }
    expect(forbiddenImports.toSorted()).toEqual([]);
  });

  test("the boundary permits schema domains and erased types while rejecting runtime execution", () => {
    const domainImports = [...PUBLIC_SCHEMA_DOMAIN_IMPORTS];
    for (const path of domainImports) {
      expect(isForbiddenPublicRuntimeImport(path)).toBe(false);
      expect(isForbiddenPublicRuntimeImport(`${path}.ts`)).toBe(false);
    }
    const executionImports = [
      "@/api/lib/auth",
      "@/api/lib/auth.ts",
      "@/api/handlers/chat/turn-execution",
      "@/api/lib/chat/ai-data-policy-execution",
      "@/api/lib/tanstack-ai-models",
      "@tanstack/ai",
      "@tanstack/ai-openai",
      "@ai-sdk/openai",
      "openai",
      "@anthropic-ai/sdk",
    ];
    const source = [
      'import type { StreamChunk } from "@tanstack/ai";',
      'import { type Message } from "@/api/handlers/chat/types";',
      ...domainImports.map(
        (path, index) => `import { domain${index} } from "${path}";`,
      ),
      ...executionImports.map(
        (path, index) => `import { execution${index} } from "${path}";`,
      ),
    ].join("\n");
    const runtimeImports = new Bun.Transpiler({ loader: "ts" }).scan(
      source,
    ).imports;
    expect(runtimeImports.map(({ path }) => path).toSorted()).toEqual(
      [...domainImports, ...executionImports].toSorted(),
    );
    expect(
      runtimeImports
        .filter(({ path }) => isForbiddenPublicRuntimeImport(path))
        .map(({ path }) => path)
        .toSorted(),
    ).toEqual(executionImports.toSorted());
  });

  test("public legislation routing never installs authenticated context", async () => {
    const source = await Bun.file(routesFile).text();
    for (const token of [
      "authMacro",
      "permissionMacro",
      "workspaceAccessMacro",
      "validateAuth",
      "permissions:",
    ]) {
      expect(source).not.toContain(token);
    }
  });
});
