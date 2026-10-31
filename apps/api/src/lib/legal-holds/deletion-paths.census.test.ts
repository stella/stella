import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import ts from "typescript6";

const SOURCE_ROOTS = {
  src: new URL("../../", import.meta.url).pathname,
  scripts: new URL("../../../scripts/", import.meta.url).pathname,
};
const PROTECTED_TABLES = new Set([
  "organization",
  "workspaces",
  "workspaceContacts",
  "entities",
  "entityVersions",
  "fields",
  "userFiles",
  "contacts",
  "chatThreads",
  "organizationFileObjects",
]);
const PROTECTED_SQL_TABLES = new Map([
  ["organization", "organization"],
  ["workspaces", "workspaces"],
  ["workspace_contacts", "workspaceContacts"],
  ["entities", "entities"],
  ["entity_versions", "entityVersions"],
  ["fields", "fields"],
  ["user_files", "userFiles"],
  ["contacts", "contacts"],
  ["chat_threads", "chatThreads"],
  ["organization_file_objects", "organizationFileObjects"],
]);
const STORAGE_DELETIONS = new Set([
  "deleteOrganizationFileWithSignal",
  "deleteOrganizationFilesWithSignal",
  "deleteS3Keys",
  "deleteS3Objects",
  "deleteS3ObjectWithSignal",
  "deleteCorpusS3ObjectWithSignal",
  "deleteObject",
  "deleteObjects",
]);
const HOLD_CHECKS = new Set([
  "holdsBlocking",
  "requireNoHold",
  "heldMatterIdsForAccount",
]);
// Each entry names the concrete ownership boundary that permits this module's
// deletions. The reverse census removes exceptions when their call sites vanish.
const EXCEPTIONS = new Map([
  [
    "scripts/backfill-organization-file-usage.helpers.ts",
    "The repair removes stale usage projections only; source files and matter evidence remain intact.",
  ],
  [
    "scripts/seed-dev.ts",
    "Development fixture replacement operates only on disposable seeded data outside production request paths.",
  ],
  [
    "lib/organization-storage-teardown.ts",
    "Organization teardown is reached only after its transaction has excluded active holds and recorded retained storage.",
  ],
  [
    "lib/workflow-queue.ts",
    "Workflow field replacement removes run-owned transient outputs before atomically writing their successor values.",
  ],
  [
    "lib/fields/write-field.ts",
    "Manual field writes atomically replace a derived field value; legal holds retain the source entity versions and files.",
  ],
  [
    "lib/files/delete-organization-file.ts",
    "Canonical file deletion owner performs its legal-hold check in the surrounding transaction callback.",
  ],
  [
    "lib/files/organization-file-usage.ts",
    "Usage reconciliation deletes stale projection rows only and never deletes the source file object.",
  ],
  [
    "handlers/chat/send-message-side-effects.ts",
    "Failed-send rollback deletes only a newly created empty thread identified by its private rollback token.",
  ],
  [
    "handlers/chat/upload-files.ts",
    "Upload rollback delegates persistent-object removal to the guarded organization-file deletion owner.",
  ],
  [
    "handlers/entities/copy.ts",
    "Failed-copy rollback delegates object removal to guarded file deletion after the copy transaction aborts.",
  ],
  [
    "scripts/backfill-image-thumbnails.ts",
    "Obsolete thumbnail cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "lib/account-deletion-steps.ts",
    "The account deletion caller computes heldMatterIdsForAccount inside the same transaction and passes retained matter ids to selective erasure; held sources are excluded from row and storage cleanup.",
  ],
  [
    "handlers/uploads/delete.ts",
    "Deletes only tmpUploadKeys and legacyTmpUploadKey staging objects; persistent matter and entity copies have separate final keys.",
  ],
  [
    "handlers/uploads/update.ts",
    "Failed upload replacement deletes only tmpUploadKeys and legacyTmpUploadKey staging objects, before publication as persistent matter content.",
  ],
  [
    "handlers/contacts/extract-procuracao.ts",
    "Deletes the one-use extraction staging upload after extracted output is finalized; persistent matter content has separate final keys.",
  ],
  [
    "lib/s3.ts",
    "Raw transport primitive; tenant callers use the guarded organization-file deletion owner; corpus objects are public-law data.",
  ],
  [
    "lib/files/utils.ts",
    "Both batch deletion adapters delegate to the guarded organization-file deletion owner.",
  ],
  [
    "lib/files/organization-file-usage-reconcile.ts",
    "Abandoned reservation cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "lib/email/inbound/ses.ts",
    "Deletes consumed SES staging envelopes, before any matter-owned entity exists; retained matter copies use separate object keys.",
  ],
  [
    "lib/legal-search/corpus-storage.ts",
    "Deletes public legal-corpus objects, which have no tenant matter or entity ownership.",
  ],
  [
    "lib/legal-search/raw-source-storage.ts",
    "Deletes public legal-corpus raw sources, which have no tenant matter or entity ownership.",
  ],
  [
    "lib/health/readiness.ts",
    "Deletes only the dedicated RAW_SOURCE_READINESS_KEY health probe object.",
  ],
  [
    "lib/account-export/queue.ts",
    "Deletes generated account-export archives, not the retained matter sources from which they were generated.",
  ],
  [
    "handlers/style-sets/delete.ts",
    "Style package object deletion delegates to the guarded organization-file deletion owner.",
  ],
  [
    "handlers/style-sets/storage.ts",
    "Style package rollback and replacement delegate to the guarded organization-file deletion owner.",
  ],
  [
    "handlers/workspaces/duplicate.ts",
    "Failed duplicate object cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "handlers/entities/publish-folio-collab-version.ts",
    "Failed publication object cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "handlers/entities/upload.ts",
    "Failed upload object cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "handlers/entities/checkpoint-folio-collab-room.ts",
    "Failed checkpoint object cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "handlers/entities/finalize-desktop-edit-session.ts",
    "Failed edit object cleanup delegates to the guarded organization-file deletion owner; local filesystem fallback removes unpublished temporary objects.",
  ],
  [
    "handlers/entities/copy-utils.ts",
    "Failed copy object cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "handlers/chat/fork/create.ts",
    "Failed fork object cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "lib/folio-collab-rooms.ts",
    "Failed collaboration snapshot cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "lib/uploads/file-comparison/sweep.ts",
    "Expired comparison staging object cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "lib/uploads/promote-tmp-object.ts",
    "Failed promotion object cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "lib/entities/create-from-buffer.ts",
    "Failed document writer cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "lib/entity-versions/create-entity-version-from-buffer.ts",
    "Failed version writer cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "lib/templates/create-template.ts",
    "Failed template writer cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "lib/style-set-package-cleanup-queue.ts",
    "Style package cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "lib/file-derivative-queue.ts",
    "Derivative cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "lib/buffer-intent-reconciliation.ts",
    "Unpublished writer-intent cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "lib/account-deletion-cleanup-queue.ts",
    "Durable cleanup runs only for keys recorded by the hold-filtered account erasure transaction; deletion delegates to the guarded file owner.",
  ],
  [
    "lib/entity-deletion-cleanup-queue.ts",
    "Durable cleanup runs only for keys recorded by the guarded entity deletion transaction; deletion delegates to the guarded file owner.",
  ],
  [
    "lib/scheduler/tasks/template-deletion-cleanup.ts",
    "Durable template cleanup delegates to the guarded organization-file deletion owner.",
  ],
  [
    "mcp/file-comparison-run.ts",
    "Comparison staging object cleanup delegates to the guarded organization-file deletion owner.",
  ],
]);

type DeletionCensus = {
  deletions: { location: string; guarded: boolean }[];
};

const censusSource = (source: string): DeletionCensus => {
  const file = ts.createSourceFile(
    "census.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = new Map<string, string>();
  const ownerChecks = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const specifier of bindings.elements) {
        const name = specifier.propertyName?.text ?? specifier.name.text;
        imports.set(specifier.name.text, name);
        if (
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text.includes("/legal-holds/") &&
          HOLD_CHECKS.has(name)
        ) {
          ownerChecks.add(specifier.name.text);
        }
      }
    }
  }
  const canonicalName = (node: ts.Expression): string | undefined => {
    if (ts.isIdentifier(node)) {
      return imports.get(node.text) ?? node.text;
    }
    if (ts.isPropertyAccessExpression(node)) {
      return node.name.text;
    }
    return undefined;
  };
  const guardOwners = new Set<ts.Node>();
  const transactionOwner = (node: ts.Node): ts.Node => {
    let current = node.parent;
    let nearestFunction: ts.Node | undefined;
    while (!ts.isSourceFile(current)) {
      if (ts.isFunctionLike(current)) {
        nearestFunction ??= current;
        const parent = current.parent;
        if (
          (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
          ts.isCallExpression(parent) &&
          parent.arguments.includes(current) &&
          ["safeDb", "transaction"].includes(
            canonicalName(parent.expression) ?? "",
          )
        ) {
          return current;
        }
      }
      current = current.parent;
    }
    return nearestFunction ?? file;
  };
  const findGuards = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ownerChecks.has(node.expression.text)
    ) {
      guardOwners.add(transactionOwner(node));
    }
    ts.forEachChild(node, findGuards);
  };
  findGuards(file);
  const deletions: { location: string; guarded: boolean }[] = [];
  const recordDeletion = (node: ts.Node, name: string): void => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    deletions.push({
      location: `${line + 1}:${name}`,
      guarded: guardOwners.has(transactionOwner(node)),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = canonicalName(node.expression);
      const argument = node.arguments.at(0);
      const table = argument && canonicalName(argument);
      const tableDeletion =
        name === "delete" && table !== undefined && PROTECTED_TABLES.has(table);
      const storageDeletion = name !== undefined && STORAGE_DELETIONS.has(name);
      const sdkDeletion =
        name === "send" &&
        argument !== undefined &&
        ts.isNewExpression(argument) &&
        ["DeleteObjectCommand", "DeleteObjectsCommand"].includes(
          canonicalName(argument.expression) ?? "",
        );
      const bunStorageDeletion =
        name === "delete" &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isCallExpression(node.expression.expression) &&
        canonicalName(node.expression.expression.expression) === "getS3";
      if (
        tableDeletion ||
        storageDeletion ||
        sdkDeletion ||
        bunStorageDeletion
      ) {
        recordDeletion(node, tableDeletion ? table : name);
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = canonicalName(node.tag);
      if (tag === "sql") {
        const raw = node.template.getText(file);
        const match = /\bDELETE\s+FROM\s+(?:public\.)?["']?([a-z_]+)/iu.exec(
          raw,
        );
        const table = match?.at(1);
        const canonicalTable = table && PROTECTED_SQL_TABLES.get(table);
        if (canonicalTable) {
          recordDeletion(node, canonicalTable);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { deletions };
};

const mapsHoldRefusal = (source: string): boolean => {
  const file = ts.createSourceFile(
    "refusal-census.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const mappers = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.includes("/legal-holds/refusal")
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const specifier of bindings.elements) {
        if (
          (specifier.propertyName?.text ?? specifier.name.text) ===
          "legalHoldRefusal"
        ) {
          mappers.add(specifier.name.text);
        }
      }
    }
  }
  let called = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      mappers.has(node.expression.text)
    ) {
      called = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return called;
};

const handlesLegalHoldActiveError = (source: string): boolean => {
  const file = ts.createSourceFile(
    "hold-error-census.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const errorNames = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.includes("/legal-holds/errors")
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const specifier of bindings.elements) {
        if (
          (specifier.propertyName?.text ?? specifier.name.text) ===
          "LegalHoldActiveError"
        ) {
          errorNames.add(specifier.name.text);
        }
      }
    }
  }
  let handled = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "is" &&
      ts.isIdentifier(node.expression.expression) &&
      errorNames.has(node.expression.expression.text)
    ) {
      handled = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return handled;
};

const uncoveredModule = (path: string, source: string): string[] => {
  const { deletions } = censusSource(source);
  return EXCEPTIONS.has(path)
    ? []
    : deletions
        .filter(({ guarded }) => !guarded)
        .map(({ location }) => `${path}:${location}`);
};

// Test modules and isolated fixture helpers own disposable test databases;
// production script modules remain in the census alongside application code.
const isProductionSource = (path: string): boolean =>
  !path.endsWith(".test.ts") &&
  !path.endsWith(".test.tsx") &&
  !path.startsWith("tests/") &&
  !path.includes("/__fixtures__/") &&
  !path.startsWith("__fixtures__/");

describe("legal hold deletion path census", () => {
  test("a deletion refusal must use the shared legal-hold mapping", () => {
    const plainRefusal = `
      import { LegalHoldActiveError as HoldError } from "@/api/lib/legal-holds/errors";
      import { HandlerError } from "@/api/lib/errors/tagged-errors";
      if (HoldError.is(result.error)) {
        return Result.err(new HandlerError({ status: 409, message: result.error.message }));
      }
    `;
    expect(handlesLegalHoldActiveError(plainRefusal)).toBe(true);
    expect(mapsHoldRefusal(plainRefusal)).toBe(false);
    expect(
      mapsHoldRefusal(`
        import { legalHoldRefusal as mapRefusal } from "@/api/lib/legal-holds/refusal";
        ${plainRefusal}
        return Result.err(mapRefusal(result.error));
      `),
    ).toBe(true);
  });

  test("every module handling a legal-hold refusal uses the shared mapping", async () => {
    const uncovered: string[] = [];
    for await (const relativePath of new Glob("handlers/**/*.{ts,tsx}").scan({
      cwd: SOURCE_ROOTS.src,
    })) {
      if (!isProductionSource(relativePath)) {
        continue;
      }
      const source = await Bun.file(
        `${SOURCE_ROOTS.src}/${relativePath}`,
      ).text();
      if (handlesLegalHoldActiveError(source) && !mapsHoldRefusal(source)) {
        uncovered.push(relativePath);
      }
    }
    expect(uncovered, uncovered.join("\n")).toEqual([]);
  });

  test("rejects unguarded row and storage deletion fixtures, including imported aliases", () => {
    const source = `
      import { entities as documents } from "@/api/db/schema";
      import { deleteOrganizationFileWithSignal as eraseObject } from "@/api/lib/files/delete-organization-file";
      await tx.delete(documents).where(eq(documents.id, id));
      await eraseObject(key, signal);
    `;
    expect(censusSource(source).deletions).toHaveLength(2);
    expect(uncoveredModule("handlers/fixture/delete.ts", source)).toHaveLength(
      2,
    );
    expect(
      uncoveredModule("scripts/unguarded-cleanup.ts", source),
    ).toHaveLength(2);
    expect(
      uncoveredModule(
        "handlers/fixture/delete.ts",
        `
      import { requireNoHold as checkHold } from "@/api/lib/legal-holds/holds";
      await checkHold({ tx, organizationId, target });
      ${source}
    `,
      ),
    ).toEqual([]);
  });

  test("comments and unused imports cannot satisfy a hold check", () => {
    const source = `
      import { requireNoHold } from "@/api/lib/legal-holds/holds";
      // requireNoHold({ tx, organizationId, target });
      await tx.delete(contacts);
    `;
    expect(uncoveredModule("handlers/fixture/delete.ts", source)).toHaveLength(
      1,
    );
    expect(
      uncoveredModule(
        "handlers/fixture/delete.ts",
        `
      import { requireNoHold } from "@/api/lib/unrelated-module";
      await requireNoHold();
      await tx.delete(contacts);
    `,
      ),
    ).toHaveLength(1);
  });

  test("a guard in one transaction does not cover a second delete call", () => {
    const source = `
      import { requireNoHold } from "@/api/lib/legal-holds/holds";
      await safeDb(async (tx) => {
        await requireNoHold({ tx, organizationId, target });
        await tx.delete(contacts);
      });
      await safeDb(async (tx) => {
        await tx.delete(workspaceContacts);
      });
    `;
    const census = censusSource(source);
    expect(census.deletions.map(({ guarded }) => guarded)).toEqual([
      true,
      false,
    ]);
    expect(uncoveredModule("handlers/fixture/delete.ts", source)).toHaveLength(
      1,
    );
  });

  test("raw DELETE FROM calls require a hold check", () => {
    const source =
      "await tx.execute(sql`DELETE FROM workspace_contacts WHERE id = " +
      "$" +
      "{id}`);";
    expect(censusSource(source).deletions).toEqual([
      { location: "1:workspaceContacts", guarded: false },
    ]);
    expect(uncoveredModule("handlers/fixture/raw-delete.ts", source)).toEqual([
      "handlers/fixture/raw-delete.ts:1:workspaceContacts",
    ]);
  });

  // timeout: the census parses every production module in the API and worker trees.
  test("every production deletion module checks holds or names its guarded boundary", async () => {
    const uncovered: string[] = [];
    const exercisedExceptions = new Set<string>();
    for (const [root, directory] of Object.entries(SOURCE_ROOTS)) {
      for await (const relativePath of new Glob("**/*.{ts,tsx}").scan({
        cwd: directory,
      })) {
        if (!isProductionSource(relativePath)) {
          continue;
        }
        const path = root === "src" ? relativePath : `${root}/${relativePath}`;
        const source = await Bun.file(`${directory}/${relativePath}`).text();
        const census = censusSource(source);
        if (census.deletions.length > 0 && EXCEPTIONS.has(path)) {
          exercisedExceptions.add(path);
        }
        uncovered.push(...uncoveredModule(path, source));
      }
    }
    expect(uncovered, uncovered.join("\n")).toEqual([]);
    expect([...EXCEPTIONS.keys()].toSorted()).toEqual(
      [...exercisedExceptions].toSorted(),
    );
    for (const reason of EXCEPTIONS.values()) {
      expect(reason.trim().length).toBeGreaterThan(30);
    }
  }, 15_000);
});
