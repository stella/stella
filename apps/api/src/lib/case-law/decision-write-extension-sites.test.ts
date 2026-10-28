import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  type Node,
  parseSource,
  type TSType,
  walk,
} from "@stll/scripts/src/syntax-tree";

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

const functionName = (node: Node, parent: Node | undefined): string | null => {
  if (node.type === "FunctionDeclaration") {
    return node.id?.name ?? null;
  }
  if (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression"
  ) {
    return parent?.type === "VariableDeclarator" &&
      parent.id.type === "Identifier"
      ? parent.id.name
      : null;
  }
  return null;
};

const enclosingName = (node: Node, ancestors: readonly Node[]): string => {
  const chain = [...ancestors, node];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const current = chain[index];
    const name =
      current === undefined ? null : functionName(current, chain[index - 1]);
    if (name !== null) {
      return name;
    }
  }
  return "<module>";
};

const propertyName = (key: Node, computed: boolean): string | null => {
  if (computed) {
    return null;
  }
  if (key.type === "Identifier") {
    return key.name;
  }
  return key.type === "Literal" && typeof key.value === "string"
    ? key.value
    : null;
};

const isCanonicalPayload = (
  node: Node | undefined,
  owner: string,
  bookkeepingSafe = false,
): boolean => {
  if (node?.type === "ParenthesizedExpression") {
    return isCanonicalPayload(node.expression, owner, bookkeepingSafe);
  }
  if (node?.type === "ConditionalExpression") {
    return (
      isCanonicalPayload(node.consequent, owner, bookkeepingSafe) ||
      isCanonicalPayload(node.alternate, owner, bookkeepingSafe)
    );
  }
  if (
    node?.type === "Identifier" &&
    node.name === "set" &&
    owner === "writeFetchBookkeeping" &&
    bookkeepingSafe
  ) {
    return false;
  }
  if (
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "unchangedReadOutcomeMetadata"
  ) {
    return false;
  }
  if (node?.type !== "ObjectExpression") {
    return true;
  }
  return node.properties.some((property) => {
    if (property.type === "SpreadElement") {
      return isCanonicalPayload(property.argument, owner, bookkeepingSafe);
    }
    return (
      !property.method &&
      property.kind === "init" &&
      INPUT_COLUMNS.has(propertyName(property.key, property.computed) ?? "")
    );
  });
};

/** Property signatures of a type literal, or undefined for any other type. */
const typeLiteralMembers = (type: TSType | undefined) =>
  type?.type === "TSTypeLiteral" ? type.members : undefined;

const inspect = (file: string, text: string) => {
  const source = parseSource(file, text);
  const bookkeeping = source.program.body
    .map((statement) =>
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement,
    )
    .find(
      (node) =>
        node?.type === "TSTypeAliasDeclaration" &&
        node.id.name === "WriteFetchBookkeepingOptions",
    );
  const setMember =
    bookkeeping?.type === "TSTypeAliasDeclaration"
      ? typeLiteralMembers(bookkeeping.typeAnnotation)?.find(
          (member) =>
            member.type === "TSPropertySignature" &&
            propertyName(member.key, member.computed) === "set",
        )
      : undefined;
  const setMembers =
    setMember?.type === "TSPropertySignature"
      ? typeLiteralMembers(setMember.typeAnnotation?.typeAnnotation)
      : undefined;
  const bookkeepingSafe =
    setMembers?.every(
      (member) =>
        member.type === "TSPropertySignature" &&
        !INPUT_COLUMNS.has(propertyName(member.key, member.computed) ?? ""),
    ) ?? false;
  const tables = new Set(["caseLawDecisions"]);
  const functions = new Map<string, Node>();
  const mutations = new Set<string>();
  walk(source.program, (node, ancestors) => {
    const name = functionName(node, ancestors.at(-1));
    if (name !== null) {
      functions.set(name, node);
    }
    if (
      node.type === "ImportSpecifier" &&
      (node.imported.type === "Identifier"
        ? node.imported.name
        : node.imported.value) === "caseLawDecisions"
    ) {
      tables.add(node.local.name);
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.property.type === "Identifier"
    ) {
      const method = node.callee.property.name;
      const table = node.arguments.at(0);
      if (
        (method === "insert" || method === "update") &&
        table?.type === "Identifier" &&
        tables.has(table.name)
      ) {
        const member = ancestors.at(-1);
        const call = ancestors.at(-2);
        const payload =
          member?.type === "MemberExpression" &&
          !member.computed &&
          member.property.type === "Identifier" &&
          member.property.name === "set" &&
          call?.type === "CallExpression"
            ? call.arguments.at(0)
            : undefined;
        if (
          method === "insert" ||
          isCanonicalPayload(
            payload,
            enclosingName(node, ancestors),
            bookkeepingSafe,
          )
        ) {
          mutations.add(enclosingName(node, ancestors));
        }
      }
    }
    if (node.type === "TaggedTemplateExpression") {
      const sql = text.slice(node.quasi.start, node.quasi.end);
      if (
        /\bUPDATE\s+case_law_decisions\b[^;]*\bSET\s+(?:decision_date|country|language|redacted_at|fulltext|sections|document_ast|content_hash|text_s3_key|normalized_s3_key|ast_s3_key)\s*=/isu.test(
          sql,
        ) ||
        /\bINSERT\s+INTO\s+case_law_decisions\b/iu.test(sql)
      ) {
        mutations.add(enclosingName(node, ancestors));
      }
    }
  });
  const calls = (node: Node): Set<string> => {
    const names = new Set<string>();
    walk(node, (child) => {
      if (
        child.type === "CallExpression" &&
        child.callee.type === "Identifier"
      ) {
        names.add(child.callee.name);
      }
    });
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
