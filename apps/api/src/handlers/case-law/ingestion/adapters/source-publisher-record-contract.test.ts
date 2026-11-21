import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

const fieldMapName =
  /(?:SOURCE_FIELDS|SOURCE_FIELD_DISPOSITIONS|AT_RIS_(?:COMMON|BRANCH|DOCUMENT)_FIELDS|(?:CLUSTER|DOCKET|COURT|OPINION|CITATION|PERSON)_FIELDS)$/u;

const contractIssues = (source: string) => {
  const file = ts.createSourceFile(
    "adapter.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const issues: string[] = [];
  const maps = new Set<string>();
  const aliases = new Map<string, ts.TypeAliasDeclaration>();
  const publisherTypes: ts.TypeAliasDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTypeAliasDeclaration(node)) {
      aliases.set(node.name.text, node);
      if (node.name.text.endsWith("PublisherRecord")) {
        publisherTypes.push(node);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const name = node.name.text;
      let expression = node.initializer;
      const constraint = ts.isSatisfiesExpression(expression)
        ? expression.type
        : undefined;
      while (
        ts.isAsExpression(expression) ||
        ts.isSatisfiesExpression(expression) ||
        ts.isParenthesizedExpression(expression)
      ) {
        expression = expression.expression;
      }
      if (fieldMapName.test(name) && ts.isObjectLiteralExpression(expression)) {
        maps.add(name);
        if (
          !constraint ||
          !ts.isTypeReferenceNode(constraint) ||
          constraint.typeName.getText(file) !== "Record" ||
          constraint.typeArguments?.length !== 2
        ) {
          issues.push(
            `${name}: requires satisfies Record over its publisher record`,
          );
        } else {
          const keys = constraint.typeArguments.at(0);
          if (
            !keys ||
            (!(
              ts.isTypeOperatorNode(keys) &&
              keys.operator === ts.SyntaxKind.KeyOfKeyword
            ) &&
              !(
                ts.isTypeReferenceNode(keys) &&
                keys.typeName.getText(file) === "SourceRecordPaths"
              ))
          ) {
            issues.push(
              `${name}: mapping keys must derive from the publisher record`,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const declaration of publisherTypes) {
    const visited = new Set<string>();
    const check = (node: ts.Node) => {
      if (ts.isTypeQueryNode(node) && maps.has(node.exprName.getText(file))) {
        issues.push(
          `${declaration.name.text}: publisher schema cannot derive from its disposition map`,
        );
      }
      if (ts.isTypeReferenceNode(node)) {
        const name = node.typeName.getText(file);
        const alias = aliases.get(name);
        if (alias && !visited.has(name)) {
          visited.add(name);
          check(alias.type);
        }
      }
      ts.forEachChild(node, check);
    };
    check(declaration.type);
  }
  return issues;
};

test("publisher inventories cannot widen their exhaustive mappings or derive schemas from maps", () => {
  const files = readdirSync(import.meta.dirname, {
    recursive: true,
    encoding: "utf-8",
  });
  const issues = files
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .flatMap((file) =>
      contractIssues(
        readFileSync(path.join(import.meta.dirname, file), "utf-8"),
      ).map((issue) => `${file}: ${issue}`),
    );
  expect(issues).toEqual([]);
});

test("removing, widening, or making a mapping circular fails the publisher contract guard", () => {
  const mapped = `type TestPublisherRecord = { id: unknown };
const TEST_SOURCE_FIELDS = {
  id: { disposition: "stored", target: { type: "identity" } },
} as const satisfies Record<keyof TestPublisherRecord, SourceFieldDisposition>;`;
  expect(contractIssues(mapped)).toEqual([]);
  expect(
    contractIssues(
      mapped.replace(
        " satisfies Record<keyof TestPublisherRecord, SourceFieldDisposition>",
        "",
      ),
    ),
  ).toEqual([
    "TEST_SOURCE_FIELDS: requires satisfies Record over its publisher record",
  ]);
  expect(
    contractIssues(mapped.replace("keyof TestPublisherRecord", "string")),
  ).toEqual([
    "TEST_SOURCE_FIELDS: mapping keys must derive from the publisher record",
  ]);
  expect(
    contractIssues(
      mapped.replace(
        "{ id: unknown }",
        "Record<keyof typeof TEST_SOURCE_FIELDS, unknown>",
      ),
    ),
  ).toEqual([
    "TestPublisherRecord: publisher schema cannot derive from its disposition map",
  ]);
  expect(
    contractIssues(
      `type Field = keyof typeof TEST_SOURCE_FIELDS;\n${mapped.replace("{ id: unknown }", "Record<Field, unknown>")}`,
    ),
  ).toEqual([
    "TestPublisherRecord: publisher schema cannot derive from its disposition map",
  ]);
});
