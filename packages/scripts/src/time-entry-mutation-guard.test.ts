import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const HANDLERS_ROOT = path.resolve(
  import.meta.dir,
  "../../../apps/api/src/handlers/time-entries",
);
const GUARD_MODULE = "@/api/handlers/time-entries/running";

const unguardedMutations = (text: string, filename: string) => {
  const source = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const guardedImport = source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === GUARD_MODULE &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) =>
          !element.propertyName &&
          element.name.text === "guardRunningTimeEntries",
      ),
  );
  const missing: number[] = [];
  let mutationCount = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["update", "delete"].includes(node.expression.name.text) &&
      node.arguments.some(
        (argument) =>
          ts.isIdentifier(argument) && argument.text === "timeEntries",
      )
    ) {
      mutationCount++;
      let parent = node.parent;
      while (
        parent &&
        !ts.isArrowFunction(parent) &&
        !ts.isFunctionExpression(parent) &&
        !ts.isFunctionDeclaration(parent)
      ) {
        parent = parent.parent;
      }
      const body =
        parent &&
        (ts.isArrowFunction(parent) ||
          ts.isFunctionExpression(parent) ||
          ts.isFunctionDeclaration(parent))
          ? parent.body
          : undefined;
      const guarded =
        guardedImport &&
        body &&
        ts.isBlock(body) &&
        body.statements.some((statement, index) => {
          if (!ts.isVariableStatement(statement) || statement.end >= node.pos) {
            return false;
          }
          const declaration = statement.declarationList.declarations.at(0);
          if (
            !declaration ||
            !ts.isIdentifier(declaration.name) ||
            !declaration.initializer ||
            !ts.isAwaitExpression(declaration.initializer)
          ) {
            return false;
          }
          const call = declaration.initializer.expression;
          if (
            !ts.isCallExpression(call) ||
            !ts.isIdentifier(call.expression) ||
            call.expression.text !== "guardRunningTimeEntries"
          ) {
            return false;
          }
          const refusal = body.statements.at(index + 1);
          return (
            refusal &&
            refusal.end < node.pos &&
            ts.isIfStatement(refusal) &&
            ts.isIdentifier(refusal.expression) &&
            refusal.expression.text === declaration.name.text &&
            ts.isReturnStatement(refusal.thenStatement)
          );
        });
      if (!guarded) {
        missing.push(
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { missing, mutationCount };
};

test("every time-entry update and delete refuses running entries before mutation", () => {
  let mutationCount = 0;
  for (const filename of new Bun.Glob("**/*.ts").scanSync({
    cwd: HANDLERS_ROOT,
    onlyFiles: true,
  })) {
    if (filename.endsWith(".test.ts")) {
      continue;
    }
    const source = readFileSync(path.join(HANDLERS_ROOT, filename), "utf-8");
    const result = unguardedMutations(source, filename);
    mutationCount += result.mutationCount;
    expect(result.missing, filename).toEqual([]);
  }
  expect(mutationCount).toBeGreaterThan(0);
});

test("the mutation census rejects an omitted or late running-entry guard", () => {
  const prefix = `import { guardRunningTimeEntries } from "${GUARD_MODULE}";`;
  const mutate = "await tx.update(timeEntries).set({ narrative: 'updated' });";
  const guard =
    "const error = await guardRunningTimeEntries({ tx, workspaceId, ids, actorUserId }); if (error) return error;";
  expect(
    unguardedMutations(
      `${prefix} const write = async tx => { ${guard} ${mutate} };`,
      "guarded.ts",
    ),
  ).toEqual({ missing: [], mutationCount: 1 });
  expect(
    unguardedMutations(
      `${prefix} const write = async tx => { ${mutate} };`,
      "missing.ts",
    ).missing,
  ).toHaveLength(1);
  expect(
    unguardedMutations(
      `${prefix} const write = async tx => { ${mutate} ${guard} };`,
      "late.ts",
    ).missing,
  ).toHaveLength(1);
});
