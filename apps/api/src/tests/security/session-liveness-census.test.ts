import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

const apiRoot = path.resolve(import.meta.dir, "../../..");
const OWNER = "src/lib/auth/session-liveness.ts";
const STORE = "src/lib/auth/session-lifetime-store.ts";

const propertyRoot = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (ts.isPropertyAccessExpression(current)) {
    current = current.expression;
  }
  return current;
};

const importedSessionNames = (source: ts.SourceFile) => {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      (!statement.moduleSpecifier.text.endsWith("/db/auth-schema") &&
        !(
          source.fileName.startsWith("src/db/") &&
          statement.moduleSpecifier.text === "./auth-schema"
        ))
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === "session") {
        names.add(element.name.text);
      }
    }
  }
  if (source.fileName === STORE) {
    // The store's RAW query callback is typed as the session table.
    names.add("table");
  }
  return names;
};

const importedSqlNames = (source: ts.SourceFile) => {
  const names = new Set(["sql"]);
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "drizzle-orm"
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === "sql") {
        names.add(element.name.text);
      }
    }
  }
  return names;
};

const importedComparisonNames = (source: ts.SourceFile) => {
  const names = new Set(["gt", "gte", "lt", "lte"]);
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "drizzle-orm"
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      if (
        ["gt", "gte", "lt", "lte"].includes(
          element.propertyName?.text ?? element.name.text,
        )
      ) {
        names.add(element.name.text);
      }
    }
  }
  return names;
};

const isSessionExpiry = (node: ts.Node, names: ReadonlySet<string>) => {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "expiresAt") {
    return false;
  }
  const root = propertyRoot(node);
  return ts.isIdentifier(root) && names.has(root.text);
};

const adapterExpiryConditions = (node: ts.ObjectLiteralExpression) => {
  const model = node.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      property.name.getText() === "model" &&
      ts.isStringLiteral(property.initializer) &&
      property.initializer.text === "session",
  );
  if (!model) {
    return [];
  }
  const where = node.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) && property.name.getText() === "where",
  );
  if (
    !where ||
    !ts.isPropertyAssignment(where) ||
    !ts.isArrayLiteralExpression(where.initializer)
  ) {
    return [];
  }
  return where.initializer.elements.filter(
    (condition): condition is ts.ObjectLiteralExpression =>
      ts.isObjectLiteralExpression(condition) &&
      condition.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText() === "field" &&
          ts.isStringLiteral(property.initializer) &&
          property.initializer.text === "expiresAt",
      ) &&
      condition.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText() === "operator" &&
          ts.isStringLiteral(property.initializer) &&
          ["gt", "gte", "lt", "lte"].includes(property.initializer.text),
      ),
  );
};

const relationalSessionExpiryConditions = (node: ts.CallExpression) => {
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    !["findFirst", "findMany"].includes(node.expression.name.text)
  ) {
    return false;
  }
  const query = node.expression.expression;
  if (
    !ts.isPropertyAccessExpression(query) ||
    query.name.text !== "session" ||
    !ts.isPropertyAccessExpression(query.expression) ||
    query.expression.name.text !== "query"
  ) {
    return false;
  }
  let found = false;
  const inspect = (child: ts.Node) => {
    if (
      ts.isPropertyAssignment(child) &&
      child.name.getText() === "expiresAt" &&
      ts.isObjectLiteralExpression(child.initializer) &&
      child.initializer.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ["gt", "gte", "lt", "lte"].includes(property.name.getText()),
      )
    ) {
      found = true;
    }
    ts.forEachChild(child, inspect);
  };
  for (const argument of node.arguments) {
    inspect(argument);
  }
  return found;
};

const sessionLivenessViolations = (file: string, text: string) => {
  if (file === OWNER) {
    return [];
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sessionNames = importedSessionNames(source);
  const sqlNames = importedSqlNames(source);
  const comparisonNames = importedComparisonNames(source);
  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      violations.push(
        ...adapterExpiryConditions(node).map(
          () => "session adapter expiry condition",
        ),
      );
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (
        comparisonNames.has(name) &&
        node.arguments.some((argument) => {
          let matched = false;
          const inspect = (child: ts.Node) => {
            matched ||= isSessionExpiry(child, sessionNames);
            ts.forEachChild(child, inspect);
          };
          inspect(argument);
          return matched;
        })
      ) {
        violations.push(`session.${name}(expiresAt, ...)`);
      }
    }
    if (ts.isCallExpression(node) && relationalSessionExpiryConditions(node)) {
      violations.push("session relational expiry condition");
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      (ts.isNoSubstitutionTemplateLiteral(node.template) ||
        ts.isTemplateExpression(node.template))
    ) {
      const literalSql = ts.isNoSubstitutionTemplateLiteral(node.template)
        ? node.template.text
        : [
            node.template.head.text,
            ...node.template.templateSpans.map((span) => span.literal.text),
          ].join(" ");
      if (
        /\b(?:session|auth_session)\b[\s\S]*?\bexpires_at\b\s*(?:>=|>|<=|<)/iu.test(
          literalSql,
        )
      ) {
        violations.push("raw SQL session expiry comparison");
      }
      if (
        ts.isIdentifier(node.tag) &&
        sqlNames.has(node.tag.text) &&
        ts.isTemplateExpression(node.template)
      ) {
        for (const [index, span] of node.template.templateSpans.entries()) {
          const previousLiteral =
            index === 0
              ? node.template.head.text
              : (node.template.templateSpans[index - 1]?.literal.text ?? "");
          const comparisonOnLeft = /(?:>=|>|<=|<)\s*$/u.test(previousLiteral);
          const comparisonOnRight = /^\s*(?:>=|>|<=|<)/u.test(
            span.literal.text,
          );
          if (
            isSessionExpiry(span.expression, sessionNames) &&
            (comparisonOnLeft || comparisonOnRight) &&
            !(
              file === STORE &&
              comparisonOnRight &&
              ((span.literal.text.includes("<=") &&
                node.getText(source).includes("expiresIn - updateAge")) ||
                (span.literal.text.includes("<") &&
                  node.getText(source).includes("SESSION_ABSOLUTE_AGE_MS")))
            )
          ) {
            violations.push("SQL session expiry comparison");
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(violations)];
};

const productionSources = () =>
  [...new Glob("src/**/*.{ts,tsx}").scanSync({ cwd: apiRoot })]
    .filter(
      (file) =>
        !file.includes("/tests/") &&
        !file.endsWith(".test.ts") &&
        !file.endsWith(".test.tsx"),
    )
    .map((file) => ({
      file,
      text: readFileSync(path.join(apiRoot, file), "utf-8"),
    }));

const interpolatedSessionSql = (operator: string, value: string) =>
  [
    'import { session } from "@/api/db/auth-schema"; sql`',
    "$",
    "{session.expiresAt}",
    ` ${operator} `,
    "$",
    `{${value}}`,
    "`;",
  ].join("");

describe("session liveness owner", () => {
  test(
    "production SQL and adapter liveness checks use the owner",
    () => {
      const violations = productionSources().flatMap(({ file, text }) =>
        sessionLivenessViolations(file, text).map(
          (violation) => `${file}: ${violation}`,
        ),
      );
      expect(violations).toEqual([]);
    },
    { timeout: 30_000 },
  );

  test.each([
    {
      name: "aliased Drizzle comparison",
      source:
        'import { session as authSession } from "@/api/db/auth-schema"; gt(authSession.expiresAt, now);',
      file: "src/lib/other.ts",
    },
    {
      name: "interpolated raw SQL comparison",
      source: interpolatedSessionSql(">=", "now"),
      file: "src/lib/other.ts",
    },
    {
      name: "literal raw SQL comparison",
      source:
        'import postgres from "postgres"; const client = postgres(); client`SELECT id FROM session WHERE expires_at > now()`;',
      file: "src/lib/other.ts",
    },
    {
      name: "no-substitution SQL comparison",
      source:
        'import { sql } from "drizzle-orm"; sql`SELECT id FROM session WHERE expires_at > now()`;',
      file: "src/lib/other.ts",
    },
    {
      name: "adapter expiry condition",
      source:
        'adapter.findOne({ model: "session", where: [{ field: "expiresAt", operator: "gt", value: now }] });',
      file: "src/lib/other.ts",
    },
    {
      name: "relational expiry condition",
      source:
        "db.query.session.findFirst({ where: { expiresAt: { gt: now } } });",
      file: "src/lib/other.ts",
    },
  ])("detects $name", ({ source, file }) => {
    expect(sessionLivenessViolations(file, source)).not.toEqual([]);
  });

  test("ignores projections, verification checks, and refresh expiry bounds", () => {
    expect(
      sessionLivenessViolations(
        "src/lib/other.ts",
        'import { session } from "@/api/db/auth-schema"; db.select({ expiresAt: session.expiresAt }); if (row.expiresAt <= now) return null;',
      ),
    ).toEqual([]);
    expect(
      sessionLivenessViolations(
        STORE,
        interpolatedSessionSql(
          "<=",
          "new Date(now.getTime() + (expiresIn - updateAge) * 1000)",
        ),
      ),
    ).toEqual([]);
  });
});
