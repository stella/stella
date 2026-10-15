import {
  QueryClient,
  QueryObserver,
  queryOptions,
  type QueryKey,
  type QueryMeta,
} from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { REALTIME_EVENT_TYPE, RESOURCE_TYPE } from "@stll/api-contract";
import { rejectionOf } from "@stll/property-testing/rejection";

import { fileMetadataOptions } from "@/lib/files/file-metadata-query";
import { fileOptions, textFileOptions } from "@/lib/files/queries";
import {
  applyResourceQueryActions,
  getWorkspaceRealtimeQueryActions,
  resourceMutation,
  RESOURCE_MUTATION_CONTRACTS,
} from "@/lib/workspace-realtime";

const WORKSPACE_ID = "workspace-rename";
const OTHER_WORKSPACE_ID = "workspace-other";
const FIELD_ID = "field-file";

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
  const declarations = (source: ts.SourceFile) => {
    const values = new Map<string, ts.Expression>();
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          values.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    return values;
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
      writes.map(({ method, route }) => `${method} ${route}`),
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
  for (const contract of Object.values(RESOURCE_MUTATION_CONTRACTS)) {
    expect(contract.writes.length).toBeGreaterThan(0);
    for (const write of contract.writes) {
      const handlers = registeredRoutes.get(`${write.method} ${write.route}`);
      expect(handlers).toHaveLength(1);
      const handlerPath = handlers?.at(0);
      if (!handlerPath) {
        throw new TypeError(
          `Mutation route has no unique backend handler: ${write.route}`,
        );
      }
      const handler = readSource(handlerPath);
      const values = declarations(handler);
      const defaultExport = handler.statements.find(ts.isExportAssignment);
      if (!defaultExport || !ts.isIdentifier(defaultExport.expression)) {
        throw new TypeError("Handler default export must name its declaration");
      }
      const declaration = values.get(defaultExport.expression.text);
      if (!declaration || !ts.isCallExpression(declaration)) {
        throw new TypeError("Handler must declare its safe-handler call");
      }
      const firstArgument = declaration.arguments.at(0);
      const config =
        firstArgument &&
        (ts.isIdentifier(firstArgument)
          ? values.get(firstArgument.text)
          : firstArgument);
      if (!config) {
        throw new TypeError("Handler has no explicit configuration");
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
      const realtimeDeclaration = declarations(realtimeSource).get(
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
      expect(resources.toSorted()).toEqual([...contract.resources].toSorted());
    }
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
