import ts from "typescript6";

import {
  invalidateDeletedEntityQueries,
  invalidateRenamedEntityQueries,
} from "@/lib/workspaces/mutations/entities.logic";

import {
  parseReasonedLedger,
  runLedgerMembershipGuard,
} from "../../../../scripts/ledger-membership";

export const entityMutationBudgetCases = {
  useDeleteEntities: ({
    queryClient,
    workspaceId,
    entityId,
  }: Parameters<typeof invalidateRenamedEntityQueries>[0]) =>
    invalidateDeletedEntityQueries({
      queryClient,
      workspaceId,
      entityIds: [entityId],
    }),
  useRenameEntity: invalidateRenamedEntityQueries,
} as const;

const measuredMutationSeams = {
  useDeleteEntities: invalidateDeletedEntityQueries.name,
  useRenameEntity: invalidateRenamedEntityQueries.name,
} as const satisfies Record<keyof typeof entityMutationBudgetCases, string>;

const CACHE_WRITE_METHODS = new Set([
  "invalidateQueries",
  "refetchQueries",
  "resetQueries",
  "removeQueries",
  "setQueryData",
  "setQueriesData",
]);

export const readEntityMutationBudgetCensus = async () => {
  const workspaceRoot = new URL("workspaces/", import.meta.url);
  const ownerFiles = ["mutations.ts"];
  for await (const file of new Bun.Glob("mutations/**/*.{ts,tsx,mts,cts}").scan(
    {
      cwd: workspaceRoot.pathname,
    },
  )) {
    if (!/\.(?:test|spec|type-test)\.[cm]?tsx?$/u.test(file)) {
      ownerFiles.push(file);
    }
  }
  const hooks: string[] = [];
  const invalidatingHooks: string[] = [];
  const callsByHook = new Map<string, Set<string>>();
  for (const file of ownerFiles.toSorted()) {
    const source = ts.createSourceFile(
      file,
      await Bun.file(new URL(file, workspaceRoot)).text(),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const addHook = (name: string, node: ts.Node) => {
      if (!name.startsWith("use")) {
        return;
      }
      const hook = `workspaces/${file}::${name}`;
      hooks.push(hook);
      const calls = new Set<string>();
      callsByHook.set(hook, calls);
      const visit = (child: ts.Node) => {
        if (ts.isCallExpression(child)) {
          if (ts.isIdentifier(child.expression)) {
            calls.add(child.expression.text);
          }
          if (
            ts.isPropertyAccessExpression(child.expression) &&
            CACHE_WRITE_METHODS.has(child.expression.name.text)
          ) {
            invalidatingHooks.push(hook);
          }
        }
        if (
          ts.isPropertyAssignment(child) &&
          (ts.isIdentifier(child.name) || ts.isStringLiteral(child.name)) &&
          ["onSuccess", "onSettled"].includes(child.name.text)
        ) {
          invalidatingHooks.push(hook);
        }
        ts.forEachChild(child, visit);
      };
      visit(node);
    };
    for (const statement of source.statements) {
      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          addHook(element.name.text, element);
        }
        continue;
      }
      if (
        !ts.canHaveModifiers(statement) ||
        !ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            addHook(declaration.name.text, declaration);
          }
        }
      }
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        addHook(statement.name.text, statement);
      }
    }
  }
  const ledgerPath = "apps/web/src/lib/workspace-refetch-budget.ledger.json";
  const excluded = parseReasonedLedger(
    await Bun.file(
      new URL("workspace-refetch-budget.ledger.json", import.meta.url),
    ).text(),
    ledgerPath,
  );
  return {
    hooks: hooks.toSorted(),
    covered: [
      ...Object.entries(measuredMutationSeams)
        .filter(([hook, seam]) =>
          callsByHook
            .get(`workspaces/mutations/entities.ts::${hook}`)
            ?.has(seam),
        )
        .map(([hook]) => `workspaces/mutations/entities.ts::${hook}`),
      ...excluded,
    ].toSorted(),
    excludedWithCallbacks: excluded.filter(
      (hook) =>
        hook.startsWith("workspaces/mutations/entities.ts::") &&
        invalidatingHooks.includes(hook),
    ),
    ledgerExitCode: runLedgerMembershipGuard({
      ledgerRel: ledgerPath,
      repoRoot: new URL("../../../../", import.meta.url).pathname,
      parseLedger: parseReasonedLedger,
      label: "workspace-refetch-budget",
      remediation: "add a measured case instead",
      args: [],
    }),
  };
};
