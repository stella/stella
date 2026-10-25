import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { type Node, parseSource, walk } from "./syntax-tree";

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
  "src/scripts/corpus-column-trim.ts:trimColumnRow:orm-set-caseLawDecisions:1":
    {
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

const propertyName = (node: Node) => {
  if (node.type === "Identifier") {
    return node.name;
  }
  return node.type === "Literal" && typeof node.value === "string"
    ? node.value
    : null;
};

const ownerOf = (ancestors: readonly Node[]): string => {
  for (const parent of ancestors.toReversed()) {
    if (parent.type === "FunctionDeclaration" && parent.id) {
      return parent.id.name;
    }
    if (
      parent.type === "VariableDeclarator" &&
      parent.id.type === "Identifier" &&
      (parent.init?.type === "ArrowFunctionExpression" ||
        parent.init?.type === "FunctionExpression")
    ) {
      return parent.id.name;
    }
    if (
      parent.type === "Property" &&
      (parent.value.type === "ArrowFunctionExpression" ||
        parent.value.type === "FunctionExpression")
    ) {
      return propertyName(parent.key) ?? "computed-producer";
    }
  }
  return "module";
};

const writtenFields = (node: Node): string[] | null => {
  if (node.type !== "ObjectExpression") {
    return null;
  }
  if (
    node.properties.some(
      (property) =>
        property.type === "SpreadElement" ||
        (property.computed && propertyName(property.key) === null),
    )
  ) {
    return null;
  }
  return node.properties.flatMap((property) => {
    if (property.type !== "Property" || property.method) {
      return [];
    }
    const name = propertyName(property.key);
    return name && fields.has(name) ? [name] : [];
  });
};

const discoverWriters = (file: string, text: string): Writer[] => {
  const source = parseSource(file, text);
  const aliases = new Map([...tables].map((name) => [name, name]));
  for (const statement of source.program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    for (const binding of statement.specifiers) {
      if (binding.type !== "ImportSpecifier") {
        continue;
      }
      const imported = propertyName(binding.imported);
      if (imported && tables.has(imported)) {
        aliases.set(binding.local.name, imported);
      }
    }
  }
  const tableOf = (expression: Node): string | null => {
    if (
      expression.type !== "CallExpression" ||
      expression.callee.type !== "MemberExpression" ||
      expression.callee.computed ||
      expression.callee.property.type !== "Identifier"
    ) {
      return null;
    }
    const member = expression.callee;
    if (
      member.property.name === "insert" ||
      member.property.name === "update"
    ) {
      const target = expression.arguments.at(0);
      if (target?.type === "Identifier") {
        return aliases.get(target.name) ?? null;
      }
      if (
        target?.type === "MemberExpression" &&
        !target.computed &&
        target.property.type === "Identifier" &&
        tables.has(target.property.name)
      ) {
        return target.property.name;
      }
      return null;
    }
    return tableOf(member.object);
  };
  const found: Writer[] = [];
  const counts = new Map<string, number>();
  walk(source.program, (node, ancestors) => {
    const add = (kind: string, payload: string) => {
      const base = `${file}:${ownerOf([...ancestors, node])}:${kind}`;
      const count = (counts.get(base) ?? 0) + 1;
      counts.set(base, count);
      found.push({
        id: `${base}:${count}`,
        file,
        payload,
        expression: text.slice(node.start, node.end),
      });
    };
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.property.type === "Identifier"
    ) {
      const member = node.callee;
      const name = member.property.name;
      const table = tableOf(member.object);
      let payload = node.arguments.at(0);
      if (
        table &&
        ["values", "set", "onConflictDoUpdate"].includes(name) &&
        payload
      ) {
        if (
          name === "onConflictDoUpdate" &&
          payload.type === "ObjectExpression"
        ) {
          payload = payload.properties
            .flatMap((property) =>
              property.type === "Property" &&
              !property.method &&
              !property.shorthand &&
              propertyName(property.key) === "set"
                ? [property.value]
                : [],
            )
            .at(0);
        }
        if (payload) {
          const written = writtenFields(payload);
          if (name === "values" || written === null || written.length > 0) {
            add(`orm-${name}-${table}`, text.slice(payload.start, payload.end));
          }
        }
      }
    }
    let sqlText: string | undefined;
    if (node.type === "Literal" && typeof node.value === "string") {
      sqlText = node.value;
    }
    if (node.type === "TemplateLiteral") {
      sqlText = node.quasis
        .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
        .join(" EXPR ");
    }
    if (sqlText !== undefined && sqlWrite.test(sqlText)) {
      add("sql", sqlText);
    }
    sqlWrite.lastIndex = 0;
  });
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
  const file = parseSource("producer.ts", source);
  let result = "";
  walk(file.program, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === name &&
      node.init
    ) {
      result = source.slice(node.init.start, node.init.end);
    }
  });
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
