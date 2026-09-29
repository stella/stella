import { describe, expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "../../../../..");
const writeHelpers = new Set([
  "writeTenantS3Object",
  "writeS3ObjectWithRetry",
  "putS3ObjectWithSignal",
  "putS3Object",
  "copyObject",
  "putPresignedUpload",
  "createS3ObjectIfAbsent",
  "createMultipartUpload",
  "uploadPart",
  "completeMultipartUpload",
]);
const writeCommands = new Set([
  "PutObjectCommand",
  "CopyObjectCommand",
  "CreateMultipartUploadCommand",
  "UploadPartCommand",
  "CompleteMultipartUploadCommand",
  "Upload",
]);
const ledgerCalls = new Set([
  "writeOrganizationFile",
  "copyOrganizationFile",
  "storeOcrSearchablePdfDerivative",
]);

type WriteSite = {
  file: string;
  name: string;
  ordinal: number;
  operation: string;
  ledgerBound: boolean;
  flagOff: boolean;
};

// These writes never create metered organization file objects. A changed call
// shape or an additional call must be reviewed here before it reaches CI.
const exemptions = {
  "src/handlers/reports/report-export-queue.ts:writeS3ObjectWithRetry:0":
    "export",
  "src/handlers/chat/export/create.ts:writeS3ObjectWithRetry:0": "export",
  "src/lib/legal-search/raw-source-storage.ts:createS3ObjectIfAbsent:0":
    "public_corpus",
  "src/lib/legal-search/raw-source-storage.ts:createS3ObjectIfAbsent:1":
    "public_corpus",
  "src/lib/legal-search/raw-source-storage.ts:createS3ObjectIfAbsent:2":
    "public_corpus",
  "src/lib/legal-search/raw-source-storage.ts:writeS3ObjectWithRetry:0":
    "public_corpus",
  "src/lib/legal-search/raw-source-storage.ts:copyObject:0": "public_corpus",
  "src/mcp/file-comparison-links-tool.ts:putPresignedUpload:0": "temporary",
  "src/mcp/document-file-upload.ts:putPresignedUpload:0": "temporary",
  "scripts/seed-email-viewer-demo.ts:writeS3ObjectWithRetry:0": "fixture",
  "scripts/seed-templates.ts:writeS3ObjectWithRetry:0": "fixture",
  "scripts/seed-templates.ts:writeS3ObjectWithRetry:1": "fixture",
  "scripts/seed-dev.ts:writeS3ObjectWithRetry:0": "fixture",
  "scripts/seed-dev.ts:writeS3ObjectWithRetry:1": "fixture",
  "src/handlers/uploads/update.ts:copyObject:0": "reservation_flow",
  "src/handlers/uploads/update.ts:writeS3ObjectWithRetry:0": "reservation_flow",
} as const satisfies Record<
  string,
  "export" | "public_corpus" | "temporary" | "fixture" | "reservation_flow"
>;

// Exact per-file counts close the gap where a new direct write lands in a
// function that already calls the ledger. Updating a count requires review of
// that file's new write site and key classification.
const expectedWriteCounts = {
  "scripts/backfill-image-thumbnails.ts": 2,
  "scripts/seed-dev.ts": 2,
  "scripts/seed-email-viewer-demo.ts": 1,
  "scripts/seed-templates.ts": 2,
  "src/handlers/chat/export/create.ts": 1,
  "src/handlers/chat/fork/create.ts": 2,
  "src/handlers/chat/upload-files.ts": 2,
  "src/handlers/entities/checkpoint-desktop-edit-session.ts": 2,
  "src/handlers/entities/checkpoint-folio-collab-room.ts": 2,
  "src/handlers/entities/copy-utils.ts": 2,
  "src/handlers/entities/finalize-desktop-edit-session.ts": 2,
  "src/handlers/entities/publish-folio-collab-version.ts": 2,
  "src/handlers/entities/upload.ts": 2,
  "src/handlers/reports/report-export-queue.ts": 1,
  "src/handlers/style-sets/storage.ts": 2,
  "src/handlers/uploads/update.ts": 2,
  "src/handlers/workspaces/duplicate.ts": 2,
  "src/lib/document-processing-queue.ts": 1,
  "src/lib/entities/create-from-buffer.ts": 2,
  "src/lib/entity-versions/create-entity-version-from-buffer.ts": 2,
  "src/lib/file-derivative-queue.ts": 4,
  "src/lib/folio-collab-rooms.ts": 2,
  "src/lib/legal-search/raw-source-storage.ts": 5,
  "src/lib/templates/create-template.ts": 1,
  "src/mcp/document-file-upload.ts": 1,
  "src/mcp/file-comparison-links-tool.ts": 1,
} as const satisfies Record<string, number>;

const invokedName = (
  node: ts.CallExpression | ts.NewExpression,
  imports: ReadonlyMap<string, string>,
) => {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    return imports.get(callee.text) ?? callee.text;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text === "write") {
      const receiver = callee.expression;
      if (
        (ts.isCallExpression(receiver) &&
          ts.isIdentifier(receiver.expression) &&
          (imports.get(receiver.expression.text) ??
            receiver.expression.text) === "getS3") ||
        (ts.isIdentifier(receiver) && imports.get(receiver.text) === "getS3")
      ) {
        return "getS3.write";
      }
    }
    return callee.name.text;
  }
  return null;
};

const isFlagOff = (node: ts.Node): boolean => {
  let child = node;
  let current = node.parent;
  while (!ts.isSourceFile(current)) {
    if (ts.isIfStatement(current)) {
      const condition = current.expression.getText();
      if (
        (condition === "!env.FEATURE_FILE_USAGE_LIMITS" &&
          child === current.thenStatement) ||
        (condition === "env.FEATURE_FILE_USAGE_LIMITS" &&
          child === current.elseStatement)
      ) {
        return true;
      }
    }
    if (ts.isConditionalExpression(current)) {
      const condition = current.condition.getText();
      if (
        (condition === "!env.FEATURE_FILE_USAGE_LIMITS" &&
          child === current.whenTrue) ||
        (condition === "env.FEATURE_FILE_USAGE_LIMITS" &&
          child === current.whenFalse)
      ) {
        return true;
      }
    }
    child = current;
    current = current.parent;
  }
  return false;
};

const ledgerCallback = (
  node: ts.Node,
  ast: ts.SourceFile,
  imports: ReadonlyMap<string, string>,
): boolean => {
  let current = node.parent;
  while (!ts.isSourceFile(current)) {
    if (ts.isFunctionLike(current)) {
      const fn = current;
      const parent = fn.parent;
      if (
        ts.isPropertyAssignment(parent) &&
        (parent.name.getText(ast) === "write" ||
          parent.name.getText(ast) === "copy") &&
        ts.isObjectLiteralExpression(parent.parent) &&
        ts.isCallExpression(parent.parent.parent) &&
        ledgerCalls.has(invokedName(parent.parent.parent, imports) ?? "")
      ) {
        return true;
      }
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        const callbackName = parent.name.text;
        let passedToLedger = false;
        const visit = (candidate: ts.Node) => {
          if (
            ts.isCallExpression(candidate) &&
            ledgerCalls.has(invokedName(candidate, imports) ?? "") &&
            candidate.arguments.some(
              (arg) =>
                ts.isObjectLiteralExpression(arg) &&
                arg.properties.some(
                  (property) =>
                    (ts.isPropertyAssignment(property) &&
                      (property.name.getText(ast) === "write" ||
                        property.name.getText(ast) === "copy") &&
                      ts.isIdentifier(property.initializer) &&
                      property.initializer.text === callbackName) ||
                    (ts.isShorthandPropertyAssignment(property) &&
                      property.name.text === callbackName &&
                      ((callbackName === "writePdf" &&
                        invokedName(candidate, imports) ===
                          "storeOcrSearchablePdfDerivative") ||
                        callbackName === "write" ||
                        callbackName === "copy")),
                ),
            )
          ) {
            passedToLedger = true;
          }
          ts.forEachChild(candidate, visit);
        };
        visit(parent.parent.parent.parent);
        return passedToLedger;
      }
    }
    current = current.parent;
  }
  return false;
};

const scan = (file: string, source: string): WriteSite[] => {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = new Map<string, string>();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) {
      continue;
    }
    for (const element of named.elements) {
      imports.set(
        element.name.text,
        element.propertyName?.text ?? element.name.text,
      );
    }
  }
  const visitAliases = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      if (initializer && ts.isIdentifier(initializer)) {
        const target = imports.get(initializer.text) ?? initializer.text;
        if (writeHelpers.has(target) || target === "getS3") {
          imports.set(node.name.text, target);
        }
      }
      if (
        initializer &&
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        (imports.get(initializer.expression.text) ??
          initializer.expression.text) === "getS3"
      ) {
        imports.set(node.name.text, "getS3");
      }
      if (
        initializer &&
        ts.isPropertyAccessExpression(initializer) &&
        initializer.name.text === "write" &&
        ts.isCallExpression(initializer.expression) &&
        ts.isIdentifier(initializer.expression.expression) &&
        (imports.get(initializer.expression.expression.text) ??
          initializer.expression.expression.text) === "getS3"
      ) {
        imports.set(node.name.text, "getS3.write");
      }
    }
    ts.forEachChild(node, visitAliases);
  };
  visitAliases(ast);
  const ordinals = new Map<string, number>();
  const sites: WriteSite[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = invokedName(node, imports);
      if (
        name &&
        (writeHelpers.has(name) ||
          writeCommands.has(name) ||
          name === "getS3.write")
      ) {
        const ordinal = ordinals.get(name) ?? 0;
        ordinals.set(name, ordinal + 1);
        sites.push({
          file,
          name,
          ordinal,
          operation: node.getText(ast).replace(/\s+/gu, " "),
          ledgerBound: ledgerCallback(node, ast, imports),
          flagOff: isFlagOff(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return sites;
};

describe("durable organization file writes", () => {
  test("rejects a new direct write and recognizes a ledger write callback", () => {
    const direct = scan(
      "src/example.ts",
      "const save = async () => await writeS3ObjectWithRetry({ key, data });",
    );
    expect(direct).toMatchObject([{ ledgerBound: false }]);

    const reserved = scan(
      "src/example.ts",
      "const save = async () => await writeOrganizationFile({ objectKey, organizationId, sizeBytes, write: async () => await writeS3ObjectWithRetry({ key, data }) });",
    );
    expect(reserved).toMatchObject([{ ledgerBound: true }]);

    const native = scan(
      "src/example.ts",
      "const save = async () => await client.send(new PutObjectCommand({ Key: key }));",
    );
    expect(native).toMatchObject([
      { ledgerBound: false, name: "PutObjectCommand" },
    ]);

    const aliased = scan(
      "src/example.ts",
      'import { writeS3ObjectWithRetry as saveObject } from "@/api/lib/s3"; const save = async () => await saveObject({ key, data });',
    );
    expect(aliased).toMatchObject([
      { ledgerBound: false, name: "writeS3ObjectWithRetry" },
    ]);

    const sibling = scan(
      "src/example.ts",
      "const save = async () => { await writeOrganizationFile({ write: async () => await writeS3ObjectWithRetry({ key }) }); await writeS3ObjectWithRetry({ key }); };",
    );
    expect(sibling).toMatchObject([
      { ledgerBound: true },
      { ledgerBound: false },
    ]);

    const sameNameInAnotherScope = scan(
      "src/example.ts",
      "const first = () => { const persist = async () => await writeS3ObjectWithRetry({ key }); }; const second = () => { const persist = async () => await writeS3ObjectWithRetry({ key }); return writeOrganizationFile({ write: persist }); };",
    );
    expect(sameNameInAnotherScope).toMatchObject([
      { ledgerBound: false },
      { ledgerBound: true },
    ]);

    expect(
      scan("src/example.ts", "await getS3().write(key, data)"),
    ).toMatchObject([{ ledgerBound: false, name: "getS3.write" }]);
    expect(
      scan(
        "src/example.ts",
        "const client = getS3(); const save = writeS3ObjectWithRetry; const rawWrite = getS3().write; await client.write(key, data); await save({ key, data }); await rawWrite(key, data);",
      ),
    ).toMatchObject([
      { ledgerBound: false, name: "getS3.write" },
      { ledgerBound: false, name: "writeS3ObjectWithRetry" },
      { ledgerBound: false, name: "getS3.write" },
    ]);
  });

  test("all direct storage writes have a ledger boundary or an explicit exemption", async () => {
    const files = [
      ...new Bun.Glob("src/**/*.ts").scanSync({
        cwd: path.join(root, "apps/api"),
      }),
      ...new Bun.Glob("scripts/**/*.ts").scanSync({
        cwd: path.join(root, "apps/api"),
      }),
    ].filter(
      (file) =>
        !file.endsWith(".test.ts") &&
        !file.endsWith(".spec.ts") &&
        file !== "src/lib/s3.ts" &&
        file !== "src/lib/s3-presign.ts",
    );
    const sites = await Promise.all(
      files.map(async (file) =>
        scan(file, await Bun.file(path.join(root, "apps/api", file)).text()),
      ),
    );
    const allSites = sites.flat();
    const counts = Object.fromEntries(
      [...new Set(allSites.map((site) => site.file))]
        .toSorted()
        .map((file) => [
          file,
          allSites.filter((site) => site.file === file).length,
        ]),
    );
    expect(counts).toEqual(expectedWriteCounts);
    const unbound = allSites.filter(
      (site) => !site.ledgerBound && !site.flagOff,
    );
    const exemptionIds = unbound.map(
      (site) => `${site.file}:${site.name}:${site.ordinal}`,
    );
    const unaccounted = unbound.filter(
      (site) => !(`${site.file}:${site.name}:${site.ordinal}` in exemptions),
    );
    expect(unaccounted).toEqual([]);
    expect(exemptionIds.toSorted()).toEqual(Object.keys(exemptions).toSorted());
    const exemptionById = new Map(Object.entries(exemptions));
    for (const site of unbound) {
      const category = exemptionById.get(
        `${site.file}:${site.name}:${site.ordinal}`,
      );
      if (category === undefined) {
        throw new Error("Unaccounted storage write exemption");
      }
      switch (category) {
        case "export": {
          const source = await Bun.file(
            path.join(root, "apps/api", site.file),
          ).text();
          expect(source).toContain("exports/");
          break;
        }
        case "public_corpus": {
          const source = await Bun.file(
            path.join(root, "apps/api", site.file),
          ).text();
          expect(source).toContain("formatCorpusLocation");
          break;
        }
        case "temporary":
          expect(site.operation).toContain("url: reservation.url");
          break;
        case "fixture":
          expect(site.file.startsWith("scripts/seed-")).toBe(true);
          break;
        case "reservation_flow": {
          const source = await Bun.file(
            path.join(root, "apps/api", site.file),
          ).text();
          expect(source).toContain("reserveOrganizationFileBytes(");
          expect(source).toContain("commitOrganizationFileBytes(");
          break;
        }
      }
    }
  });
});
