import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const apiRoot = path.resolve(import.meta.dir, "../../../apps/api");
const fields = new Set([
  "citationKey",
  "citationText",
  "citedCourtHint",
  "normalizedIdentifierValue",
]);
const tables = new Set([
  "caseLawDecisions",
  "caseLawCitations",
  "caseLawCitationReviews",
]);
const sqlWrite =
  /(?:\bINSERT\s+INTO\b[^()]*\([^)]*\b(?:citation_key|citation_text|cited_court_hint|normalized_identifier_value)\b)|(?:\bUPDATE\b(?:(?!\bSET\b)[\s\S])*?\bSET\b(?:(?!\bWHERE\b|\bRETURNING\b|\bFROM\b)[\s\S])*?\b(?:citation_key|citation_text|cited_court_hint|normalized_identifier_value)"?\s*=)/gisu;

type Writer = { id: string; file: string; payload: string; expression: string };
type Declaration = {
  disposition: "bounded" | "copy" | "null" | "synthetic";
  reason: string;
};

const declarations: Record<string, Declaration> = {
  "scripts/seed-case-law.ts:seedFixtures:orm-values-caseLawDecisions:1": {
    disposition: "copy",
    reason: "stored fixture decision fields omit citation key",
  },
  "src/handlers/case-law/ingestion/decision-identifier-backfill.ts:projectCitationPage:sql:1":
    {
      disposition: "bounded",
      reason:
        "normalized identifier SQL parameter is checked before interpolation",
    },
  "src/handlers/case-law/ingestion/pipeline/decision-row.ts:insertDecisionRowTx:orm-values-caseLawDecisions:1":
    {
      disposition: "bounded",
      reason: "insertedRowValues carries decisionDocketColumns",
    },
  "src/handlers/case-law/ingestion/pipeline/decision-row.ts:insertDecisionRowTx:orm-values-caseLawDecisions:2":
    {
      disposition: "bounded",
      reason: "insertedRowValues carries decisionDocketColumns",
    },
  "src/handlers/case-law/ingestion/pipeline/decision-row.ts:writeDecisionRow:orm-set-caseLawDecisions:1":
    {
      disposition: "bounded",
      reason: "row update carries planned docket columns",
    },
  "src/handlers/case-law/ingestion/pipeline/decision-row.ts:writeDecisionRow:orm-set-caseLawDecisions:2":
    {
      disposition: "copy",
      reason: "corpus payload columns contain no citation identity",
    },
  "src/handlers/case-law/ingestion/pipeline/citations.ts:writeDecisionCitations:orm-values-caseLawCitations:1":
    {
      disposition: "bounded",
      reason: "settled citationRowOf projections check all storage fields",
    },
  "src/handlers/case-law/ingestion/supplement-absorption.ts:absorbStandaloneSupplementRow:orm-set-caseLawDecisions:1":
    { disposition: "null", reason: "absorbed rows clear their citation key" },
  "src/scripts/backfill-citation-keys.ts:step:sql:1": {
    disposition: "bounded",
    reason: "values derive from bounded decisionCitationKeyOf or citationKeyOf",
  },
  "src/scripts/backfill-citation-keys.ts:step:sql:2": {
    disposition: "bounded",
    reason: "values derive from bounded decisionCitationKeyOf or citationKeyOf",
  },
  "src/scripts/backfill-citation-keys.ts:step:sql:3": {
    disposition: "bounded",
    reason: "values derive from bounded decisionCitationKeyOf or citationKeyOf",
  },
  "src/scripts/apply-reviewed-citation-labels-plan.ts:upsertReviewsStatement:sql:1":
    {
      disposition: "bounded",
      reason: "review insertion checks each key interpolation",
    },
  "src/scripts/normalize-case-numbers-sql.ts:normalizeSheetNumbersStatement:sql:1":
    { disposition: "null", reason: "normalization clears stale key" },
  "src/scripts/seed-migration-rehearsal-plan.ts:case_law_decisions:sql:1": {
    disposition: "synthetic",
    reason: "integer generated short docket and key",
  },
  "src/scripts/seed-migration-rehearsal-plan.ts:case_law_citations:sql:1": {
    disposition: "copy",
    reason: "copies synthetic rehearsal decision key and short docket",
  },
  "src/handlers/case-law/ingestion/pipeline/decision-existing.ts:advancePartialObservationWatermark:orm-set-caseLawDecisions:1":
    {
      disposition: "copy",
      reason:
        "metadata or document payload update; no citation identity assignment",
    },
  "src/handlers/case-law/ingestion/pipeline/decision-existing.ts:advanceUnchangedObservationWatermark:orm-set-caseLawDecisions:1":
    {
      disposition: "copy",
      reason:
        "metadata or document payload update; no citation identity assignment",
    },
  "src/handlers/case-law/ingestion/pipeline/corpus-mirror.ts:settleCaseLawCorpusMirrorTx:orm-set-caseLawDecisions:1":
    {
      disposition: "copy",
      reason:
        "metadata or document payload update; no citation identity assignment",
    },
  "src/handlers/case-law/withdraw-document.ts:withdrawCaseLawDecisionDocument:orm-set-caseLawDecisions:1":
    {
      disposition: "copy",
      reason:
        "metadata or document payload update; no citation identity assignment",
    },
  "src/scripts/corpus-column-trim.ts:trimRow:orm-set-caseLawDecisions:1": {
    disposition: "copy",
    reason:
      "metadata or document payload update; no citation identity assignment",
  },
  "src/scripts/backfill-corpus-storage.ts:apply:orm-set-caseLawDecisions:1": {
    disposition: "copy",
    reason:
      "metadata or document payload update; no citation identity assignment",
  },
  "src/lib/legal-search/sk-document-backfill.ts:applyStoredPayload:orm-set-caseLawDecisions:1":
    {
      disposition: "copy",
      reason:
        "metadata or document payload update; no citation identity assignment",
    },
  "src/lib/legal-search/sk-document-backfill.ts:writeFetchBookkeeping:orm-set-caseLawDecisions:1":
    {
      disposition: "copy",
      reason:
        "metadata or document payload update; no citation identity assignment",
    },
  "src/lib/legal-search/sk-document-backfill.ts:markDocumentUnavailableOwned:orm-set-caseLawDecisions:1":
    {
      disposition: "copy",
      reason:
        "metadata or document payload update; no citation identity assignment",
    },
};

const propertyName = (node: ts.PropertyName) => {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
    return node.text;
  }
  if (ts.isComputedPropertyName(node) && ts.isStringLiteral(node.expression)) {
    return node.expression.text;
  }
  return null;
};

const ownerOf = (node: ts.Node): string => {
  let parent = node;
  while (!ts.isSourceFile(parent)) {
    if (ts.isFunctionDeclaration(parent) && parent.name) {
      return parent.name.text;
    }
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer &&
      (ts.isArrowFunction(parent.initializer) ||
        ts.isFunctionExpression(parent.initializer)) &&
      ts.isIdentifier(parent.name)
    ) {
      return parent.name.text;
    }
    if (
      ts.isPropertyAssignment(parent) &&
      (ts.isArrowFunction(parent.initializer) ||
        ts.isFunctionExpression(parent.initializer))
    ) {
      return propertyName(parent.name) ?? "computed-producer";
    }
    parent = parent.parent;
  }
  return "module";
};

const writtenFields = (node: ts.Expression): string[] | null => {
  if (!ts.isObjectLiteralExpression(node)) {
    return null;
  }
  if (
    node.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) ||
        (ts.isPropertyAssignment(property) &&
          ts.isComputedPropertyName(property.name) &&
          propertyName(property.name) === null),
    )
  ) {
    return null;
  }
  return node.properties.flatMap((property) => {
    if (ts.isShorthandPropertyAssignment(property)) {
      return fields.has(property.name.text) ? [property.name.text] : [];
    }
    if (!ts.isPropertyAssignment(property)) {
      return [];
    }
    const name = propertyName(property.name);
    return name && fields.has(name) ? [name] : [];
  });
};

const discoverWriters = (file: string, text: string): Writer[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const aliases = new Map([...tables].map((name) => [name, name]));
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const binding of bindings.elements) {
      const imported = binding.propertyName?.text ?? binding.name.text;
      if (tables.has(imported)) {
        aliases.set(binding.name.text, imported);
      }
    }
  }
  const tableOf = (expression: ts.Expression): string | null => {
    if (
      !ts.isCallExpression(expression) ||
      !ts.isPropertyAccessExpression(expression.expression)
    ) {
      return null;
    }
    const member = expression.expression;
    if (member.name.text === "insert" || member.name.text === "update") {
      const target = expression.arguments[0];
      if (!target) {
        return null;
      }
      if (ts.isIdentifier(target)) {
        return aliases.get(target.text) ?? null;
      }
      if (
        ts.isPropertyAccessExpression(target) &&
        tables.has(target.name.text)
      ) {
        return target.name.text;
      }
      return null;
    }
    return tableOf(member.expression);
  };
  const found: Writer[] = [];
  const counts = new Map<string, number>();
  const add = (node: ts.Node, kind: string, payload: string) => {
    const base = `${file}:${ownerOf(node)}:${kind}`;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    found.push({
      id: `${base}:${count}`,
      file,
      payload,
      expression: node.getText(source),
    });
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const member = node.expression;
      const table = tableOf(member.expression);
      let payload = node.arguments[0];
      if (
        table &&
        ["values", "set", "onConflictDoUpdate"].includes(member.name.text) &&
        payload
      ) {
        if (
          member.name.text === "onConflictDoUpdate" &&
          ts.isObjectLiteralExpression(payload)
        ) {
          payload = payload.properties
            .flatMap((property) =>
              ts.isPropertyAssignment(property) &&
              propertyName(property.name) === "set"
                ? [property.initializer]
                : [],
            )
            .at(0);
        }
        if (payload) {
          const written = writtenFields(payload);
          if (
            member.name.text === "values" ||
            written === null ||
            written.length > 0
          ) {
            add(
              node,
              `orm-${member.name.text}-${table}`,
              payload.getText(source),
            );
          }
        }
      }
    }
    let sqlText: string | undefined;
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) {
      sqlText = node.text;
    }
    if (ts.isTemplateExpression(node)) {
      sqlText =
        node.head.text +
        node.templateSpans.map((span) => ` EXPR ${span.literal.text}`).join("");
    }
    if (sqlText !== undefined && sqlWrite.test(sqlText)) {
      add(node, "sql", sqlText);
    }
    sqlWrite.lastIndex = 0;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const files = ["src", "scripts"].flatMap((directory) =>
  [...new Bun.Glob(`${directory}/**/*.ts`).scanSync({ cwd: apiRoot })].filter(
    (file) =>
      !file.endsWith(".test.ts") &&
      !file.endsWith(".d.ts") &&
      !file.includes("/node_modules/") &&
      !file.startsWith("src/db/schema/") &&
      !file.startsWith("src/db/migrations/") &&
      !file.startsWith("src/tests/"),
  ),
);
const sources = new Map(
  files.map((file) => [file, readFileSync(path.join(apiRoot, file), "utf-8")]),
);
const writers = [...sources].flatMap(([file, source]) =>
  discoverWriters(file, source),
);
const boundedPayloadProblems = (members: readonly Writer[]): string[] =>
  members.flatMap((writer) => {
    if (declarations[writer.id]?.disposition !== "bounded") {
      return [];
    }
    let expected: RegExp;
    if (writer.id.includes(":insertDecisionRowTx:")) {
      expected =
        /^insertedRowValues\(write,\s*slugLadder\((?:attempt|finalAttempt)\)\)$/u;
    } else if (writer.id.includes(":writeDecisionRow:")) {
      expected = /^set$/u;
    } else if (writer.id.includes(":writeDecisionCitations:")) {
      expected = /^settled$/u;
    } else if (writer.id.includes("backfill-citation-keys.ts")) {
      expected =
        /WITH v\(id, key\) AS \(VALUES \$\{values\}\)[\s\S]*SET citation_key = v\.key/u;
    } else if (writer.id.includes(":upsertReviewsStatement:")) {
      expected = /\$\{checked\.value\}/u;
    } else {
      expected =
        /WITH projected\(id, type, normalized_value\) AS \(VALUES \$\{projected\}\)[\s\S]*normalized_identifier_value = projected\.normalized_value/u;
    }
    const subject = writer.id.includes(":sql:")
      ? writer.expression
      : writer.payload;
    return expected.test(subject) ? [] : [writer.id];
  });

const unauthorized = (members: readonly Writer[]) =>
  members
    .filter(({ id }) => !(id in declarations))
    .map(({ id }) => id)
    .toSorted();

test("every citation storage writer has an exercised bounded, copy, null or synthetic disposition", () => {
  expect(unauthorized(writers)).toEqual([]);
  expect(writers.map(({ id }) => id).toSorted()).toEqual(
    Object.keys(declarations).toSorted(),
  );
});

test("new ORM and SQL writers require their own checked producer", () => {
  const cases = [
    `db.execute(sql\`INSERT INTO case_law_citations (normalized_identifier_value) VALUES (\${supplied})\`);`,
    "db.insert(caseLawCitations).values({citationKey: supplied});",
    "db.update(caseLawDecisions).set({citationKey: supplied});",
    'db.update(caseLawDecisions).set({["citationKey"]: supplied});',
    "db.update(caseLawDecisions).set({...supplied});",
    "db.insert(caseLawCitationReviews).values(rows);",
    'import { caseLawCitations as citations } from "@/api/db/schema"; db.insert(citations).values(rows);',
    `db.execute(sql\`INSERT INTO case_law_citations (citation_key) VALUES (\${supplied})\`);`,
    `db.execute(sql\`UPDATE case_law_decisions SET citation_key = \${supplied}\`);`,
    `db.execute(sql\`UPDATE \${sql.raw(table)} SET citation_key = \${supplied}\`);`,
    "db.insert(caseLawDecisions).values(rows).onConflictDoUpdate({target: id, set: {citationKey: supplied}});",
  ];
  for (const text of cases) {
    const found = discoverWriters("src/scripts/new-citation-writer.ts", text);
    expect(found.length).toBeGreaterThan(0);
    expect(unauthorized(found)).toHaveLength(found.length);
  }
});

test("column readers and unrelated updates are not citation writers", () => {
  expect(
    discoverWriters(
      "read.ts",
      [
        "db.select({citationKey: caseLawDecisions.citationKey});",
        "db.update(caseLawDecisions).set({slug: supplied});",
        "db.execute(sql`SELECT citation_key FROM case_law_citations`);",
        `db.execute(sql\`UPDATE case_law_citations SET polarity = NULL WHERE citation_key = \${key}\`);`,
      ].join("\n"),
    ),
  ).toEqual([]);
});

const producerText = (source: string, name: string): string => {
  const file = ts.createSourceFile(
    "producer.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let result = "";
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      result = node.initializer.getText(file);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
};

const producerProblems = (input: ReadonlyMap<string, string>): string[] => {
  const problems: string[] = [];
  const requireProducer = (
    file: string,
    name: string,
    patterns: readonly RegExp[],
  ) => {
    const body = producerText(input.get(file) ?? "", name);
    for (const pattern of patterns) {
      if (!pattern.test(body)) {
        problems.push(`${file}:${name}:${pattern.source}`);
      }
    }
  };
  const pipeline = "src/handlers/case-law/ingestion/pipeline/";
  requireProducer(
    "src/handlers/case-law/ingestion/citation-extractor.ts",
    "citationKeyOf",
    [
      /^\(text:\s*string\)[\s\S]*=>\s*boundedCitationKey\(bareCitationKey\(text\)\)$/u,
    ],
  );
  requireProducer(
    "src/handlers/case-law/ingestion/citation-extractor.ts",
    "decisionCitationKeyOf",
    [/citationKeyOf\(caseNumber\)/u],
  );
  requireProducer(
    `${pipeline}decision-docket-columns.ts`,
    "decisionDocketColumns",
    [
      /citationKey:\s*decisionCitationKeyOf\(\{\s*caseNumber,\s*caseNumberType\s*\}\)/u,
    ],
  );
  requireProducer(`${pipeline}citations.ts`, "citationRowOf", [
    /const citationText = yield\* assertCitationStorageField\(\s*"text",\s*reference\.printed\s*,?\s*\)/u,
    /const citationKey = yield\* assertCitationStorageField\(\s*"key",\s*reference\.citationKey\s*,?\s*\)/u,
    /const citedCourtHint = yield\* assertCitationStorageField\(\s*"courtHint",\s*reference\.hints\.court\s*,?\s*\)/u,
    /const normalizedIdentifierValue = yield\* assertCitationStorageField\(\s*"normalizedIdentifier",\s*identifier\.normalizedValue\s*,?\s*\)/u,
  ]);
  requireProducer(`${pipeline}citations.ts`, "planDecisionCitations", [
    /return citationRowsOf\(plan\)\.map\(\(\) => plan\)/u,
  ]);
  requireProducer(`${pipeline}citations.ts`, "citationRowsOf", [
    /references\.map\(\(reference\)\s*=>\s*citationRowOf\(citingDecisionId,\s*reference\)\)/u,
  ]);
  requireProducer(`${pipeline}citations.ts`, "writeDecisionCitations", [
    /const projected = citationRowsOf\(citations\)/u,
    /if \(projected\.isErr\(\)\) \{\s*abortTransaction\(projected\.error\)/u,
    /const rows = projected\.value/u,
    /\.values\(settled\)/u,
  ]);
  requireProducer(`${pipeline}decision-row.ts`, "insertedRowValues", [
    /\.\.\.docketColumns/u,
  ]);
  requireProducer(`${pipeline}decision-plan.ts`, "planDecisionWrite", [
    /decisionDocketColumns\(/u,
  ]);
  requireProducer("src/scripts/backfill-citation-keys.ts", "backfillTable", [
    /key:\s*table\s*===\s*"case_law_decisions"\s*\?\s*decisionCitationKeyOf\(/u,
    /:\s*citationKeyOf\(row\["text"\]\)/u,
  ]);
  requireProducer(
    "src/scripts/apply-reviewed-citation-labels-plan.ts",
    "upsertReviewsStatement",
    [
      /const checked = assertCitationStorageField\(\s*"key",\s*label\.citationKey\s*,?\s*\)/u,
      /if \(checked\.isErr\(\)\) \{\s*throw checked\.error/u,
      /\$\{checked\.value\}/u,
    ],
  );
  for (const [file, name] of [
    [`${pipeline}decision-row.ts`, "insertedRowValues"],
    [`${pipeline}decision-row-update.ts`, "describeRowUpdateTx"],
  ] as const) {
    const body = producerText(input.get(file) ?? "", name);
    if (/\bcitationKey\s*:/u.test(body)) {
      problems.push(`${file}:${name}:unchecked-key-override`);
    }
  }
  requireProducer(
    "src/handlers/case-law/ingestion/decision-identifier-backfill.ts",
    "projectCitationPage",
    [
      /const checked = assertCitationStorageField\(\s*"normalizedIdentifier",\s*normalizedValue\s*,?\s*\)/u,
      /if \(checked\.isErr\(\)\) \{\s*abortTransaction\(checked\.error\)/u,
      /\$\{checked\.value\}/u,
    ],
  );
  return problems;
};

test("registered writers keep the checked values in their production path", () => {
  expect(producerProblems(sources)).toEqual([]);
  expect(boundedPayloadProblems(writers)).toEqual([]);
  for (const writer of writers) {
    const declaration = declarations[writer.id];
    if (!declaration) {
      continue;
    }
    expect(declaration.reason.length).toBeGreaterThan(0);
    if (declaration.disposition === "null") {
      expect(writer.payload).toMatch(
        /citationKey:\s*null|citation_key\s*=\s*NULL/u,
      );
    }
    if (
      declaration.disposition === "copy" &&
      !writer.id.includes("seed-migration-rehearsal")
    ) {
      expect(writer.payload).not.toMatch(
        /\b(?:citationKey|citationText|citedCourtHint|normalizedIdentifierValue)\s*:/u,
      );
    }
  }
});

test("a producer bypass cannot hide behind a registered writer", () => {
  const rowFile = "src/handlers/case-law/ingestion/pipeline/decision-row.ts";
  const changedSink = (sources.get(rowFile) ?? "").replace(
    ".set(set)",
    ".set({citationKey: supplied})",
  );
  expect(boundedPayloadProblems(discoverWriters(rowFile, changedSink))).toEqual(
    [`${rowFile}:writeDecisionRow:orm-set-caseLawDecisions:1`],
  );
  const file = "src/handlers/case-law/ingestion/pipeline/citations.ts";
  const source = sources.get(file);
  expect(source).toBeDefined();
  if (source === undefined) {
    throw new Error("Citation producer fixture missing");
  }
  for (const [field, input] of [
    ["text", "reference.printed"],
    ["key", "reference.citationKey"],
    ["courtHint", "reference.hints.court"],
    ["normalizedIdentifier", "identifier.normalizedValue"],
  ] as const) {
    const escapedInput = input.replaceAll(".", "\\.");
    const checked = new RegExp(
      `assertCitationStorageField\\(\\s*"${field}",\\s*${escapedInput}\\s*,?\\s*\\)`,
      "u",
    );
    expect(source).toMatch(checked);
    const changed = new Map(sources);
    changed.set(
      file,
      source.replace(checked, () => input),
    );
    expect(producerProblems(changed).length).toBeGreaterThan(0);
  }
  const extractor = "src/handlers/case-law/ingestion/citation-extractor.ts";
  const changed = new Map(sources);
  changed.set(
    extractor,
    (sources.get(extractor) ?? "").replace(
      "boundedCitationKey(bareCitationKey(text))",
      "bareCitationKey(text)",
    ),
  );
  expect(producerProblems(changed).length).toBeGreaterThan(0);
});
