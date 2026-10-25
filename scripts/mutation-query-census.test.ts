import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

import { compareCodeUnit } from "@stll/collation";

import {
  inspectMutationQuerySources,
  isMutationQueryCensusSource,
} from "./mutation-query-census";

test("census source selection excludes test files and whole fixture directory segments", () => {
  const cases = [
    ["apps/web/src/view.ts", true],
    ["apps/web/src/view.tsx", true],
    ["apps/web/src/view.test.ts", false],
    ["apps/web/src/view.spec.tsx", false],
    ["apps/web/src/view.type-test.ts", false],
    ["apps/web/src/view.fixture.js", false],
    ["apps/web/src/view.fixtures.mjs", false],
    ["apps/web/src/view.test-fixtures.ctsx", false],
    ["apps/web/src/view-test-fixtures.ts", false],
    ["apps/web/src/-test-fixtures.jsx", false],
    ["apps/web/src/view test-fixtures.ts", true],
    ["apps/web/src/view name-test-fixtures.ts", true],
    ["apps/web/src/view name.test-fixtures.ts", false],
    ["apps/web/src/view.d.ts", false],
    ["apps/web/src/__tests__/view.ts", false],
    ["apps/web/src/__fixtures__/view.ts", false],
    ["apps/web/src/fixtures/view.ts", false],
    ["apps/web/src/test-fixtures/view.ts", false],
    ["apps/web/src/e2e/view.ts", false],
    ["apps/web/src/fixtures-other/view.ts", true],
  ] as const;
  for (const [file, included] of cases) {
    expect({ file, included: isMutationQueryCensusSource(file) }).toEqual({
      file,
      included,
    });
  }
});

test("transitive reader wrappers retain bound keys and routes without classifying option factories as executing wrappers", () => {
  const census = inspectMutationQuerySources([
    {
      file: "apps/web/src/read-through.ts",
      text: `
        import { queryOptions } from "@tanstack/react-query";
        export const read = (options) => queryClient.query(options);
        export const through = (options) => read(options);
        export const withClient = (client, options) => run(async () => client.query({ ...options, staleTime: "static" }));
        export const factory = (id) => queryOptions({ queryKey: ["factory", id], queryFn: externalRead });
      `,
    },
    {
      file: "apps/web/src/consumer.ts",
      text: `
        import { through as load, withClient, factory } from "./read-through";
        import { api } from "@/api";
        load({ queryKey: ["documents", id], queryFn: () => api.documents({ id }).get() });
        load(withResources({ resources: ["entity"] }, { queryKey: ["tagged"], queryFn: () => api.documents.get() }));
        withClient(queryClient, { queryKey: ["callback"], queryFn: () => api.documents.get() });
        factory(id);
      `,
    },
  ]);
  const wrappers = census.readers.filter(({ kind }) => kind === "wrapper");
  expect(wrappers.map(({ callee }) => callee).toSorted()).toEqual([
    "load",
    "load",
    "read",
    "withClient",
  ]);
  expect(wrappers.find(({ callee }) => callee === "load")).toMatchObject({
    key: { staticPrefix: ["documents"] },
    routes: [{ route: "/documents/:id", method: "get" }],
    wrapperOf: ["apps/web/src/read-through.ts:read:queryClient.query"],
  });
  expect(wrappers.find(({ callee }) => callee === "withClient")).toMatchObject({
    key: { staticPrefix: ["callback"] },
    routes: [{ route: "/documents", method: "get" }],
  });
  expect(wrappers.filter(({ callee }) => callee === "load")).toHaveLength(2);
  expect(census.readers.some(({ callee }) => callee === "factory")).toBe(false);
});

test("route reader helpers census their options argument", () => {
  const census = inspectMutationQuerySources([
    {
      file: "apps/web/src/route.ts",
      text: `
        import { ensureRouteInfiniteQueryData, ensureRouteQueryData } from "@/lib/react-query";
        const tagged = { queryKey: ["organization", "settings"], queryFn: async () => null };
        ensureRouteQueryData(queryClient, tagged);
        ensureRouteInfiniteQueryData(queryClient, { queryKey: ["organization", "pages"], queryFn: async () => null });
      `,
    },
  ]);
  expect(
    census.readers
      .map(({ callee, key }) => ({ callee, key }))
      .toSorted((left, right) => compareCodeUnit(left.callee, right.callee)),
  ).toEqual([
    {
      callee: "ensureRouteInfiniteQueryData",
      key: expect.objectContaining({ staticPrefix: ["organization", "pages"] }),
    },
    {
      callee: "ensureRouteQueryData",
      key: expect.objectContaining({
        staticPrefix: ["organization", "settings"],
      }),
    },
  ]);
});

test("installed QueryClient read methods retain readers and exclude resolved key factories", () => {
  const reactQueryEntry = Bun.resolveSync(
    "@tanstack/react-query",
    path.resolve(import.meta.dir, "../apps/web"),
  );
  const queryCoreManifest = Bun.resolveSync(
    "@tanstack/query-core/package.json",
    path.dirname(reactQueryEntry),
  );
  const source = ts.createSourceFile(
    "queryClient.ts",
    readFileSync(
      path.join(path.dirname(queryCoreManifest), "src/queryClient.ts"),
      "utf-8",
    ),
    ts.ScriptTarget.Latest,
    true,
  );
  const client = source.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) &&
      statement.name?.text === "QueryClient",
  );
  if (!client) {
    throw new TypeError("Installed query-core must declare QueryClient");
  }
  const methods = client.members
    .filter(ts.isMethodDeclaration)
    .map(({ name }) => name.getText(source))
    .filter((name) =>
      /^(?:query|infiniteQuery|(?:fetch|prefetch|ensure)(?:Infinite)?Query(?:Data)?)$/u.test(
        name,
      ),
    );
  expect(methods).toContain("query");
  expect(methods).toContain("infiniteQuery");
  for (const method of client.members.filter(ts.isMethodDeclaration)) {
    if (!methods.includes(method.name.getText(source))) {
      continue;
    }
    expect(
      method.parameters.some(
        (parameter) =>
          parameter.name.getText(source) !== "this" &&
          parameter.questionToken === undefined &&
          parameter.initializer === undefined &&
          parameter.dotDotDotToken === undefined,
      ),
    ).toBe(true);
  }
  const census = inspectMutationQuerySources([
    {
      file: "apps/web/src/readers.ts",
      text: `
        import { QueryClient as Client, useQueryClient as useClient } from "@tanstack/react-query";
        import { api } from "@/api";
        const client = new Client();
        const hookClient = useClient();
        const alias = hookClient;
        ${methods.map((method) => `client.${method}({ queryKey: ["documents"], queryFn: () => api.documents.get() });`).join("\n")}
        alias.query({ queryKey: ["hook"], queryFn: () => api.documents.get() });
        const searchKeys = { query: (term) => ["search", term] };
        searchKeys.query("words");
        unknownClient.query({ queryKey: ["unknown"], queryFn: externalRead });
      `,
    },
  ]);
  expect(census.readers).toHaveLength(methods.length + 2);
  expect(census.readers.map(({ kind }) => kind).toSorted()).toEqual(
    [...methods, "query", "query"].toSorted(),
  );
  expect(
    census.readers.find(({ callee }) => callee === "alias.query")?.unresolved,
  ).toEqual([]);
  expect(
    census.readers.find(({ callee }) => callee === "unknownClient.query")
      ?.unresolved,
  ).toContainEqual({
    reason: "unresolved-query-client-receiver",
    expression: "unknownClient.query",
    file: "apps/web/src/readers.ts",
  });
  expect(
    census.readers.some(({ callee }) => callee === "searchKeys.query"),
  ).toBe(false);
});

test("zero-argument platform queries do not hide real cache readers or their wrappers", () => {
  const census = inspectMutationQuerySources([
    {
      file: "apps/web/src/readers.ts",
      text: `
        import { QueryClient, useQueryClient } from "@tanstack/react-query";
        const client = new QueryClient();
        const hookClient = useQueryClient();
        locks.query();
        unknownClient.infiniteQuery();
        client.query();
        hookClient.infiniteQuery();
        unknownClient.query({ queryKey: ["unknown"], queryFn: externalRead });
        const read = () => unknownClient.query({ queryKey: ["real"], queryFn: externalRead });
        read();
        const shadowedPlatform = (navigator) => navigator.query({ queryKey: ["shadowed"], queryFn: externalRead });
      `,
    },
  ]);
  expect(census.readers.map(({ callee }) => callee).toSorted()).toEqual([
    "client.query",
    "hookClient.infiniteQuery",
    "navigator.query",
    "read",
    "unknownClient.query",
    "unknownClient.query",
  ]);
  expect(census.readers.find(({ callee }) => callee === "read")?.kind).toBe(
    "wrapper",
  );
  expect(
    census.readers.find(({ callee }) => callee === "navigator.query")
      ?.unresolved,
  ).toContainEqual({
    reason: "unresolved-query-client-receiver",
    expression: "navigator.query",
    file: "apps/web/src/readers.ts",
  });
});

test("import aliases and transitive wrappers retain every mutation call and bind forwarded options", () => {
  const census = inspectMutationQuerySources([
    {
      file: "apps/web/src/writer.ts",
      text: `
      import { useMutation as useWrite, mutationOptions as options } from "@tanstack/react-query";
      import { api } from "@/api";
      export const useSave = (input) => useWrite(input);
      export const useWrappedSave = (input) => useSave(input);
      export const savedOptions = options({ mutationFn: () => api.entities({ workspaceId }).rename.patch({ name }) });
    `,
    },
    {
      file: "apps/web/src/consumer.ts",
      text: `
      import { useWrappedSave as save } from "./writer";
      import { api } from "@/api";
      const queryClient = client;
      const useEditor = () => save({
        mutationFn: async () => { const response = await api.entities({ workspaceId }).rename.patch({ name }); return response; },
        onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["entities", workspaceId] }); },
      });
    `,
    },
  ]);
  expect(census.mutations).toHaveLength(4);
  const wrapper = census.mutations.find(({ callee }) => callee === "save");
  expect(wrapper).toMatchObject({
    kind: "wrapper",
    writes: [{ route: "/entities/:workspaceId/rename", method: "patch" }],
    cacheEffects: [
      { operation: "invalidateQueries", key: { staticPrefix: ["entities"] } },
    ],
  });
  expect(wrapper?.wrapperOf).toContain(
    "apps/web/src/writer.ts:useSave:useWrite",
  );
  expect(
    census.mutations.find(({ callee }) => callee === "useWrite")?.unresolved,
  ).toContainEqual({
    reason: "dynamic-options",
    expression: "input",
    file: "apps/web/src/writer.ts",
  });
});

test("plain mutation wrappers inherit primitive writes and unresolved options without owning them", () => {
  const census = inspectMutationQuerySources([
    {
      file: "apps/web/src/plain-wrapper.ts",
      text: `
        import { useMutation as useWrite, mutationOptions } from "@tanstack/react-query";
        import { api } from "@/api";
        const request = () => api.entities({ workspaceId }).rename.patch({ name });
        const useSave = () => useWrite({ ...unknownOptions, mutationFn: request });
        const useWrapped = () => useSave();
        useWrapped();
        mutationOptions({ mutationFn: unknownRequest });
      `,
    },
  ]);
  expect(census.schemaVersion).toBe(2);
  expect(census.mutations).toHaveLength(4);
  for (const entry of census.mutations) {
    switch (entry.kind) {
      case "wrapper":
        expect(entry.writes).toMatchObject([
          { route: "/entities/:workspaceId/rename", method: "patch" },
        ]);
        expect(entry.unresolved.map(({ reason }) => reason)).toContain(
          "dynamic-options-spread",
        );
        expect(entry.ownWrites).toEqual([]);
        expect(entry.ownUnresolved).toEqual([]);
        break;
      case "useMutation":
      case "mutationOptions":
        expect(entry.ownWrites).toEqual(entry.writes);
        expect(entry.ownUnresolved).toEqual(entry.unresolved);
        break;
      default:
        entry.kind satisfies never;
    }
  }
});

test("outside ownership scans skip canonical factory callbacks but retain eager and shadowed writes", () => {
  const census = inspectMutationQuerySources([
    {
      file: "apps/web/src/lib/workspace-realtime.ts",
      text: `export const resourceMutation = (options: unknown) => options;`,
    },
    {
      file: "apps/web/src/mutation-wrapper.ts",
      text: `
        import { useMutation } from "@tanstack/react-query";
        import * as realtime from "./lib/workspace-realtime";
        import { resourceMutation } from "./lib/workspace-realtime";
        import { api } from "@/api";
        const request = () => api.entities({ workspaceId }).rename.patch({ name });
        const useRegistered = () => {
          const eagerMutation = realtime.resourceMutation({
            queryClient: api.entities({ workspaceId }).delete.delete({ id }),
            mutationFn: request,
          });
          return useMutation({ mutationFn: eagerMutation });
        };
        const useRegisteredCaller = () => useRegistered();
        const useShadowed = (resourceMutation: (options: unknown) => unknown) => {
          const mutation = resourceMutation({ mutationFn: request });
          return useMutation({ mutationFn: mutation });
        };
        const useShadowedCaller = () => useShadowed((options) => options);
      `,
    },
  ]);
  const wrapper = (callee: string) =>
    census.mutations.find(
      (entry) => entry.kind === "wrapper" && entry.callee === callee,
    );
  expect(wrapper("useRegistered")?.ownWrites).toMatchObject([
    { route: "/entities/:workspaceId/delete", method: "delete" },
  ]);
  expect(wrapper("useRegistered")?.ownWrites).not.toMatchObject([
    { route: "/entities/:workspaceId/rename", method: "patch" },
  ]);
  expect(wrapper("useShadowed")?.ownWrites).toMatchObject([
    { route: "/entities/:workspaceId/rename", method: "patch" },
  ]);
});

test("raw helper calls remain owned even when an inherited primitive invokes the identical helper", () => {
  const census = inspectMutationQuerySources([
    {
      file: "apps/web/src/raw-wrapper.ts",
      text: `
        import { useMutation } from "@tanstack/react-query";
        import { api } from "@/api";
        const request = () => api.entities({ workspaceId }).rename.patch({ name });
        const useSave = () => useMutation({ mutationFn: request });
        const useWrapped = () => {
          const mutation = useSave();
          request();
          return mutation;
        };
        useWrapped();
      `,
    },
  ]);
  expect(census.mutations).toHaveLength(3);
  const wrapper = census.mutations.find(
    ({ callee }) => callee === "useWrapped",
  );
  expect(wrapper?.writes).toHaveLength(1);
  expect(wrapper?.ownWrites).toEqual(wrapper?.writes);
  expect(wrapper?.ownWrites).toMatchObject([
    { route: "/entities/:workspaceId/rename", method: "patch" },
  ]);
  expect(wrapper?.ownUnresolved).toEqual([]);
  expect(
    census.mutations.find(({ callee }) => callee === "useSave")?.ownWrites,
  ).toEqual([]);
});

test("own scans traverse ordinary middle wrappers and retain their unresolved operations", () => {
  const census = inspectMutationQuerySources([
    {
      file: "apps/web/src/middle-wrapper.ts",
      text: `
        import { useMutation } from "@tanstack/react-query";
        import { api } from "@/api";
        const request = () => api.entities({ workspaceId }).rename.patch({ name });
        const rawRequest = () => {
          request();
          return { mutationFn: unknownRequest };
        };
        const useBase = () => useMutation({ ...unknownOptions, mutationFn: request });
        const useMiddle = () => {
          const mutation = useBase();
          rawRequest();
          return mutation;
        };
        const useOuter = () => useMiddle();
        useOuter();
      `,
    },
  ]);
  expect(census.mutations).toHaveLength(4);
  for (const callee of ["useMiddle", "useOuter"]) {
    const wrapper = census.mutations.find((entry) => entry.callee === callee);
    expect(wrapper?.ownWrites).toMatchObject([
      { route: "/entities/:workspaceId/rename", method: "patch" },
    ]);
    expect(wrapper?.ownUnresolved).toEqual([
      {
        reason: "dynamic-operation-function",
        expression: "unknownRequest",
        file: "apps/web/src/middle-wrapper.ts",
      },
    ]);
    expect(wrapper?.unresolved.map(({ reason }) => reason)).toContain(
      "dynamic-options-spread",
    );
  }
  expect(
    census.mutations.find(({ callee }) => callee === "useBase")?.ownWrites,
  ).toEqual([]);
});

test("reader callbacks cannot conceal a wrapper's extra write behind a query primitive", () => {
  const census = inspectMutationQuerySources([
    {
      file: "apps/web/src/query-wrapper.ts",
      text: `
        import { useMutation, useQuery } from "@tanstack/react-query";
        import { api } from "@/api";
        const useRename = () => useMutation({
          mutationFn: () => api.entities({ workspaceId }).rename.patch({ name }),
        });
        const useWrapper = () => {
          const mutation = useRename();
          useQuery({ queryKey: ["documents"], queryFn: () => api.documents({ id }).patch({ name }) });
          return mutation;
        };
        useWrapper();
      `,
    },
  ]);
  const wrapper = census.mutations.find(
    ({ callee }) => callee === "useWrapper",
  );
  expect(wrapper?.writes).toHaveLength(2);
  expect(wrapper?.ownWrites).toMatchObject([
    { route: "/documents/:id", method: "patch" },
  ]);
  expect(wrapper?.ownWrites).toHaveLength(1);
});

test("reader factories, API chain elements and imported cache helpers resolve without executing modules", () => {
  const census = inspectMutationQuerySources([
    {
      file: "apps/web/src/keys.ts",
      text: `
      export const keys = { all: ["documents"], detail: (id) => [...keys.all, id] };
    `,
    },
    {
      file: "apps/web/src/queries.ts",
      text: `
      import { queryOptions, useQuery } from "@tanstack/react-query";
      import { api } from "@/api";
      import { keys } from "./keys";
      export const documentOptions = (id) => queryOptions({
        queryKey: keys.detail(id), queryFn: () => api.documents({ id })["name-preview"].get(),
      });
      useQuery(documentOptions(id));
      export const refresh = (client) => client.invalidateQueries({ queryKey: keys.all });
    `,
    },
    {
      file: "apps/web/src/editor.ts",
      text: `
      import { useMutation } from "@tanstack/react-query";
      import { api } from "@/api";
      import { refresh } from "./queries";
      const useEditor = () => useMutation({
        mutationFn: () => api.documents({ id }).patch({ name }),
        onSuccess: () => refresh(client),
      });
    `,
    },
  ]);
  expect(census.readers).toHaveLength(2);
  expect(
    census.readers.every(({ key }) => key?.staticPrefix.at(0) === "documents"),
  ).toBe(true);
  expect(
    census.readers.every(({ routes }) =>
      routes.some(({ route }) => route === "/documents/:id/name-preview"),
    ),
  ).toBe(true);
  expect(census.mutations).toHaveLength(1);
  expect(census.mutations.at(0)?.readerIds).toHaveLength(2);
  expect(census.mutations.at(0)?.cacheEffects).toMatchObject([
    {
      operation: "invalidateQueries",
      key: { staticPrefix: ["documents"], unresolved: false },
    },
  ]);
});

test("namespace destructuring, local aliases and re-exported wrapper calls cannot disappear", () => {
  const census = inspectMutationQuerySources([
    {
      file: "apps/web/src/base.ts",
      text: `
      import * as Query from "@tanstack/react-query";
      const { useMutation: write } = Query;
      const alias = write;
      const save = (options) => alias(options);
      export { save as useSave };
    `,
    },
    {
      file: "apps/web/src/barrel.ts",
      text: `export { useSave as useWrite } from "./base";`,
    },
    {
      file: "apps/web/src/view.ts",
      text: `
      import { useWrite } from "./barrel";
      useWrite(dynamicOptions);
    `,
    },
  ]);
  expect(census.mutations.map(({ callee }) => callee).toSorted()).toEqual([
    "alias",
    "useWrite",
  ]);
  expect(
    census.mutations.every(({ unresolved }) => unresolved.length > 0),
  ).toBe(true);
});

test("package export maps and external primitive reexports retain mutation callers", () => {
  const census = inspectMutationQuerySources(
    [
      {
        file: "packages/writer/src/public.ts",
        text: `export { useMutation as write } from "@tanstack/react-query";`,
      },
      {
        file: "apps/web/src/view.ts",
        text: `import { write } from "@stll/writer"; write(options);`,
      },
    ],
    new Map([["@stll/writer", "packages/writer/src/public.ts"]]),
  );
  expect(census.mutations).toHaveLength(1);
  expect(census.mutations.at(0)).toMatchObject({
    callee: "write",
    kind: "useMutation",
  });
});

test("unknown options and computed writes remain explicit while unrelated uncalled helpers add no effects", () => {
  const census = inspectMutationQuerySources([
    {
      file: "apps/web/src/editor.ts",
      text: `
    import { useMutation } from "@tanstack/react-query";
    const useEditor = () => useMutation({
      ...dynamicOptions,
      mutationFn: externalWrite,
      onSuccess: () => {
        const unused = () => client.invalidateQueries({ queryKey: ["unrelated"] });
        return result;
      },
    });
  `,
    },
  ]);
  expect(census.mutations).toHaveLength(1);
  expect(census.mutations.at(0)?.cacheEffects).toEqual([]);
  expect(
    census.mutations
      .at(0)
      ?.unresolved.map(({ reason }) => reason)
      .toSorted(),
  ).toEqual([
    "dynamic-operation-function",
    "dynamic-options-spread",
    "no-static-write-route",
  ]);
});

test("declaration-based ids and facts survive line shifts deterministically", () => {
  const text = `import { useMutation } from "@tanstack/react-query";
    export const useSave = () => useMutation({ mutationFn: unknownWrite });`;
  const analyze = (source: string) =>
    inspectMutationQuerySources([
      { file: "apps/web/src/save.ts", text: source },
    ]);
  const original = analyze(text);
  const shifted = analyze(`\n\n${text}`);
  expect(shifted.mutations.map(({ id }) => id)).toEqual(
    original.mutations.map(({ id }) => id),
  );
  expect(analyze(text)).toEqual(original);
  expect(original.mutations.at(0)?.id).toBe(
    "apps/web/src/save.ts:useSave:useMutation",
  );
});
