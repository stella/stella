import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

import type { OperatorActivitySummary } from "@/api/lib/db/operator-activity/read";

const apiRoot = path.resolve(import.meta.dirname, "../../..");
const OPERATOR_ACTIVITY_READER = "src/lib/db/operator-activity/read.ts";
const OWNER_HELPERS = new Set([
  "activityFeatureOwnerVisibilitySql",
  "flowAuditVisibilityCondition",
  "flowNotificationVisibilityCondition",
  "visibleActivityCondition",
  "toAuditLogConditions",
]);
const TABLES = ["auditLogs", "notifications"] as const;
type OwnedTable = (typeof TABLES)[number];

type TenantReaderCategory = {
  type: "tenant-reader";
  file: string;
  table: OwnedTable;
};
type OperatorAggregateReaderCategory = {
  type: "operator-aggregate";
  file: typeof OPERATOR_ACTIVITY_READER;
  reason: string;
};
type ReaderCategory = TenantReaderCategory | OperatorAggregateReaderCategory;

const OPERATOR_AGGREGATE_CATEGORY = {
  type: "operator-aggregate",
  file: OPERATOR_ACTIVITY_READER,
  reason:
    "Deployment-wide operator counts of active firms, activation, and retention use the owner connection; results are never shown to tenants and contain no row content.",
} as const satisfies ReaderCategory;

type OperatorActivitySummaryContract = {
  generated_at: string;
  timezone: OperatorActivitySummary["timezone"];
  weeks: {
    week_start: string;
    partial: boolean;
    active_orgs: number;
    signups: number;
    activated_24h_pct: number | null;
    weekly_retention_pct: number | null;
  }[];
  same_point_last_week: {
    active_orgs: number;
    signups: number;
  };
  unavailable_reasons: Record<string, string>;
};

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <
        Value,
      >() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type OperatorActivitySummaryIsAggregateOnly = Assert<
  Equal<OperatorActivitySummary, OperatorActivitySummaryContract>
>;
const OPERATOR_SUMMARY_CONTRACT_MATCHES =
  true satisfies OperatorActivitySummaryIsAggregateOnly;

const OPERATOR_AGGREGATE_PROJECTION = [
  "week_index",
  "active_orgs",
  "signups",
  "activated_24h_pct",
  "weekly_retention_pct",
] as const;

type Reader = { table: OwnedTable; kind: string; line: number };
type SourceScan = { readers: Reader[]; ownerHelperCalls: Set<string> };

const propertyPath = (node: ts.Expression): string[] => {
  if (ts.isIdentifier(node)) {
    return [node.text];
  }
  if (ts.isPropertyAccessExpression(node)) {
    return [...propertyPath(node.expression), node.name.text];
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const argument = node.argumentExpression;
    if (ts.isStringLiteral(argument)) {
      return [...propertyPath(node.expression), argument.text];
    }
  }
  return [];
};

const scanSource = (filename: string, source: string): SourceScan => {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const tableLocals = new Map<OwnedTable, Set<string>>(
    TABLES.map((table) => [table, new Set([table])]),
  );
  const helperLocals = new Map<string, string>();

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const moduleName = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : "";
    if (!moduleName.includes("/db/schema")) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const specifier of bindings.elements) {
      const exported = specifier.propertyName?.text ?? specifier.name.text;
      for (const table of TABLES) {
        if (exported === table) {
          tableLocals.get(table)?.add(specifier.name.text);
        }
      }
    }
  }

  const readers: Reader[] = [];
  const ownerHelperCalls = new Set<string>();
  const addReader = (table: OwnedTable, kind: string, node: ts.Node) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    readers.push({ table, kind, line: line + 1 });
  };
  const isTable = (expression: ts.Expression, table: OwnedTable) =>
    ts.isIdentifier(expression) && tableLocals.get(table)?.has(expression.text);
  const tableFor = (expression: ts.Expression): OwnedTable | undefined =>
    TABLES.find((table) => isTable(expression, table));

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const moduleName = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : "";
      const bindings = node.importClause?.namedBindings;
      if (
        moduleName.includes("/flows/visibility") &&
        bindings &&
        ts.isNamedImports(bindings)
      ) {
        for (const specifier of bindings.elements) {
          const imported = specifier.propertyName?.text ?? specifier.name.text;
          if (OWNER_HELPERS.has(imported)) {
            helperLocals.set(specifier.name.text, imported);
          }
        }
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const expressionPath = propertyPath(node.initializer.expression);
      const table = node.initializer.arguments
        .map(tableFor)
        .find((candidate) => candidate !== undefined);
      if (
        expressionPath.at(-1) === "alias" &&
        table &&
        ts.isIdentifier(node.name)
      ) {
        tableLocals.get(table)?.add(node.name.text);
      }
    }

    if (ts.isCallExpression(node)) {
      const calleePath = propertyPath(node.expression);
      const method = calleePath.at(-1);
      const localHelper = ts.isIdentifier(node.expression)
        ? (helperLocals.get(node.expression.text) ?? node.expression.text)
        : undefined;
      if (localHelper && OWNER_HELPERS.has(localHelper)) {
        ownerHelperCalls.add(localHelper);
      }

      if (
        method === "from" ||
        method === "update" ||
        method === "delete" ||
        method === "innerJoin" ||
        method === "leftJoin" ||
        method === "rightJoin" ||
        method === "fullJoin" ||
        method === "$count"
      ) {
        const table = node.arguments
          .map(tableFor)
          .find((candidate) => candidate !== undefined);
        if (table) {
          addReader(table, method, node);
        }
      }

      if (
        [
          "findMany",
          "findFirst",
          "findFirstOrThrow",
          "findManyWithCache",
        ].includes(method ?? "")
      ) {
        const queryIndex = calleePath.lastIndexOf("query");
        const relation =
          queryIndex !== -1 ? calleePath.at(queryIndex + 1) : undefined;
        const table = TABLES.find((candidate) => candidate === relation);
        if (table) {
          addReader(table, `query.${method}`, node);
        }
      }
    }

    if (ts.isTemplateExpression(node)) {
      for (const [index, span] of node.templateSpans.entries()) {
        if (!ts.isIdentifier(span.expression)) {
          continue;
        }
        const table = TABLES.find((candidate) =>
          tableLocals.get(candidate)?.has(span.expression.getText(file)),
        );
        if (!table) {
          continue;
        }
        const precedingText =
          index === 0
            ? node.head.text
            : node.templateSpans[index - 1]?.literal.text;
        if (precedingText && /\b(?:from|join)\s*$/iu.test(precedingText)) {
          addReader(table, "sql-template", node);
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(file);
  return { readers, ownerHelperCalls };
};

const OPERATOR_SUMMARY_KEYS = [
  "generated_at",
  "timezone",
  "weeks",
  "same_point_last_week",
  "unavailable_reasons",
] as const;

const operatorAggregateContractViolations = (source: string) => {
  const file = ts.createSourceFile(
    OPERATOR_ACTIVITY_READER,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = file.statements
    .flatMap((statement) =>
      ts.isVariableStatement(statement)
        ? [...statement.declarationList.declarations]
        : [],
    )
    .find(
      (statement) =>
        ts.isIdentifier(statement.name) &&
        statement.name.text === "readAuditedActivitySummary",
    );
  const implementation = declaration?.initializer;
  if (
    !implementation ||
    !ts.isArrowFunction(implementation) ||
    !ts.isBlock(implementation.body)
  ) {
    return ["readAuditedActivitySummary implementation is missing"];
  }

  const violations: string[] = [];
  const projections: ts.ObjectLiteralExpression[] = [];
  const returnedSummaryKeys: string[][] = [];
  const inspectReturnedExpression = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "rows") {
      violations.push("query rows cannot be returned directly or nested");
    }
    if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) {
      violations.push(
        "returned values cannot spread query rows or row objects",
      );
    }
    ts.forEachChild(node, inspectReturnedExpression);
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const calleePath = propertyPath(node.expression);
      const projection = node.arguments.at(0);
      if (
        calleePath.length === 2 &&
        calleePath[0] === "tx" &&
        calleePath[1] === "select" &&
        projection &&
        ts.isObjectLiteralExpression(projection)
      ) {
        projections.push(projection);
      }
    }
    if (ts.isReturnStatement(node) && node.expression) {
      inspectReturnedExpression(node.expression);
      if (ts.isObjectLiteralExpression(node.expression)) {
        returnedSummaryKeys.push(
          node.expression.properties.flatMap((property) => {
            if (ts.isShorthandPropertyAssignment(property)) {
              return [property.name.text];
            }
            if (!ts.isPropertyAssignment(property)) {
              return [];
            }
            return [
              ts.isIdentifier(property.name) ||
              ts.isStringLiteral(property.name)
                ? property.name.text
                : property.name.getText(file),
            ];
          }),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(implementation.body);

  if (projections.length !== 1) {
    violations.push(
      "operator query must have one explicit aggregate projection",
    );
  }
  for (const projection of projections) {
    const fields = projection.properties.flatMap((property) => {
      if (!ts.isPropertyAssignment(property)) {
        violations.push("operator projection fields must be explicit");
        return [];
      }
      const name =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : property.name.getText(file);
      const initializer = property.initializer;
      if (!ts.isTaggedTemplateExpression(initializer)) {
        violations.push(`${name} must be a numeric SQL aggregate projection`);
        return [name];
      }
      const genericType = initializer.typeArguments
        ?.at(0)
        ?.getText(file)
        .replaceAll(/\s/gu, "");
      if (
        initializer.tag.getText(file) !== "sql" ||
        (genericType !== "number" && genericType !== "number|null")
      ) {
        violations.push(`${name} must be typed as a numeric SQL aggregate`);
      }
      return [name];
    });
    if (
      fields.toSorted().join(",") !==
      [...OPERATOR_AGGREGATE_PROJECTION].toSorted().join(",")
    ) {
      violations.push(
        "operator projection fields must remain the closed aggregate set",
      );
    }
  }

  const hasClosedSummaryReturn = returnedSummaryKeys.some(
    (keys) =>
      keys.toSorted().join(",") ===
      [...OPERATOR_SUMMARY_KEYS].toSorted().join(","),
  );
  if (!hasClosedSummaryReturn) {
    violations.push(
      "operator return must expose only the closed aggregate summary",
    );
  }
  return violations;
};

const categoryForReader = (file: string, table: OwnedTable): ReaderCategory =>
  file === OPERATOR_AGGREGATE_CATEGORY.file
    ? OPERATOR_AGGREGATE_CATEGORY
    : { type: "tenant-reader", file, table };

const productionSources = () =>
  [...new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: apiRoot })]
    .filter(
      (name) =>
        !name.includes("/tests/") &&
        !name.endsWith(".test.ts") &&
        !name.endsWith(".test.tsx"),
    )
    .map((name) => {
      const source = readFileSync(path.join(apiRoot, name), "utf-8");
      return { name, source, ...scanSource(name, source) };
    });

const hasIndirectNotificationVisibility = (name: string, source: string) =>
  name === "src/handlers/notifications/read-model.ts" &&
  source.includes("visibility: SQL") &&
  source.includes("visibility,");

describe("feature-owned retained activity readers", () => {
  test("every production audit and notification reader applies owner admission", () => {
    expect(OPERATOR_SUMMARY_CONTRACT_MATCHES).toBe(true);
    const sources = productionSources();
    const auditReaders = sources.filter(({ readers }) =>
      readers.some(({ table }) => table === "auditLogs"),
    );
    const notificationReaders = sources.filter(({ readers }) =>
      readers.some(({ table }) => table === "notifications"),
    );
    const operatorSource = sources.find(
      ({ name }) => name === OPERATOR_AGGREGATE_CATEGORY.file,
    );

    expect(auditReaders.map(({ name }) => name).toSorted()).toEqual(
      expect.arrayContaining([
        "src/handlers/audit-logs/export.ts",
        "src/handlers/audit-logs/query.ts",
        "src/handlers/lists/items/activity/list.ts",
        "src/handlers/time-entries/suggestions/load.ts",
        "src/handlers/workspaces/read-overview-activity-actors.query.ts",
        "src/handlers/workspaces/read-overview-activity.query.ts",
      ]),
    );
    expect(notificationReaders.map(({ name }) => name).toSorted()).toEqual(
      expect.arrayContaining([
        "src/handlers/notifications/list.ts",
        "src/handlers/notifications/read-all.ts",
        "src/handlers/notifications/read-model.ts",
        "src/handlers/notifications/read-state/update.ts",
        "src/lib/notifications.ts",
      ]),
    );
    expect(operatorSource?.readers).toEqual([
      expect.objectContaining({ table: "auditLogs", kind: "sql-template" }),
    ]);
    expect(
      operatorAggregateContractViolations(operatorSource?.source ?? ""),
    ).toEqual([]);

    for (const { name, source, readers, ownerHelperCalls } of sources) {
      for (const { table } of readers) {
        const category = categoryForReader(name, table);
        if (category.type === "operator-aggregate") {
          expect(category.reason.trim()).not.toBe("");
          continue;
        }
        const auditIsCovered =
          category.table !== "auditLogs" ||
          ownerHelperCalls.has("flowAuditVisibilityCondition") ||
          ownerHelperCalls.has("visibleActivityCondition") ||
          ownerHelperCalls.has("toAuditLogConditions");
        const notificationIsCovered =
          category.table !== "notifications" ||
          ownerHelperCalls.has("flowNotificationVisibilityCondition") ||
          ownerHelperCalls.has("activityFeatureOwnerVisibilitySql") ||
          hasIndirectNotificationVisibility(name, source);
        expect(
          auditIsCovered && notificationIsCovered,
          `${name} has a tenant read without a call to its centralized owner predicate`,
        ).toBe(true);
      }
    }
  });

  test("operator summaries retain aggregate projections and structured results", () => {
    const source = readFileSync(
      path.join(apiRoot, OPERATOR_ACTIVITY_READER),
      "utf-8",
    );
    expect(operatorAggregateContractViolations(source)).toEqual([]);
    const rowProjection = source.replace(
      "week_index: sql<number>",
      "resource_id: auditLogs.resourceId, week_index: sql<number>",
    );
    expect(rowProjection).not.toBe(source);
    expect(operatorAggregateContractViolations(rowProjection)).toContain(
      "resource_id must be a numeric SQL aggregate projection",
    );
    const rowReturn = source.replace(
      "generated_at: windows.generatedAt,",
      "generated_at: windows.generatedAt, rows,",
    );
    expect(rowReturn).not.toBe(source);
    expect(operatorAggregateContractViolations(rowReturn)).toContain(
      "query rows cannot be returned directly or nested",
    );
  });

  test("finds aliased table calls and does not treat imported helpers as calls", () => {
    const auditFixture = scanSource(
      "aliased-reader.ts",
      `import { auditLogs as logs } from "@/api/db/schema";\n` +
        `import { flowAuditVisibilityCondition } from "@/api/lib/flows/visibility";\n` +
        `const rows = await db.select().from(logs);`,
    );
    const notificationFixture = scanSource(
      "relational-reader.ts",
      `import { notifications as inbox } from "@/api/db/schema";\n` +
        `import { activityFeatureOwnerVisibilitySql as ownerGate } from "@/api/lib/flows/visibility";\n` +
        `const rows = await tx.query.notifications.findMany();`,
    );

    expect(auditFixture.readers).toHaveLength(1);
    expect(auditFixture.readers[0]?.table).toBe("auditLogs");
    expect(auditFixture.ownerHelperCalls.size).toBe(0);
    expect(notificationFixture.readers).toHaveLength(1);
    expect(notificationFixture.readers[0]?.kind).toBe("query.findMany");
    expect(notificationFixture.ownerHelperCalls.size).toBe(0);
  });
});
