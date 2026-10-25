import {
  QueryClient,
  type QueryKey,
  type QueryMeta,
  QueryObserver,
  queryOptions,
} from "@tanstack/react-query";
import { organization } from "better-auth/plugins";
import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import * as v from "valibot";

import {
  REALTIME_EVENT_TYPE,
  RESOURCE_TYPE,
  type ResourceType,
} from "@stll/api-contract";
import { SIGNAL_VIEW } from "@stll/api-contract/signals";
import { rejectionOf } from "@stll/property-testing/rejection";

import { linkIconOptions } from "@/features/chat/link-icons";
import { getAnalytics } from "@/lib/analytics/provider";
import { fileMetadataOptions } from "@/lib/files/file-metadata-query";
import { fileMetadataByFieldQueryRoot } from "@/lib/files/file-metadata-query.logic";
import { fileOptions, textFileOptions } from "@/lib/files/queries";
import {
  inboxCountOptions,
  inboxKeys,
  inboxSignalOptions,
} from "@/lib/inbox/queries";
import {
  agentSkillsQueryRoot,
  catalogueQueryRoot,
  mcpQueryRoot,
} from "@/lib/resource-query-roots.logic";
import type { ViewLayout } from "@/lib/types";
import {
  applyResourceQueryActions,
  getWorkspaceRealtimeQueryActions,
  getWorkspaceReconnectQueryActions,
  RESOURCE_MUTATION_CONTRACTS,
  resourceMutation,
  resourceQueryOptions,
} from "@/lib/workspace-realtime";
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";
import {
  entityViewKeys,
  entityViewRowsOptions,
} from "@/lib/workspaces/queries/entity-views";
import {
  invoiceByIdOptions,
  invoicePrefillOptions,
  invoicesInfiniteOptions,
  invoicesKeys,
} from "@/lib/workspaces/queries/invoices";
import {
  timeEntriesKeys,
  timeEntriesOptions,
} from "@/lib/workspaces/queries/time-entries";

const WORKSPACE_ID = "workspace-rename";
const OTHER_WORKSPACE_ID = "workspace-other";
const FIELD_ID = "field-file";
const ORGANIZATION_ID = "organization-rename";
const USER_ID = "user-rename";
const coverageLayout = {
  version: 1,
  type: "table",
  filters: [],
  sorts: [],
  hiddenProperties: [],
  calculations: [],
  columnOrder: [],
  columnPinning: [],
} as const satisfies ViewLayout;

const previousCensusSchema = v.object({
  mutations: v.array(
    v.object({
      kind: v.string(),
      writes: v.array(v.object({ method: v.string(), route: v.string() })),
      cacheEffects: v.array(
        v.object({
          operation: v.string(),
          key: v.nullable(v.object({ factory: v.nullable(v.string()) })),
        }),
      ),
    }),
  ),
});

type PreviousInvalidation = {
  target: QueryKey;
  readers: { queryKey: QueryKey; meta?: QueryMeta }[];
};

// Historical factory names are resolved with current production keys and reader metadata.
const previousInvalidationFor = (factory: string): PreviousInvalidation => {
  switch (factory) {
    case "agentSkillsQueryRoot": {
      const target = agentSkillsQueryRoot();
      return { target, readers: [{ queryKey: target }] };
    }
    case "catalogueKeys.all": {
      const target = catalogueQueryRoot();
      return { target, readers: [{ queryKey: target }] };
    }
    case "knowledgeKeys.mcp.all":
    case "mcpQueryRoot": {
      const target = mcpQueryRoot();
      return { target, readers: [{ queryKey: target }] };
    }
    case "invoicesKeys.all": {
      const target = invoicesKeys.all(WORKSPACE_ID);
      const readers = [
        invoiceByIdOptions(WORKSPACE_ID, "invoice-coverage"),
        invoicePrefillOptions(WORKSPACE_ID),
        invoicesInfiniteOptions(WORKSPACE_ID, 20),
      ];
      return {
        target,
        readers: readers.map((reader) => ({
          queryKey: reader.queryKey,
          ...(reader.meta ? { meta: reader.meta } : {}),
        })),
      };
    }
    case "timeEntriesKeys.all": {
      const target = timeEntriesKeys.all(WORKSPACE_ID);
      const { queryKey, meta } = timeEntriesOptions(WORKSPACE_ID, USER_ID);
      return { target, readers: [{ queryKey, ...(meta ? { meta } : {}) }] };
    }
    case "entitiesKeys.all": {
      const target = entitiesKeys.all(WORKSPACE_ID);
      return { target, readers: [{ queryKey: target }] };
    }
    case "entityViewKeys.all": {
      const target = entityViewKeys.all(ORGANIZATION_ID, USER_ID);
      const readers = [
        entityViewRowsOptions({
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
          scope: { type: "matter", matterId: WORKSPACE_ID },
          layout: coverageLayout,
          inboxView: SIGNAL_VIEW.OPEN,
        }),
        entityViewRowsOptions({
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
          scope: { type: "organization" },
          layout: coverageLayout,
          inboxView: SIGNAL_VIEW.OPEN,
        }),
      ];
      return {
        target,
        readers: readers.map(({ queryKey, meta }) => ({ queryKey, meta })),
      };
    }
    case "inboxKeys.all": {
      const target = inboxKeys.all(ORGANIZATION_ID, USER_ID);
      const readers = [
        inboxCountOptions(ORGANIZATION_ID, USER_ID),
        inboxSignalOptions(ORGANIZATION_ID, USER_ID, "signal-rename"),
      ];
      return {
        target,
        readers: readers.map(({ queryKey, meta }) => ({ queryKey, meta })),
      };
    }
    case "fileMetadataByFieldQueryRoot": {
      const target = fileMetadataByFieldQueryRoot({
        workspaceId: WORKSPACE_ID,
        fieldId: FIELD_ID,
      });
      const { queryKey, meta } = fileMetadataOptions({
        workspaceId: WORKSPACE_ID,
        fieldId: FIELD_ID,
      });
      return { target, readers: [{ queryKey, meta }] };
    }
    default:
      throw new TypeError(`No production key resolver for ${factory}`);
  }
};

const isQueryKeyPrefix = (prefix: QueryKey, key: QueryKey) =>
  prefix.length <= key.length &&
  prefix.every(
    (part, index) => JSON.stringify(part) === JSON.stringify(key[index]),
  );

test("independent readers stay fresh across every resource event and reconnect", async () => {
  const queryClient = new QueryClient();
  const independent = resourceQueryOptions(
    queryOptions({
      queryKey: ["immutable-plan"],
      queryFn: async () => "plan",
      staleTime: Infinity,
    }),
    { type: "independent" },
  );
  const icon = linkIconOptions("example.test");
  for (const { queryKey, meta } of [independent, icon]) {
    queryClient.getQueryCache().build(queryClient, {
      queryKey,
      meta,
      queryFn: async () => null,
    });
  }
  try {
    for (const resourceType of Object.values(RESOURCE_TYPE)) {
      await applyResourceQueryActions(
        queryClient,
        getWorkspaceRealtimeQueryActions(
          {
            type: REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED,
            resourceType,
          },
          { queryClient, workspaceId: WORKSPACE_ID },
        ),
      );
    }
    await applyResourceQueryActions(
      queryClient,
      getWorkspaceReconnectQueryActions({
        queryClient,
        workspaceId: WORKSPACE_ID,
      }),
    );
    expect(queryClient.getQueryState(independent.queryKey)?.isInvalidated).toBe(
      false,
    );
    expect(queryClient.getQueryState(icon.queryKey)?.isInvalidated).toBe(false);
  } finally {
    queryClient.clear();
  }
});

test("each migrated mutation still invalidates every prior cache target", async () => {
  const root = path.resolve(import.meta.dir, "../../../../");
  const previousCensus = v.parse(
    previousCensusSchema,
    JSON.parse(
      readFileSync(
        path.join(root, "scripts/mutation-query-census.json"),
        "utf-8",
      ),
    ),
  );
  // This committed census preserves the cache effects from before helper migration.
  const mutationNames = Object.keys(RESOURCE_MUTATION_CONTRACTS).filter(
    (name): name is keyof typeof RESOURCE_MUTATION_CONTRACTS =>
      Object.hasOwn(RESOURCE_MUTATION_CONTRACTS, name),
  );
  for (const mutation of mutationNames) {
    const contract = RESOURCE_MUTATION_CONTRACTS[mutation];
    const routes = contract.writes.map(
      ({ method, route }) => `${method.toLowerCase()} ${route}`,
    );
    const previousMutations = previousCensus.mutations.filter(
      ({ kind, writes }) =>
        kind !== "wrapper" &&
        JSON.stringify(
          writes
            .map(({ method, route }) => `${method.toLowerCase()} ${route}`)
            .toSorted(),
        ) === JSON.stringify(routes.toSorted()),
    );
    if (previousMutations.length === 0) {
      continue;
    }
    const previousEffects = previousMutations.flatMap(({ cacheEffects }) =>
      cacheEffects.filter(({ operation }) => operation === "invalidateQueries"),
    );
    expect(previousEffects.length).toBeGreaterThan(0);
    const targets = previousEffects.map(({ key }) => {
      const factory = key?.factory;
      if (!factory) {
        throw new TypeError(
          "Previous invalidation has no resolvable key factory",
        );
      }
      return previousInvalidationFor(factory);
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    try {
      for (const { target, readers } of targets) {
        expect(readers.length).toBeGreaterThan(0);
        for (const { queryKey, meta } of readers) {
          expect(isQueryKeyPrefix(target, queryKey)).toBe(true);
          queryClient.getQueryCache().build(queryClient, {
            queryKey,
            ...(meta ? { meta } : {}),
            queryFn: async () => null,
          });
          expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(
            false,
          );
        }
      }
      const rename = resourceMutation({
        mutation,
        queryClient,
        mutationFn: async ({ workspaceId }: { workspaceId: string }) => ({
          workspaceId,
        }),
      });
      await rename({ workspaceId: WORKSPACE_ID });
      for (const { readers } of targets) {
        for (const { queryKey } of readers) {
          expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
        }
      }
    } finally {
      queryClient.clear();
    }
  }
});

test("organization mutations invalidate organization readers without touching workspace readers", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const organizationReader = resourceQueryOptions(
    queryOptions({
      queryKey: ["mcp", "organization"],
      queryFn: async () => "organization",
    }),
    {
      resources: [RESOURCE_TYPE.MCP_CONNECTOR],
      scope: { type: "organization" },
    },
  );
  const workspaceReader = resourceQueryOptions(
    queryOptions({
      queryKey: ["mcp", "workspace", WORKSPACE_ID],
      queryFn: async () => "workspace",
    }),
    {
      resources: [RESOURCE_TYPE.MCP_CONNECTOR],
      scope: { type: "workspace", workspaceId: WORKSPACE_ID },
    },
  );
  try {
    await Promise.all([
      queryClient.query(organizationReader),
      queryClient.query(workspaceReader),
    ]);
    const update = resourceMutation({
      mutation: "updateNativeTool",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async (enabled: boolean) => enabled,
    });

    await update(true);

    expect(
      queryClient.getQueryState(organizationReader.queryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(workspaceReader.queryKey)?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .some(({ queryKey }) => queryKey.includes(ORGANIZATION_ID)),
    ).toBe(false);
  } finally {
    queryClient.clear();
  }
});

test("cache invalidation failures preserve every registered mutation's committed result", async () => {
  const mutationNames = Object.keys(RESOURCE_MUTATION_CONTRACTS).filter(
    (name): name is keyof typeof RESOURCE_MUTATION_CONTRACTS =>
      Object.hasOwn(RESOURCE_MUTATION_CONTRACTS, name),
  );
  for (const mutation of mutationNames) {
    const queryClient = new QueryClient();
    const failure = new TypeError("Cache invalidation unavailable");
    const invalidate = spyOn(
      queryClient,
      "invalidateQueries",
    ).mockRejectedValue(failure);
    const capture = spyOn(getAnalytics(), "captureError");
    const committed = { workspaceId: WORKSPACE_ID, name: "confirmed" };
    const write = resourceMutation({
      mutation,
      queryClient,
      mutationFn: async () => committed,
    });
    try {
      expect(await write({ workspaceId: WORKSPACE_ID })).toBe(committed);
      expect(invalidate).toHaveBeenCalled();
      expect(capture).toHaveBeenCalledWith(
        expect.objectContaining({ cause: failure }),
        {
          type: "detached",
          operation: "resource-query.invalidate",
        },
      );
    } finally {
      invalidate.mockRestore();
      capture.mockRestore();
      queryClient.clear();
    }
  }
});

test("entity-view and inbox readers register rename dependencies and preserve work-family refresh", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const layout = {
    version: 1,
    type: "table",
    filters: [],
    sorts: [],
    hiddenProperties: [],
    calculations: [],
    columnOrder: [],
    columnPinning: [],
  } as const satisfies ViewLayout;
  const matterView = (matterId: string) =>
    entityViewRowsOptions({
      organizationId: "organization",
      userId: "user",
      scope: { type: "matter", matterId },
      layout,
      inboxView: SIGNAL_VIEW.OPEN,
    });
  const readers = [
    matterView(WORKSPACE_ID),
    matterView(OTHER_WORKSPACE_ID),
    entityViewRowsOptions({
      organizationId: "organization",
      userId: "user",
      scope: { type: "organization" },
      layout,
      inboxView: SIGNAL_VIEW.OPEN,
    }),
    inboxCountOptions("organization", "user"),
    inboxSignalOptions("organization", "user", "signal"),
  ];
  const isolated = fileMetadataOptions({
    workspaceId: OTHER_WORKSPACE_ID,
    fieldId: FIELD_ID,
  });
  const seed = async ({ queryKey, meta }: FileReaderIdentity) =>
    queryClient.query(
      queryOptions({
        queryKey,
        meta,
        queryFn: async () => ({ name: "Original" }),
      }),
    );
  try {
    for (const { meta } of readers) {
      expect(meta.resourceReads.resources).toContain(RESOURCE_TYPE.ENTITY);
    }
    expect(readers.at(0)?.meta.resourceReads.scope).toEqual({
      type: "workspace",
      workspaceId: WORKSPACE_ID,
    });
    await Promise.all([...readers, isolated].map(seed));
    for (const { queryKey } of [...readers, isolated]) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
    }
    const rename = resourceMutation({
      mutation: "renameEntity",
      queryClient,
      mutationFn: async ({ name }: { workspaceId: string; name: string }) => ({
        name,
      }),
    });
    await rename({ workspaceId: WORKSPACE_ID, name: "Renamed" });
    // The existing work-family prefix refreshes all its matter and organization projections.
    for (const { queryKey } of readers) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
    expect(queryClient.getQueryState(isolated.queryKey)?.isInvalidated).toBe(
      false,
    );
  } finally {
    queryClient.clear();
  }
});

const syntaxValue = (node: ts.Node): ts.Node => {
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    return syntaxValue(node.expression);
  }
  return node;
};

const propertyValue = (node: ts.Node, name: string) => {
  const value = syntaxValue(node);
  if (!ts.isObjectLiteralExpression(value)) {
    throw new TypeError("Contract metadata must be an object literal");
  }
  const property = value.properties.find(
    (item) => item.name?.getText() === name,
  );
  if (!property || !ts.isPropertyAssignment(property)) {
    throw new TypeError(`Contract metadata lacks ${name}`);
  }
  return syntaxValue(property.initializer);
};

const declarations = (source: ts.SourceFile) => {
  const values = new Map<string, ts.Expression>();
  const functions = new Map<string, ts.FunctionDeclaration>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.set(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        values.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return { functions, values };
};

const imports = (source: ts.SourceFile) => {
  const bindings = new Map<string, { module: string; name: string }>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    if (statement.importClause?.name) {
      bindings.set(statement.importClause.name.text, {
        module: statement.moduleSpecifier.text,
        name: "default",
      });
    }
    const named = statement.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const binding of named.elements) {
        bindings.set(binding.name.text, {
          module: statement.moduleSpecifier.text,
          name: (binding.propertyName ?? binding.name).text,
        });
      }
    }
  }
  return bindings;
};

const exportedSafeHandlerConstructors = (source: ts.SourceFile) => {
  const names = new Set<string>();
  for (const statement of source.statements) {
    const modifiers = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)
      : undefined;
    if (
      !modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) ||
      (!ts.isFunctionDeclaration(statement) &&
        !ts.isVariableStatement(statement))
    ) {
      continue;
    }
    let exportedNames: ts.Identifier[];
    if (ts.isFunctionDeclaration(statement)) {
      exportedNames = statement.name ? [statement.name] : [];
    } else {
      exportedNames = statement.declarationList.declarations.flatMap(
        ({ name }) => (ts.isIdentifier(name) ? [name] : []),
      );
    }
    for (const declaration of exportedNames) {
      if (declaration.text.startsWith("createSafe")) {
        names.add(declaration.text);
      }
    }
  }
  return names;
};

const MAX_HANDLER_FACTORY_DEPTH = 12;

type HandlerResolverState = {
  seen: ReadonlySet<string>;
  depth: number;
  shadowed: ReadonlySet<string>;
};

type HandlerConfigurationCandidate = {
  configuration: ts.Expression | undefined;
};

const singleReturnExpression = (
  functionNode: ts.FunctionLikeDeclaration,
): ts.Expression | undefined => {
  const body = functionNode.body;
  if (!body) {
    return undefined;
  }
  if (ts.isArrowFunction(functionNode) && !ts.isBlock(body)) {
    return body;
  }
  if (!ts.isBlock(body)) {
    return undefined;
  }
  const [statement] = body.statements;
  return body.statements.length === 1 &&
    statement &&
    ts.isReturnStatement(statement)
    ? statement.expression
    : undefined;
};

const bindingNamesOf = (name: ts.BindingName): string[] => {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNamesOf(element.name),
  );
};

const nextHandlerResolverState = (
  state: HandlerResolverState,
  localNames: readonly string[],
): HandlerResolverState => ({
  seen: state.seen,
  depth: state.depth + 1,
  shadowed: new Set([...state.shadowed, ...localNames]),
});

const realtimeConfigurationOfHandler = (
  source: ts.SourceFile,
  safeHandlerConstructors: ReadonlySet<string>,
): ts.Expression | undefined => {
  const { functions, values } = declarations(source);
  const imported = imports(source);
  const exported = source.statements.find(ts.isExportAssignment);
  if (!exported) {
    return undefined;
  }

  const configurationFrom = (
    expression: ts.Expression | undefined,
  ): ts.Expression | undefined => {
    if (!expression) {
      return undefined;
    }
    const value = syntaxValue(expression);
    if (!ts.isExpression(value)) {
      return undefined;
    }
    return ts.isIdentifier(value) && values.has(value.text)
      ? values.get(value.text)
      : value;
  };

  const resolveFunction = (
    functionNode: ts.FunctionLikeDeclaration,
    state: HandlerResolverState,
  ): HandlerConfigurationCandidate[] => {
    const returned = singleReturnExpression(functionNode);
    if (!returned) {
      return [];
    }
    const localNames = functionNode.parameters.flatMap(({ name }) =>
      bindingNamesOf(name),
    );
    const branch = resolve(
      returned,
      nextHandlerResolverState(state, localNames),
    );
    return branch.length === 1 ? branch : [];
  };

  const resolveLocal = (
    name: string,
    state: HandlerResolverState,
  ): HandlerConfigurationCandidate[] => {
    if (state.seen.has(name)) {
      return [];
    }
    const nextState = {
      ...state,
      seen: new Set(state.seen).add(name),
      depth: state.depth + 1,
    };
    const functionNode = functions.get(name);
    if (functionNode) {
      return resolveFunction(functionNode, nextState);
    }
    const initializer = values.get(name);
    return initializer ? resolve(initializer, nextState) : [];
  };

  const resolve = (
    expression: ts.Expression,
    state: HandlerResolverState,
  ): HandlerConfigurationCandidate[] => {
    if (state.depth > MAX_HANDLER_FACTORY_DEPTH) {
      return [];
    }
    const value = syntaxValue(expression);
    if (ts.isIdentifier(value)) {
      if (state.shadowed.has(value.text)) {
        return [];
      }
      return resolveLocal(value.text, state);
    }
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      return resolveFunction(value, state);
    }
    if (!ts.isCallExpression(value)) {
      return [];
    }
    const callee = syntaxValue(value.expression);
    if (!ts.isIdentifier(callee)) {
      return [];
    }
    if (state.shadowed.has(callee.text)) {
      return [];
    }
    const importBinding = imported.get(callee.text);
    if (
      importBinding?.module === "@/api/lib/api-handlers" &&
      safeHandlerConstructors.has(importBinding.name)
    ) {
      const argument = value.arguments.at(0);
      const argumentValue = argument ? syntaxValue(argument) : undefined;
      const resolvedArgument =
        argumentValue &&
        ts.isIdentifier(argumentValue) &&
        state.shadowed.has(argumentValue.text)
          ? undefined
          : configurationFrom(argument);
      return [{ configuration: resolvedArgument }];
    }
    return resolveLocal(callee.text, state);
  };

  const exportExpression = ts.isIdentifier(exported.expression)
    ? (values.get(exported.expression.text) ?? exported.expression)
    : exported.expression;
  const candidates = resolve(exportExpression, {
    seen: new Set(),
    depth: 0,
    shadowed: new Set(),
  });
  if (candidates.length !== 1) {
    return undefined;
  }
  const configuration = candidates.at(0)?.configuration;
  if (!configuration) {
    return undefined;
  }
  const value = syntaxValue(configuration);
  if (
    !ts.isObjectLiteralExpression(value) ||
    !value.properties.some(
      (property) => property.name?.getText() === "realtime",
    )
  ) {
    return undefined;
  }
  return value;
};

const handlerConfigurationFixture = (configuration: string) =>
  ts.createSourceFile(
    "handler.fixture.ts",
    `import { createSafeHandler } from "@/api/lib/api-handlers";
import { entityRealtimeUpdates, organizationRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
const unrelatedConfiguration = { realtime: organizationRealtimeUpdates };
function registeredHandlerFactory() {
  return createSafeHandler(${configuration}, async () => undefined);
}
const routeHandler = () => registeredHandlerFactory();
export default routeHandler();`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

const organizationPluginIsRegistered = (source: ts.SourceFile) => {
  const imported = imports(source);
  if (
    imported.get("organization")?.module !== "better-auth/plugins" ||
    imported.get("organization")?.name !== "organization" ||
    imported.get("betterAuth")?.module !== "better-auth" ||
    imported.get("betterAuth")?.name !== "betterAuth"
  ) {
    return false;
  }
  const evidence = new Set<"created" | "registered">();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "organizationPlugin" &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "organization"
    ) {
      evidence.add("created");
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "betterAuth"
    ) {
      const options = node.arguments.at(0);
      if (options && ts.isObjectLiteralExpression(options)) {
        const plugins = options.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText() === "plugins",
        );
        if (
          plugins &&
          ts.isPropertyAssignment(plugins) &&
          ts.isArrayLiteralExpression(plugins.initializer)
        ) {
          const registered = plugins.initializer.elements.some(
            (plugin) =>
              ts.isIdentifier(plugin) && plugin.text === "organizationPlugin",
          );
          if (registered) {
            evidence.add("registered");
          } else {
            evidence.delete("registered");
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return evidence.has("created") && evidence.has("registered");
};

test("registered handler configuration follows local factory wrappers and keeps its realtime owner", () => {
  const apiRoot = path.resolve(import.meta.dir, "../../../../apps/api/src");
  const apiHandlers = ts.createSourceFile(
    "api-handlers.ts",
    readFileSync(path.join(apiRoot, "lib/api-handlers.ts"), "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const safeHandlerConstructors = exportedSafeHandlerConstructors(apiHandlers);

  const valid = handlerConfigurationFixture(
    "{ realtime: entityRealtimeUpdates }",
  );
  const validConfiguration = realtimeConfigurationOfHandler(
    valid,
    safeHandlerConstructors,
  );
  if (!validConfiguration) {
    throw new TypeError("Factory fixture did not resolve its handler config");
  }
  const realtime = propertyValue(validConfiguration, "realtime");
  if (!ts.isIdentifier(realtime)) {
    throw new TypeError("Factory fixture lost its realtime identifier");
  }
  expect(realtime.text).toBe("entityRealtimeUpdates");
  expect(imports(valid).get("entityRealtimeUpdates")).toEqual({
    module: "@/api/handlers/realtime-resource-sets",
    name: "entityRealtimeUpdates",
  });

  const missing = handlerConfigurationFixture("{ permissions: {} }");
  expect(
    realtimeConfigurationOfHandler(missing, safeHandlerConstructors),
  ).toBeUndefined();

  const shadowed = ts.createSourceFile(
    "handler-shadow.fixture.ts",
    `import { createSafeHandler } from "@/api/lib/api-handlers";
import { entityRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
const config = { realtime: entityRealtimeUpdates };
function registeredHandlerFactory(config: unknown) {
  return createSafeHandler(config, async () => undefined);
}
const routeHandler = () => registeredHandlerFactory({ permissions: {} });
export default routeHandler();`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  expect(
    realtimeConfigurationOfHandler(shadowed, safeHandlerConstructors),
  ).toBeUndefined();

  const shadowedImporter = ts.createSourceFile(
    "handler-import-shadow.fixture.ts",
    `import { createSafeHandler } from "@/api/lib/api-handlers";
import { entityRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
const routeHandler = (createSafeHandler: unknown) => createSafeHandler({ realtime: entityRealtimeUpdates }, async () => undefined);
export default routeHandler(undefined);`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  expect(
    realtimeConfigurationOfHandler(shadowedImporter, safeHandlerConstructors),
  ).toBeUndefined();

  const misdirected = handlerConfigurationFixture(
    "{ realtime: organizationRealtimeUpdates }",
  );
  const misdirectedConfiguration = realtimeConfigurationOfHandler(
    misdirected,
    safeHandlerConstructors,
  );
  if (!misdirectedConfiguration) {
    throw new TypeError("Misdirected fixture did not resolve its config");
  }
  const misdirectedRealtime = propertyValue(
    misdirectedConfiguration,
    "realtime",
  );
  if (!ts.isIdentifier(misdirectedRealtime)) {
    throw new TypeError("Misdirected fixture lost its realtime identifier");
  }
  expect(imports(misdirected).get(misdirectedRealtime.text)?.name).not.toBe(
    "entityRealtimeUpdates",
  );
});

test("every mutation resource declaration agrees with its registered backend route and realtime metadata", () => {
  const apiSourceRoot = path.resolve(
    import.meta.dir,
    "../../../../apps/api/src",
  );
  const readSource = (file: string) =>
    ts.createSourceFile(
      file,
      readFileSync(path.resolve(apiSourceRoot, file), "utf-8"),
      ts.ScriptTarget.Latest,
      true,
    );
  const localImportFile = (specifier: string, sourceFile: string) => {
    if (specifier.startsWith("@/api/")) {
      return `${specifier.slice("@/api/".length)}.ts`;
    }
    if (specifier.startsWith(".")) {
      return path.posix.join(path.posix.dirname(sourceFile), `${specifier}.ts`);
    }
    throw new TypeError(
      `Realtime metadata import must be repository owned: ${specifier}`,
    );
  };
  const registeredRoutes = new Map<string, string[]>();
  const expectedRoutes = new Set(
    Object.values(RESOURCE_MUTATION_CONTRACTS).flatMap(({ writes }) =>
      writes.flatMap((write) =>
        write.type === "handler-route"
          ? [`${write.method} ${write.route}`]
          : [],
      ),
    ),
  );
  const routeFiles = [
    ...new Bun.Glob("handlers/**/routes.ts").scanSync({ cwd: apiSourceRoot }),
  ].toSorted();
  expect(routeFiles.length).toBeGreaterThan(0);
  for (const file of routeFiles) {
    const source = readSource(file);
    const bindings = imports(source);
    const register = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const method = node.expression.name.text.toUpperCase();
        const suffix = node.arguments.at(0);
        const handler = node.arguments.at(1);
        if (
          suffix &&
          ts.isStringLiteral(suffix) &&
          handler &&
          ts.isPropertyAccessExpression(handler) &&
          handler.name.text === "handler" &&
          ts.isIdentifier(handler.expression)
        ) {
          let owner: ts.Expression = node.expression.expression;
          while (
            ts.isCallExpression(owner) &&
            ts.isPropertyAccessExpression(owner.expression)
          ) {
            owner = owner.expression.expression;
          }
          if (ts.isNewExpression(owner)) {
            const options = owner.arguments?.at(0);
            const imported = bindings.get(handler.expression.text);
            if (options && imported && ts.isObjectLiteralExpression(options)) {
              const prefixProperty = options.properties.find(
                (property) => property.name?.getText() === "prefix",
              );
              const prefix =
                prefixProperty && ts.isPropertyAssignment(prefixProperty)
                  ? syntaxValue(prefixProperty.initializer)
                  : undefined;
              if (!prefix || !ts.isStringLiteral(prefix)) {
                return;
              }
              const route =
                `${prefix.text.replace(/\/$/u, "")}/${suffix.text.replace(/^\//u, "")}`.replace(
                  /\/$/u,
                  "",
                );
              const key = `${method} ${route}`;
              if (!expectedRoutes.has(key)) {
                return;
              }
              const handlers = registeredRoutes.get(key) ?? [];
              if (imported.name !== "default") {
                throw new TypeError(
                  `Registered handler must have an explicit default import: ${key}`,
                );
              }
              handlers.push(localImportFile(imported.module, file));
              registeredRoutes.set(key, handlers);
            }
          }
        }
      }
    };
    const visit = (node: ts.Node) => {
      register(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const safeHandlerConstructors = exportedSafeHandlerConstructors(
    readSource("lib/api-handlers.ts"),
  );
  const organizationEndpoints = organization().endpoints;
  expect(organizationPluginIsRegistered(readSource("lib/auth.ts"))).toBe(true);
  for (const contract of Object.values(RESOURCE_MUTATION_CONTRACTS)) {
    expect(contract.writes.length).toBeGreaterThan(0);
    const observedResources = new Set<ResourceType>();
    let registeredWriteCount = 0;
    for (const write of contract.writes) {
      if (write.type === "auth-plugin-endpoint") {
        const endpoint = organizationEndpoints[write.endpoint];
        expect(contract.resources).toEqual([RESOURCE_TYPE.ORGANIZATION]);
        expect(write).toEqual({
          type: "auth-plugin-endpoint",
          plugin: "organization",
          endpoint: write.endpoint,
          method: endpoint.options.method,
          route: endpoint.path,
        });
        observedResources.add(RESOURCE_TYPE.ORGANIZATION);
        registeredWriteCount += 1;
        continue;
      }
      const handlers = registeredRoutes.get(`${write.method} ${write.route}`);
      if (!handlers) {
        continue;
      }
      registeredWriteCount += 1;
      expect(handlers).toHaveLength(1);
      const handlerPath = handlers.at(0);
      if (!handlerPath) {
        throw new TypeError(
          `Mutation route has no unique backend handler: ${write.route}`,
        );
      }
      const handler = readSource(handlerPath);
      const config = realtimeConfigurationOfHandler(
        handler,
        safeHandlerConstructors,
      );
      if (!config) {
        throw new TypeError(
          `Handler has no explicit realtime configuration for ${write.method} ${write.route}`,
        );
      }
      const realtime = propertyValue(config, "realtime");
      if (!ts.isIdentifier(realtime)) {
        throw new TypeError(
          "Handler must name its realtime resource-set declaration",
        );
      }
      const realtimeImport = imports(handler).get(realtime.text);
      if (!realtimeImport) {
        throw new TypeError(
          "Handler realtime declaration must have an explicit import",
        );
      }
      const realtimeSource = readSource(
        localImportFile(realtimeImport.module, handlerPath),
      );
      const realtimeDeclaration = declarations(realtimeSource).values.get(
        realtimeImport.name,
      );
      if (!realtimeDeclaration || !ts.isCallExpression(realtimeDeclaration)) {
        throw new TypeError(
          "Realtime resources must be declared by a resource-set helper",
        );
      }
      expect(realtimeDeclaration.expression.getText()).toMatch(
        /^(?:workspace|organization)ResourceSetUpdates$/u,
      );
      expect(
        imports(realtimeSource).get(realtimeDeclaration.expression.getText())
          ?.module,
      ).toBe("@/api/lib/resource-set-realtime");
      expect(imports(realtimeSource).get("RESOURCE_TYPE")).toEqual({
        module: "@stll/api-contract",
        name: "RESOURCE_TYPE",
      });
      const argument = realtimeDeclaration.arguments.at(0);
      if (!argument) {
        throw new TypeError("Realtime resource set has no resources");
      }
      const resourceNodes = ts.isArrayLiteralExpression(argument)
        ? [...argument.elements]
        : [argument];
      const resources = resourceNodes.map((resourceNode) => {
        if (
          !ts.isPropertyAccessExpression(resourceNode) ||
          resourceNode.expression.getText() !== "RESOURCE_TYPE"
        ) {
          throw new TypeError(
            "Realtime resource must use the shared resource type owner",
          );
        }
        const resource = Object.entries(RESOURCE_TYPE).find(
          ([key]) => key === resourceNode.name.text,
        );
        if (!resource) {
          throw new TypeError(
            `Unknown realtime resource type: ${resourceNode.name.text}`,
          );
        }
        return resource[1];
      });
      const declaredResources: readonly string[] = contract.resources;
      for (const resource of resources) {
        observedResources.add(resource);
        expect(declaredResources).toContain(resource);
      }
    }
    if (registeredWriteCount === 0) {
      continue;
    }
    expect(registeredWriteCount).toBe(contract.writes.length);
    expect([...observedResources].toSorted()).toEqual(
      [...contract.resources].toSorted(),
    );
  }
});

type FileReaderIdentity = { queryKey: QueryKey; meta: QueryMeta };

const fileReaderFixture = async () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  const names = new Map([
    [WORKSPACE_ID, "Original.pdf"],
    [OTHER_WORKSPACE_ID, "Other.pdf"],
  ]);
  let pendingRead = Promise.resolve(undefined);
  const optionsFor = (workspaceId: string) => {
    const key = { workspaceId, fieldId: FIELD_ID };
    // The storage boundary is fake; factory keys, metadata, cache and observers are real.
    const queryFn = async () => {
      await pendingRead;
      const fileName = names.get(workspaceId);
      if (!fileName) {
        throw new TypeError("Fixture matter has no file name");
      }
      return {
        fileId: "file-1",
        fileName,
        mimeType: "application/pdf",
        originalMimeType: "application/pdf",
        buffer: new ArrayBuffer(0),
        text: "File content",
      };
    };
    const options = ({ queryKey, meta }: FileReaderIdentity) =>
      queryOptions({ queryKey, meta, queryFn });
    return [
      options(fileOptions(key)),
      options(textFileOptions(key)),
      options(fileMetadataOptions(key)),
    ];
  };
  const readers = optionsFor(WORKSPACE_ID);
  const otherReaders = optionsFor(OTHER_WORKSPACE_ID);
  await Promise.all(
    [...readers, ...otherReaders].map(
      async (options) => await queryClient.query(options),
    ),
  );
  return {
    queryClient,
    readers,
    otherReaders,
    rename: (fileName: string) => names.set(WORKSPACE_ID, fileName),
    blockReads: () => {
      const pending = Promise.withResolvers<undefined>();
      pendingRead = pending.promise;
      return () => pending.resolve(undefined);
    },
  };
};

test("a committed entity rename marks actual file, text and metadata readers stale only in its matter", async () => {
  const fixture = await fileReaderFixture();
  const { queryClient, readers, otherReaders } = fixture;
  try {
    for (const { queryKey } of [...readers, ...otherReaders]) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
    }
    const rename = resourceMutation({
      mutation: "renameEntity",
      queryClient,
      mutationFn: async ({ name }: { workspaceId: string; name: string }) => {
        fixture.rename(name);
        return { name };
      },
    });
    expect(
      await rename({ workspaceId: WORKSPACE_ID, name: "Renamed.pdf" }),
    ).toEqual({ name: "Renamed.pdf" });
    for (const { queryKey } of readers) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
    for (const { queryKey } of otherReaders) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
    }
    await queryClient.refetchQueries({ stale: true });
    for (const { queryKey } of readers) {
      expect(queryClient.getQueryData(queryKey)?.fileName).toBe("Renamed.pdf");
    }
    for (const { queryKey } of otherReaders) {
      expect(queryClient.getQueryData(queryKey)?.fileName).toBe("Other.pdf");
    }
  } finally {
    queryClient.clear();
  }
});

test("a rejected rename leaves every actual file reader fresh", async () => {
  const { queryClient, readers, otherReaders } = await fileReaderFixture();
  try {
    const rename = resourceMutation({
      mutation: "renameEntity",
      queryClient,
      mutationFn: async () => {
        throw new TypeError("Rename was refused");
      },
    });
    const rejected = await rejectionOf(rename({ workspaceId: WORKSPACE_ID }));
    expect(rejected).toBeInstanceOf(TypeError);
    expect(rejected).toHaveProperty("message", "Rename was refused");
    for (const { queryKey } of [...readers, ...otherReaders]) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
    }
    for (const { queryKey } of readers) {
      expect(queryClient.getQueryData(queryKey)?.fileName).toBe("Original.pdf");
    }
  } finally {
    queryClient.clear();
  }
});

test("an incoming entity rename refetches active file readers to the new filename without touching another matter", async () => {
  const fixture = await fileReaderFixture();
  const { queryClient, readers, otherReaders } = fixture;
  const subscriptions = readers.map((options) => {
    const observer = new QueryObserver(queryClient, options);
    return observer.subscribe(() => {});
  });
  const unblock = fixture.blockReads();
  try {
    fixture.rename("Remote rename.pdf");
    const actions = getWorkspaceRealtimeQueryActions(
      {
        type: REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED,
        resourceType: RESOURCE_TYPE.ENTITY,
      },
      { workspaceId: WORKSPACE_ID, queryClient },
    );
    await applyResourceQueryActions(queryClient, actions);
    for (const { queryKey } of readers) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
    for (const { queryKey } of otherReaders) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
    }
    const completed = new Promise<void>((resolve) => {
      const unsubscribe = queryClient.getQueryCache().subscribe(() => {
        if (
          !readers.every(
            ({ queryKey }) =>
              queryClient.getQueryData(queryKey)?.fileName ===
              "Remote rename.pdf",
          )
        ) {
          return;
        }
        unsubscribe();
        resolve();
      });
    });
    unblock();
    await completed;
    for (const { queryKey } of readers) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
      expect(queryClient.getQueryData(queryKey)?.fileName).toBe(
        "Remote rename.pdf",
      );
    }
    for (const { queryKey } of otherReaders) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
      expect(queryClient.getQueryData(queryKey)?.fileName).toBe("Other.pdf");
    }
  } finally {
    unblock();
    for (const unsubscribe of subscriptions) {
      unsubscribe();
    }
    queryClient.clear();
  }
});
