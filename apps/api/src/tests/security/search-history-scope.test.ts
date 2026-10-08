import { describe, expect, test } from "bun:test";
import path from "node:path";

const featureDirectory = path.resolve(
  import.meta.dir,
  "../../handlers/search-history",
);

const routeMethods =
  /\.(get|head|options|post|put|patch|delete|all|route)\s*\(/gu;
const mutationMethods = new Set([
  "post",
  "put",
  "patch",
  "delete",
  "all",
  "route",
]);

type ScopeSources = Record<string, string>;

/** Closed registration syntax: a newly unsupported route fails rather than escaping the census. */
const scopeOffenders = (sources: ScopeSources): string[] => {
  const routes = sources["routes.ts"];
  if (routes === undefined) {
    return ["routes.ts is absent"];
  }
  const imports = new Map(
    [
      ...routes.matchAll(
        /import\s+(\w+)\s+from\s+["'](?:@\/api\/handlers\/search-history\/|\.\/)([\w-]+)["']/gu,
      ),
    ].map((match) => [match.at(1), `${match.at(2)}.ts`]),
  );
  const starts = [...routes.matchAll(routeMethods)];
  const offenders: string[] = [];
  for (const [index, registration] of starts.entries()) {
    const method = registration.at(1);
    if (method === undefined || !mutationMethods.has(method)) {
      continue;
    }
    const block = routes.slice(registration.index, starts.at(index + 1)?.index);
    const parsed =
      /^\.\w+\s*\(\s*["'][^"']+["']\s*,\s*(\w+)\.handler\s*,\s*\{/u.exec(block);
    const handlerName = parsed?.at(1);
    if (handlerName === undefined) {
      offenders.push(`Unsupported mutation registration: ${method}`);
      continue;
    }
    const filename = imports.get(handlerName);
    const source = filename === undefined ? undefined : sources[filename];
    if (source === undefined) {
      offenders.push(`${handlerName}: handler source is absent`);
      continue;
    }
    if (
      !new RegExp(
        `\\bquery\\s*:\\s*${handlerName}\\.config\\.query\\b`,
        "u",
      ).test(block)
    ) {
      offenders.push(`${handlerName}: route query is not the handler config`);
    }
    if (!/\bquery\s*:\s*searchHistoryScopeQuery\b/u.test(source)) {
      offenders.push(`${handlerName}: shared query schema is absent`);
    }
    if (
      !/import\s*\{[^}]*\bassertSearchHistoryScope\b[^}]*\}\s*from\s*["']\.\/scope-precondition["']/u.test(
        source,
      )
    ) {
      offenders.push(`${handlerName}: shared precondition import is absent`);
    }
    const firstCheck =
      /createSafeRootHandler\s*\(\s*config\s*,\s*async\s+function\s*\*\s*\([^)]*\)\s*\{\s*yield\s*\*\s*assertSearchHistoryScope\s*\(\s*\{([^{}]*)\}\s*\)\s*;/u.exec(
        source,
      );
    const args = firstCheck
      ?.at(1)
      ?.split(",")
      .map((field) => field.replaceAll(/\s+/gu, ""))
      .filter(Boolean)
      .toSorted();
    if (
      JSON.stringify(args) !==
      JSON.stringify([
        "organizationId:session.activeOrganizationId",
        "query",
        "userId:user.id",
      ])
    ) {
      offenders.push(
        `${handlerName}: first statement does not check the authenticated scope`,
      );
    }
  }
  if (
    !starts.some((registration) =>
      mutationMethods.has(registration.at(1) ?? ""),
    )
  ) {
    offenders.push("No mutation routes were enumerated");
  }
  return offenders;
};

const readScopeSources = async () => {
  const names = [
    ...new Bun.Glob("*.ts").scanSync({
      cwd: featureDirectory,
      onlyFiles: true,
    }),
  ].filter((name) => !name.endsWith(".test.ts"));
  const entries = await Promise.all(
    names.map(
      async (name) =>
        [
          name,
          await Bun.file(path.join(featureDirectory, name)).text(),
        ] as const,
    ),
  );
  return Object.fromEntries(entries);
};

describe("search history scope census", () => {
  test("every discovered mutation binds its schema and checks authenticated scope first", async () => {
    expect(scopeOffenders(await readScopeSources())).toEqual([]);
  });

  test("the census rejects an imported mutation with its initial check removed", async () => {
    const sources = await readScopeSources();
    const source = sources["import.ts"];
    if (source === undefined) {
      throw new TypeError("Import source is absent");
    }
    const planted = source.replace(
      /yield\s*\*\s*assertSearchHistoryScope\s*\(\s*\{[^]*?\}\s*\)\s*;/u,
      "",
    );
    expect(planted).not.toBe(source);
    expect(scopeOffenders({ ...sources, "import.ts": planted })).toContain(
      "importSearchHistory: first statement does not check the authenticated scope",
    );
  });

  test("a newly registered mutation without a scope contract cannot escape discovery", async () => {
    const sources = await readScopeSources();
    const routes = sources["routes.ts"];
    if (routes === undefined) {
      throw new TypeError("Route source is absent");
    }
    const planted = {
      ...sources,
      "routes.ts": `import plantedHistory from "./planted";\n${routes}\n.post("/planted", plantedHistory.handler, { permissions: plantedHistory.config.permissions });`,
      "planted.ts": `const config = {}; const handler = async function* ({ safeDb }) { yield* safeDb(); };`,
    };
    const offenders = scopeOffenders(planted);
    expect(offenders).toContain(
      "plantedHistory: route query is not the handler config",
    );
    expect(offenders).toContain(
      "plantedHistory: shared query schema is absent",
    );
    expect(offenders).toContain(
      "plantedHistory: first statement does not check the authenticated scope",
    );
  });
});
