import { expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";

const apiRoot = path.resolve(import.meta.dir, "../../../..");
const owner = "src/lib/lists/verification/read-run.ts";
const tableNames = new Set([
  "legalListVerificationBlocks",
  "legalListClaims",
  "readVerificationRun",
]);

const collectEvidenceReads = (source: string) => {
  const file = ts.createSourceFile(
    "fixture.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const aliases = new Set(tableNames);
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (tableNames.has((binding.propertyName ?? binding.name).text)) {
          aliases.add(binding.name.text);
        }
      }
    }
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }
  const isEvidenceReader = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) {
      return aliases.has(node.text);
    }
    if (ts.isPropertyAccessExpression(node)) {
      return (
        (namespaces.has(node.expression.getText(file)) ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "query")) &&
        tableNames.has(node.name.text)
      );
    }
    if (ts.isElementAccessExpression(node)) {
      return (
        namespaces.has(node.expression.getText(file)) &&
        ts.isStringLiteral(node.argumentExpression) &&
        tableNames.has(node.argumentExpression.text)
      );
    }
    return false;
  };
  const sites: string[] = [];
  let contentProjection = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      isEvidenceReader(node.expression) &&
      ["text", "anchor", "framing", "kind", "pageNumber", "blockId"].includes(
        node.name.text,
      )
    ) {
      contentProjection = true;
    }
    if (ts.isSpreadAssignment(node) && isEvidenceReader(node.expression)) {
      contentProjection = true;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "select"
    ) {
      const selection = node.arguments.at(0);
      if (selection === undefined || !ts.isObjectLiteralExpression(selection)) {
        contentProjection = true;
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.some(isEvidenceReader) &&
      !(
        ts.isPropertyAccessExpression(node.expression) &&
        ["from", "leftJoin", "innerJoin", "rightJoin", "fullJoin"].includes(
          node.expression.name.text,
        )
      )
    ) {
      contentProjection = true;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isEvidenceReader(node.initializer)
    ) {
      aliases.add(node.name.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["from", "leftJoin", "innerJoin", "rightJoin", "fullJoin"].includes(
        node.expression.name.text,
      )
    ) {
      const target = node.arguments.at(0);
      if (target && isEvidenceReader(target)) {
        sites.push(node.getText(file));
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["findMany", "findFirst"].includes(node.expression.name.text) &&
      isEvidenceReader(node.expression.expression)
    ) {
      sites.push(node.getText(file));
    }
    if (ts.isCallExpression(node) && isEvidenceReader(node.expression)) {
      sites.push(node.getText(file));
    }
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node)) &&
      /\b(?:FROM|JOIN)\s+(?:"?\w+"?\.)?"?legal_list_(?:claims|verification_blocks)\b/iu.test(
        node.text,
      )
    ) {
      sites.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { sites, contentProjection };
};

// These projections return counts or review state. Review mutations audit in
// their transaction; block and claim text belongs to the point reader.
const projections = new Map([
  ["src/handlers/lists/verifications/list.ts", "summary"],
  ["src/handlers/lists/verifications/latest/list.ts", "summary"],
  ["src/handlers/lists/verifications/claim-reviews/create.ts", "review"],
  ["src/handlers/lists/verifications/claim-reviews/bulk/create.ts", "review"],
]);

const pointReadHasBoundAudit = (source: string): boolean => {
  const file = ts.createSourceFile(
    "fixture.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const reads: {
    name: string;
    tx: string;
    block: ts.Node;
    position: number;
  }[] = [];
  const audits: {
    name: string;
    tx: string;
    block: ts.Node;
    position: number;
  }[] = [];
  const property = (call: ts.CallExpression, name: string) => {
    const options = call.arguments.at(0);
    if (options === undefined || !ts.isObjectLiteralExpression(options)) {
      return undefined;
    }
    for (const entry of options.properties) {
      if (ts.isShorthandPropertyAssignment(entry) && entry.name.text === name) {
        return entry.name.text;
      }
      if (ts.isPropertyAssignment(entry) && entry.name.getText(file) === name) {
        return entry.initializer.getText(file);
      }
    }
    return undefined;
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ts.isAwaitExpression(node.parent)
    ) {
      const tx = property(node, "tx");
      const statement = node.parent.parent;
      if (
        node.expression.text === "readVerificationRun" &&
        tx !== undefined &&
        ts.isVariableDeclaration(statement) &&
        ts.isIdentifier(statement.name)
      ) {
        reads.push({
          name: statement.name.text,
          tx,
          block: statement.parent.parent.parent,
          position: node.pos,
        });
      }
      if (
        node.expression.text === "recordVerificationRead" &&
        tx !== undefined &&
        ts.isExpressionStatement(statement)
      ) {
        const name = property(node, "run");
        if (name !== undefined) {
          audits.push({
            name,
            tx,
            block: statement.parent,
            position: node.pos,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return (
    reads.length === 1 &&
    reads.every((read) =>
      audits.some(
        (audit) =>
          audit.name === read.name &&
          audit.tx === read.tx &&
          audit.block === read.block &&
          audit.position > read.position,
      ),
    )
  );
};

type EvidenceReadIssuesOptions = { file: string; source: string };

const evidenceReadIssues = ({
  file,
  source,
}: EvidenceReadIssuesOptions): string[] => {
  if (collectEvidenceReads(source).sites.length === 0 || file === owner) {
    return [];
  }
  const projection = projections.get(file);
  if (projection !== undefined) {
    const issues = [];
    if (collectEvidenceReads(source).contentProjection) {
      issues.push("content projection");
    }
    if (projection === "review" && !/await recordAuditEvent\(/u.test(source)) {
      issues.push("missing review audit");
    }
    return issues;
  }
  if (file !== "src/handlers/lists/verifications/get.ts") {
    return ["unclassified evidence reader"];
  }
  return pointReadHasBoundAudit(source) ? [] : ["missing read audit"];
};

test("every verification evidence reader belongs to an audited point read or bounded projection", async () => {
  const readers = new Set<string>();
  for (const file of new Bun.Glob("{src,scripts}/**/*.ts").scanSync({
    cwd: apiRoot,
  })) {
    if (file.includes("/tests/") || /\.(?:test|type-test)\.ts$/u.test(file)) {
      continue;
    }
    const source = await Bun.file(path.join(apiRoot, file)).text();
    if (collectEvidenceReads(source).sites.length === 0) {
      continue;
    }
    readers.add(file);
    expect(evidenceReadIssues({ file, source }), file).toEqual([]);
  }
  expect([...readers].toSorted()).toEqual(
    [
      owner,
      "src/handlers/lists/verifications/get.ts",
      ...projections.keys(),
    ].toSorted(),
  );
});

test("the evidence census recognizes aliases, namespaces, raw SQL and point reads", () => {
  for (const source of [
    'import { legalListClaims as claims } from "@/api/db/schema"; tx.select().from(claims);',
    'import * as tables from "@/api/db/schema"; tx.select().from(tables.legalListVerificationBlocks);',
    'import * as tables from "@/api/db/schema"; tx.select().from(tables["legalListClaims"]);',
    "const blocks = legalListVerificationBlocks; tx.select().from(blocks);",
    "tx.query.legalListClaims.findMany();",
    "tx.execute(sql`SELECT * FROM public.legal_list_claims`);",
    'import { readVerificationRun as read } from "./read-run"; read({ tx });',
  ]) {
    expect(collectEvidenceReads(source).sites).toHaveLength(1);
  }
  expect(
    collectEvidenceReads("tx.insert(legalListClaims);").sites,
  ).toHaveLength(0);
});

test("the census rejects an unaudited point read and unclassified content read", () => {
  const source = "const run = await readVerificationRun({ tx }); return run;";
  expect(
    evidenceReadIssues({
      file: "src/handlers/lists/verifications/get.ts",
      source,
    }),
  ).toEqual(["missing read audit"]);
  expect(
    evidenceReadIssues({ file: "src/handlers/new-reader.ts", source }),
  ).toEqual(["unclassified evidence reader"]);
  expect(
    evidenceReadIssues({
      file: "src/handlers/lists/verifications/list.ts",
      source: "tx.select().from(legalListClaims);",
    }),
  ).toEqual(["content projection"]);
});

test("projection classification rejects aliased content and whole-table selections", () => {
  for (const source of [
    'import { legalListClaims as claims } from "@/api/db/schema"; tx.select({ text: claims.text }).from(claims);',
    'import { legalListClaims as claims } from "@/api/db/schema"; const all = getTableColumns(claims); tx.select(all).from(claims);',
    'import { legalListClaims as claims } from "@/api/db/schema"; tx.select({ ...getTableColumns(claims) }).from(claims);',
    "const claims = legalListClaims; tx.select({ ...claims }).from(claims);",
  ]) {
    expect(
      evidenceReadIssues({
        file: "src/handlers/lists/verifications/list.ts",
        source,
      }),
    ).toEqual(["content projection"]);
  }
});

test("point-read audit binds the returned run and transaction in the same block", () => {
  const read = "const run = await readVerificationRun({ tx });";
  const validAudit = "await recordVerificationRead({ tx, run });";
  expect(pointReadHasBoundAudit(`${read} ${validAudit} return run;`)).toBe(
    true,
  );
  for (const audit of [
    "await recordVerificationRead({ tx, run: otherRun });",
    "await recordVerificationRead({ tx: otherTx, run });",
    "if (run.status === 'completed') { await recordVerificationRead({ tx, run }); }",
    "recordVerificationRead({ tx, run });",
  ]) {
    expect(pointReadHasBoundAudit(`${read} ${audit} return run;`)).toBe(false);
  }
});
