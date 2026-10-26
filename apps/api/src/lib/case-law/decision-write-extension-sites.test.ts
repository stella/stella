import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

const apiRoot = path.resolve(import.meta.dir, "../../..");
const INPUT_COLUMNS = new Set([
  "country",
  "language",
  "decisionDate",
  "redactedAt",
  "fulltext",
  "sections",
  "documentAst",
  "contentHash",
  ...["text", "normalized", "ast"].map((name) => `${name}S3Key`),
]);

// This inventory checks mutation ownership and reachable extension calls. It
// cannot prove branch placement; transaction tests cover that behavior.
const MUTATION_OWNERS = {
  "handlers/case-law/ingestion/pipeline/decision-row.ts": {
    insertDecisionRowTx: "writeDecisionRow",
    writeDecisionRow: "writeDecisionRow",
  },
  "handlers/case-law/ingestion/pipeline/corpus-mirror.ts": {
    settleCaseLawCorpusMirrorTx: "settleCaseLawCorpusMirrorTx",
  },
  "handlers/case-law/erasure.ts": {
    redactCaseLawDecision: "redactCaseLawDecision",
    eraseFencedDecision: "redactCaseLawDecision",
  },
  "handlers/case-law/withdraw-document.ts": {
    withdrawCaseLawDecisionDocument: "withdrawCaseLawDecisionDocument",
  },
  "lib/legal-search/sk-document-backfill.ts": {
    applyStoredPayload: "applyStoredPayload",
    markDocumentUnavailableOwned: "markDocumentUnavailableOwned",
  },
  "lib/scheduler/tasks/case-law-redaction-tombstone-backfill.ts": {
    backfillCaseLawRedactionTombstones: "backfillCaseLawRedactionTombstones",
  },
  "scripts/backfill-corpus-storage.ts": {
    enqueueBackfillRow: "enqueueBackfillRow",
  },
  "scripts/corpus-column-trim.ts": { trimColumnRow: "trimColumnRow" },
  "scripts/repair-case-law-jsonb.ts": { repairBatch: "repairBatch" },
  "scripts/repair-decision-dates-plan.ts": {
    applyDecisionDateRepairsStatement: "repairDecisionDateBatch",
  },
} satisfies Record<string, Record<string, string>>;

const functionName = (node: ts.Node): string | null => {
  if (ts.isFunctionDeclaration(node)) {
    return node.name?.text ?? null;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return ts.isVariableDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name)
      ? node.parent.name.text
      : null;
  }
  return null;
};

const enclosingName = (node: ts.Node): string => {
  const name = functionName(node);
  return (
    name ?? (ts.isSourceFile(node) ? "<module>" : enclosingName(node.parent))
  );
};

const propertyName = (node: ts.PropertyName): string | null =>
  ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null;

const isCanonicalPayload = (
  node: ts.Expression | undefined,
  owner: string,
  bookkeepingSafe = false,
): boolean => {
  if (node && ts.isParenthesizedExpression(node)) {
    return isCanonicalPayload(node.expression, owner, bookkeepingSafe);
  }
  if (node && ts.isConditionalExpression(node)) {
    return (
      isCanonicalPayload(node.whenTrue, owner, bookkeepingSafe) ||
      isCanonicalPayload(node.whenFalse, owner, bookkeepingSafe)
    );
  }
  if (
    node &&
    ts.isIdentifier(node) &&
    node.text === "set" &&
    owner === "writeFetchBookkeeping" &&
    bookkeepingSafe
  ) {
    return false;
  }
  if (
    node &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "unchangedReadOutcomeMetadata"
  ) {
    return false;
  }
  if (node === undefined || !ts.isObjectLiteralExpression(node)) {
    return true;
  }
  return node.properties.some((property) => {
    if (ts.isSpreadAssignment(property)) {
      return isCanonicalPayload(property.expression, owner, bookkeepingSafe);
    }
    return (
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)) &&
      INPUT_COLUMNS.has(propertyName(property.name) ?? "")
    );
  });
};

const inspect = (file: string, text: string) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const bookkeeping = source.statements.find(
    (node) =>
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === "WriteFetchBookkeepingOptions",
  );
  const setMember =
    bookkeeping &&
    ts.isTypeAliasDeclaration(bookkeeping) &&
    ts.isTypeLiteralNode(bookkeeping.type)
      ? bookkeeping.type.members.find(
          (member) =>
            ts.isPropertySignature(member) &&
            propertyName(member.name) === "set",
        )
      : undefined;
  const bookkeepingSafe =
    setMember &&
    ts.isPropertySignature(setMember) &&
    setMember.type &&
    ts.isTypeLiteralNode(setMember.type)
      ? setMember.type.members.every(
          (member) =>
            ts.isPropertySignature(member) &&
            !INPUT_COLUMNS.has(propertyName(member.name) ?? ""),
        )
      : false;
  const tables = new Set(["caseLawDecisions"]);
  const functions = new Map<string, ts.Node>();
  const mutations = new Set<string>();
  const visit = (node: ts.Node) => {
    const name = functionName(node);
    if (name !== null) {
      functions.set(name, node);
    }
    if (
      ts.isImportSpecifier(node) &&
      (node.propertyName?.text ?? node.name.text) === "caseLawDecisions"
    ) {
      tables.add(node.name.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      const table = node.arguments.at(0);
      if (
        (method === "insert" || method === "update") &&
        table &&
        ts.isIdentifier(table) &&
        tables.has(table.text)
      ) {
        const member = node.parent;
        const call = member.parent;
        const payload =
          ts.isPropertyAccessExpression(member) &&
          member.name.text === "set" &&
          ts.isCallExpression(call)
            ? call.arguments.at(0)
            : undefined;
        if (
          method === "insert" ||
          isCanonicalPayload(payload, enclosingName(node), bookkeepingSafe)
        ) {
          mutations.add(enclosingName(node));
        }
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const sql = node.template.getText(source);
      if (
        /\bUPDATE\s+case_law_decisions\b[^;]*\bSET\s+(?:decision_date|country|language|redacted_at|fulltext|sections|document_ast|content_hash|text_s3_key|normalized_s3_key|ast_s3_key)\s*=/isu.test(
          sql,
        ) ||
        /\bINSERT\s+INTO\s+case_law_decisions\b/iu.test(sql)
      ) {
        mutations.add(enclosingName(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const calls = (node: ts.Node): Set<string> => {
    const names = new Set<string>();
    const walk = (child: ts.Node) => {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
        names.add(child.expression.text);
      }
      ts.forEachChild(child, walk);
    };
    walk(node);
    return names;
  };
  const reaches = (
    owner: string,
    target: string,
    seen = new Set<string>(),
  ): boolean => {
    if (seen.has(owner)) {
      return false;
    }
    seen.add(owner);
    const node = functions.get(owner);
    if (node === undefined) {
      return false;
    }
    const invoked = calls(node);
    return (
      invoked.has(target) ||
      [...invoked].some((callee) => reaches(callee, target, seen))
    );
  };
  return { mutations: [...mutations].toSorted(), reaches };
};

const problems = (file: string, text: string): string[] => {
  const owners: Record<string, string> =
    Object.entries(MUTATION_OWNERS).find(
      ([candidate]) => candidate === file,
    )?.[1] ?? {};
  const inspected = inspect(file, text);
  return inspected.mutations.flatMap((mutation) => {
    const owner = owners[mutation];
    if (owner === undefined) {
      return [`${file}:${mutation}: unregistered mutation`];
    }
    if (owner !== mutation && !inspected.reaches(owner, mutation)) {
      return [`${file}:${mutation}: owner does not reach mutation`];
    }
    return inspected.reaches(owner, "runDecisionWriteExtension")
      ? []
      : [`${file}:${mutation}: extension is unreachable`];
  });
};

describe("decision write extension ownership", () => {
  test("production input writers reach the extension", () => {
    const files = [
      ...new Bun.Glob("src/**/*.ts").scanSync({ cwd: apiRoot }),
    ].filter(
      (file) =>
        !file.endsWith(".test.ts") &&
        !file.includes("/tests/") &&
        !file.includes("/db/schema/") &&
        !file.includes("/db/migrations/") &&
        file !== "src/scripts/seed-migration-rehearsal-plan.ts",
    );
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain(
      "src/handlers/case-law/ingestion/pipeline/decision-row.ts",
    );
    const failures = files.flatMap((file) =>
      problems(file.slice(4), readFileSync(path.join(apiRoot, file), "utf-8")),
    );
    expect(failures).toEqual([]);
  });

  test("a new mutation function is rejected even in an existing owner file", () => {
    const planted =
      "const bypass = async (tx) => { await tx.update(caseLawDecisions).set({ fulltext: text }); };";
    expect(problems("handlers/case-law/erasure.ts", planted)).toEqual([
      "handlers/case-law/erasure.ts:bypass: unregistered mutation",
    ]);
  });

  test("an inventoried writer cannot lose its reachable extension", () => {
    const planted =
      "const redactCaseLawDecision = async (tx) => { await tx.update(caseLawDecisions).set({ redactedAt: now }); };";
    expect(problems("handlers/case-law/erasure.ts", planted)).toEqual([
      "handlers/case-law/erasure.ts:redactCaseLawDecision: extension is unreachable",
    ]);
  });

  test("aliased table writes and raw date writes cannot create new owners", () => {
    const planted = `import { caseLawDecisions as decisions } from "@/api/db/schema";
const bypass = async (tx) => { await tx.update(decisions).set({ language: "en" }); };
const rawBypass = () => sql\`UPDATE case_law_decisions SET decision_date = null\`;`;
    expect(problems("handlers/case-law/new-writer.ts", planted)).toEqual([
      "handlers/case-law/new-writer.ts:bypass: unregistered mutation",
      "handlers/case-law/new-writer.ts:rawBypass: unregistered mutation",
    ]);
  });
});
