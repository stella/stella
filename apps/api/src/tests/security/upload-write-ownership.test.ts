import { describe, expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";

const apiRoot = path.resolve(import.meta.dir, "../../..");
const uploadFile = "src/handlers/entities/upload.ts";
const retryHelper = "writeS3ObjectWithRetry";
const cleanupModule = "@/api/lib/buffer-intent-reconciliation";

type Disposition =
  | "cleanup-intent"
  | "upload-reservation"
  | "finalized-file"
  | "derivative"
  | "fixed-key"
  | "export"
  | "public-corpus"
  | "fixture";

// Each site declares its storage lifecycle; additional sites need a decision.
const dispositions = {
  "scripts/backfill-image-thumbnails.ts:0": "derivative",
  "scripts/seed-dev.ts:0": "fixture",
  "scripts/seed-dev.ts:1": "fixture",
  "scripts/seed-email-viewer-demo.ts:0": "fixture",
  "src/handlers/chat/export/create.ts:0": "export",
  "src/handlers/entities/checkpoint-desktop-edit-session.ts:0": "fixed-key",
  "src/handlers/entities/checkpoint-desktop-edit-session.ts:1": "fixed-key",
  "src/handlers/entities/checkpoint-folio-collab-room.ts:0": "cleanup-intent",
  "src/handlers/entities/checkpoint-folio-collab-room.ts:1": "cleanup-intent",
  "src/handlers/entities/finalize-desktop-edit-session.ts:0": "finalized-file",
  "src/handlers/entities/finalize-desktop-edit-session.ts:1": "finalized-file",
  "src/handlers/entities/publish-folio-collab-version.ts:0": "cleanup-intent",
  "src/handlers/entities/publish-folio-collab-version.ts:1": "cleanup-intent",
  "src/handlers/entities/upload.ts:0": "cleanup-intent",
  "src/handlers/entities/upload.ts:1": "cleanup-intent",
  "src/handlers/reports/report-export-queue.ts:0": "export",
  "src/handlers/uploads/update.ts:0": "upload-reservation",
  "src/lib/folio-collab-rooms.ts:0": "cleanup-intent",
  "src/lib/folio-collab-rooms.ts:1": "cleanup-intent",
  "src/lib/legal-search/raw-source-storage.ts:0": "public-corpus",
  "src/lib/s3.ts:0": "fixed-key",
} as const satisfies Record<string, Disposition>;

type CallSite = {
  id: string;
  node: ts.CallExpression;
  consumed: boolean;
};

const inspectWrites = (file: string, source: string) => {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = new Map<string, string>();
  const namespaces = new Map<string, string>();
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      namespaces.set(bindings.name.text, statement.moduleSpecifier.text);
      continue;
    }
    for (const binding of bindings.elements) {
      imports.set(
        binding.name.text,
        `${statement.moduleSpecifier.text}:${binding.propertyName?.text ?? binding.name.text}`,
      );
    }
  }
  const invokedName = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) {
      return imports.get(expression.text) ?? expression.text;
    }
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression)
    ) {
      const module = namespaces.get(expression.expression.text);
      if (module) {
        return `${module}:${expression.name.text}`;
      }
    }
    return undefined;
  };
  const aliases = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const name = invokedName(node.initializer);
      if (name === `@/api/lib/s3:${retryHelper}`) {
        imports.set(node.name.text, name);
      }
    }
    ts.forEachChild(node, aliases);
  };
  aliases(ast);
  const calls: { name: string; node: ts.CallExpression }[] = [];
  const writes: CallSite[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = invokedName(node.expression);
      if (name) {
        calls.push({ name, node });
      }
      if (
        name === `@/api/lib/s3:${retryHelper}` ||
        (file === "src/lib/s3.ts" && name === retryHelper)
      ) {
        let value: ts.Node = node;
        while (
          ts.isAwaitExpression(value.parent) ||
          ts.isParenthesizedExpression(value.parent)
        ) {
          value = value.parent;
        }
        writes.push({
          id: `${file}:${writes.length}`,
          node,
          consumed: !ts.isExpressionStatement(value.parent),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const importsRetry = [...imports.values()].includes(
    `@/api/lib/s3:${retryHelper}`,
  );
  const exportedRetry = ast.statements.some((statement) => {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@/api/lib/s3"
    ) {
      return false;
    }
    if (!statement.exportClause) {
      return true;
    }
    if (ts.isNamespaceExport(statement.exportClause)) {
      return true;
    }
    return statement.exportClause.elements.some(
      (element) =>
        (element.propertyName?.text ?? element.name.text) === retryHelper,
    );
  });
  return { ast, calls, writes, importsRetry, exportedRetry };
};

const hasAncestor = (node: ts.Node, ancestor: ts.Node): boolean => {
  let current = node;
  while (!ts.isSourceFile(current)) {
    if (current === ancestor) {
      return true;
    }
    current = current.parent;
  }
  return current === ancestor;
};

const uploadLifecycleViolations = (source: string): string[] => {
  const { ast, calls, writes } = inspectWrites(uploadFile, source);
  const violations: string[] = [];
  const lifecycle = ast.statements
    .flatMap((statement) => {
      if (!ts.isVariableStatement(statement)) {
        return [];
      }
      return statement.declarationList.declarations.filter(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "uploadEntityHandler",
      );
    })
    .at(0)?.initializer;
  if (!lifecycle) {
    return ["missing upload lifecycle"];
  }
  if (writes.length === 0) {
    violations.push("missing multipart write");
  }
  for (const write of writes) {
    if (!write.consumed) {
      violations.push(`${write.id}: discarded certainty`);
    }
    if (!hasAncestor(write.node, lifecycle)) {
      violations.push(`${write.id}: outside upload lifecycle`);
    }
  }
  const cleanupCalls = (name: string) =>
    calls.filter(
      (call) =>
        call.name === `${cleanupModule}:${name}` &&
        hasAncestor(call.node, lifecycle),
    );
  const reservations = cleanupCalls("reserveObjectCleanupIntent");
  if (
    !reservations.some((reservation) =>
      writes.every((write) => reservation.node.pos < write.node.pos),
    )
  ) {
    violations.push("reserve before first PUT");
  }
  const locks = cleanupCalls("lockObjectCleanupIntentsForWriter");
  const retirements = cleanupCalls(
    "retirePublishedObjectCleanupIntentsInTransaction",
  );
  const transactions = calls.filter(
    (call) => call.name === "safeDb" && hasAncestor(call.node, lifecycle),
  );
  if (
    !transactions.some(
      (transaction) =>
        locks.some((lock) => hasAncestor(lock.node, transaction.node)) &&
        retirements.some((retirement) =>
          hasAncestor(retirement.node, transaction.node),
        ),
    )
  ) {
    violations.push("lock and retire in publication transaction");
  }
  const settlements = cleanupCalls("settleObjectCleanupIntentsAfterWriter");
  const cleanupStates = cleanupCalls("objectWriterSettlementAfterCleanup");
  const visitTry = (node: ts.Node): boolean => {
    if (
      ts.isTryStatement(node) &&
      node.finallyBlock &&
      writes.every((write) => hasAncestor(write.node, node.tryBlock))
    ) {
      const finalizer = node.finallyBlock;
      if (
        settlements.some((call) => hasAncestor(call.node, finalizer)) &&
        cleanupStates.some((call) => hasAncestor(call.node, finalizer))
      ) {
        return true;
      }
    }
    return ts.forEachChild(node, visitTry) ?? false;
  };
  if (!visitTry(lifecycle)) {
    violations.push("writes protected by finally settlement");
  }
  return violations;
};

const unclassifiedSites = (
  sites: readonly CallSite[],
  registry: ReadonlyMap<string, Disposition>,
) => sites.filter(({ id }) => !registry.has(id)).map(({ id }) => id);

// Dispositions are bound to individual call sites rather than whole files.
describe("retrying object writes declare cleanup ownership", () => {
  test("detects discarded certainty and a new unclassified aliased caller", () => {
    const source =
      'import { writeS3ObjectWithRetry as put } from "@/api/lib/s3"; const uploadEntityHandler = async function* () { await put({ key, data }); };';
    const inspected = inspectWrites(uploadFile, source);
    expect(inspected.writes).toHaveLength(1);
    expect(inspected.writes.at(0)?.consumed).toBe(false);
    expect(uploadLifecycleViolations(source)).toContain(
      `${uploadFile}:0: discarded certainty`,
    );
    const newSite = inspectWrites(
      "src/new-upload.ts",
      'import * as storage from "@/api/lib/s3"; const save = async () => await storage.writeS3ObjectWithRetry({ key, data });',
    );
    expect(newSite.writes).toHaveLength(1);
    expect(
      unclassifiedSites(newSite.writes, new Map(Object.entries(dispositions))),
    ).toEqual(["src/new-upload.ts:0"]);
    const forwarding = inspectWrites(
      "src/storage-alias.ts",
      'export { writeS3ObjectWithRetry as put } from "@/api/lib/s3";',
    );
    expect(forwarding.exportedRetry).toBe(true);
    expect(
      inspectWrites("src/storage-alias.ts", 'export * from "@/api/lib/s3";')
        .exportedRetry,
    ).toBe(true);
    const consumed = inspectWrites(
      uploadFile,
      'import { writeS3ObjectWithRetry } from "@/api/lib/s3"; const save = async () => { const certainty = await writeS3ObjectWithRetry({ key, data }); return certainty; };',
    );
    expect(consumed.writes.at(0)?.consumed).toBe(true);
  });

  test("enumerates every caller and keeps multipart inside durable ownership", async () => {
    const files = [
      ...new Bun.Glob("{src,scripts}/**/*.ts").scanSync({ cwd: apiRoot }),
    ].filter(
      (file) => !file.endsWith(".test.ts") && !file.endsWith(".spec.ts"),
    );
    const sources = await Promise.all(
      files.map(async (file) => ({
        file,
        source: await Bun.file(path.join(apiRoot, file)).text(),
      })),
    );
    const inspections = sources
      .filter(
        ({ source }) =>
          source.includes(retryHelper) || source.includes("@/api/lib/s3"),
      )
      .map(({ file, source }) => inspectWrites(file, source));
    expect(inspections.some(({ exportedRetry }) => exportedRetry)).toBe(false);
    const importFiles = sources
      .filter(
        ({ source }) =>
          source.includes(retryHelper) || source.includes("@/api/lib/s3"),
      )
      .filter(({ file, source }) => inspectWrites(file, source).importsRetry)
      .map(({ file }) => file)
      .toSorted();
    const expectedImportFiles = [
      ...new Set(
        Object.keys(dispositions)
          .map((id) => id.slice(0, id.lastIndexOf(":")))
          .filter((file) => file !== "src/lib/s3.ts"),
      ),
    ];
    expectedImportFiles.push(
      "src/lib/file-scan/stored-object.ts",
      "src/lib/templates/write-template.ts",
    );
    expect(importFiles).toEqual(expectedImportFiles.toSorted());
    const writes = inspections.flatMap(({ writes: sites }) => sites);
    const registry = new Map<string, Disposition>(Object.entries(dispositions));
    expect(unclassifiedSites(writes, registry)).toEqual([]);
    expect(writes.map(({ id }) => id).toSorted()).toEqual(
      [...registry.keys()].toSorted(),
    );
    for (const { id, consumed } of writes) {
      if (registry.get(id) === "cleanup-intent") {
        expect(consumed).toBe(true);
      }
    }
    const upload = sources.find(({ file }) => file === uploadFile);
    expect(upload).toBeDefined();
    expect(uploadLifecycleViolations(upload?.source ?? "")).toEqual([]);
  });
});
