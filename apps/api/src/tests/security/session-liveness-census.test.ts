import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  type CallExpression,
  type ImportDeclaration,
  type Node,
  type ObjectExpression,
  type ObjectProperty,
  parseSource,
  type Program,
  type TemplateElement,
  walk,
} from "@stll/scripts/src/syntax-tree";

const apiRoot = path.resolve(import.meta.dir, "../../..");
const OWNER = "src/lib/auth/session-liveness.ts";
const STORE = "src/lib/auth/session-lifetime-store.ts";

type SourceFile = { fileName: string; program: Program };

const memberName = (node: Node) =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.property.type === "Identifier"
    ? node.property.name
    : undefined;

const propertyRoot = (node: Node): Node => {
  let current = node;
  while (current.type === "MemberExpression" && !current.computed) {
    current = current.object;
  }
  return current;
};

/** An `identifier: value` entry; shorthand, method and computed entries are not. */
const namedProperty = (node: Node, name: string): node is ObjectProperty =>
  node.type === "Property" &&
  node.kind === "init" &&
  !node.method &&
  !node.shorthand &&
  !node.computed &&
  node.key.type === "Identifier" &&
  node.key.name === name;

const stringLiteralValue = (node: Node | null | undefined) =>
  node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;

const importStatements = (source: SourceFile) =>
  source.program.body.filter(
    (statement): statement is ImportDeclaration =>
      statement.type === "ImportDeclaration",
  );

/** Local names bound by `import { imported as local }` for one of `imported`. */
const namedImportLocals = (
  statement: ImportDeclaration,
  imported: readonly string[],
) =>
  statement.specifiers.flatMap((specifier) => {
    if (specifier.type !== "ImportSpecifier") {
      return [];
    }
    const name =
      specifier.imported.type === "Identifier"
        ? specifier.imported.name
        : specifier.imported.value;
    return imported.includes(name) ? [specifier.local.name] : [];
  });

const importedSessionNames = (source: SourceFile) => {
  const names = new Set<string>();
  for (const statement of importStatements(source)) {
    const specifier = statement.source.value;
    if (
      !specifier.endsWith("/db/auth-schema") &&
      !(source.fileName.startsWith("src/db/") && specifier === "./auth-schema")
    ) {
      continue;
    }
    for (const name of namedImportLocals(statement, ["session"])) {
      names.add(name);
    }
  }
  if (source.fileName === STORE) {
    // The store's RAW query callback is typed as the session table.
    names.add("table");
  }
  return names;
};

const importedSqlNames = (source: SourceFile) => {
  const names = new Set(["sql"]);
  for (const statement of importStatements(source)) {
    if (statement.source.value !== "drizzle-orm") {
      continue;
    }
    for (const name of namedImportLocals(statement, ["sql"])) {
      names.add(name);
    }
  }
  return names;
};

const COMPARISONS = ["gt", "gte", "lt", "lte"];

const importedComparisonNames = (source: SourceFile) => {
  const names = new Set(COMPARISONS);
  for (const statement of importStatements(source)) {
    if (statement.source.value !== "drizzle-orm") {
      continue;
    }
    for (const name of namedImportLocals(statement, COMPARISONS)) {
      names.add(name);
    }
  }
  return names;
};

const isSessionExpiry = (node: Node, names: ReadonlySet<string>) => {
  if (memberName(node) !== "expiresAt") {
    return false;
  }
  const root = propertyRoot(node);
  return root.type === "Identifier" && names.has(root.name);
};

const adapterExpiryConditions = (node: ObjectExpression) => {
  const model = node.properties.find(
    (property) =>
      namedProperty(property, "model") &&
      stringLiteralValue(property.value) === "session",
  );
  if (!model) {
    return [];
  }
  const where = node.properties.find((property) =>
    namedProperty(property, "where"),
  );
  if (
    !where ||
    !namedProperty(where, "where") ||
    where.value.type !== "ArrayExpression"
  ) {
    return [];
  }
  return where.value.elements.filter(
    (condition): condition is ObjectExpression =>
      condition?.type === "ObjectExpression" &&
      condition.properties.some(
        (property) =>
          namedProperty(property, "field") &&
          stringLiteralValue(property.value) === "expiresAt",
      ) &&
      condition.properties.some(
        (property) =>
          namedProperty(property, "operator") &&
          COMPARISONS.includes(stringLiteralValue(property.value) ?? ""),
      ),
  );
};

const relationalSessionExpiryConditions = (node: CallExpression) => {
  const method = memberName(node.callee);
  if (
    node.callee.type !== "MemberExpression" ||
    method === undefined ||
    !["findFirst", "findMany"].includes(method)
  ) {
    return false;
  }
  const query = node.callee.object;
  if (
    memberName(query) !== "session" ||
    query.type !== "MemberExpression" ||
    memberName(query.object) !== "query"
  ) {
    return false;
  }
  return node.arguments.some(hasExpiryComparison);
};

/** Whether `root` holds `expiresAt: { gt | gte | lt | lte: ... }`. */
const hasExpiryComparison = (root: Node) => {
  let found = false;
  walk(root, (child) => {
    if (
      namedProperty(child, "expiresAt") &&
      child.value.type === "ObjectExpression" &&
      child.value.properties.some((property) =>
        COMPARISONS.some((name) => namedProperty(property, name)),
      )
    ) {
      found = true;
    }
  });
  return found;
};

const templateText = ({ value }: TemplateElement) => value.cooked ?? value.raw;

const sessionLivenessViolations = (file: string, text: string) => {
  if (file === OWNER) {
    return [];
  }
  const source = { fileName: file, program: parseSource(file, text).program };
  const sessionNames = importedSessionNames(source);
  const sqlNames = importedSqlNames(source);
  const comparisonNames = importedComparisonNames(source);
  const violations: string[] = [];
  walk(source.program, (node) => {
    if (node.type === "ObjectExpression") {
      violations.push(
        ...adapterExpiryConditions(node).map(
          () => "session adapter expiry condition",
        ),
      );
    }
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      const name = node.callee.name;
      if (
        comparisonNames.has(name) &&
        node.arguments.some((argument) => {
          let matched = false;
          walk(argument, (child) => {
            matched ||= isSessionExpiry(child, sessionNames);
          });
          return matched;
        })
      ) {
        violations.push(`session.${name}(expiresAt, ...)`);
      }
    }
    if (
      node.type === "CallExpression" &&
      relationalSessionExpiryConditions(node)
    ) {
      violations.push("session relational expiry condition");
    }
    if (node.type === "TaggedTemplateExpression") {
      const { expressions, quasis } = node.quasi;
      const literalSql = quasis.map(templateText).join(" ");
      if (
        /\b(?:session|auth_session)\b[\s\S]*?\bexpires_at\b\s*(?:>=|>|<=|<)/iu.test(
          literalSql,
        )
      ) {
        violations.push("raw SQL session expiry comparison");
      }
      if (node.tag.type === "Identifier" && sqlNames.has(node.tag.name)) {
        const nodeText = text.slice(node.start, node.end);
        for (const [index, expression] of expressions.entries()) {
          const previous = quasis[index];
          const next = quasis[index + 1];
          const previousLiteral = previous ? templateText(previous) : "";
          const nextLiteral = next ? templateText(next) : "";
          const comparisonOnLeft = /(?:>=|>|<=|<)\s*$/u.test(previousLiteral);
          const comparisonOnRight = /^\s*(?:>=|>|<=|<)/u.test(nextLiteral);
          if (
            isSessionExpiry(expression, sessionNames) &&
            (comparisonOnLeft || comparisonOnRight) &&
            !(
              file === STORE &&
              comparisonOnRight &&
              ((nextLiteral.includes("<=") &&
                nodeText.includes("expiresIn - updateAge")) ||
                (nextLiteral.includes("<") &&
                  nodeText.includes("SESSION_ABSOLUTE_AGE_MS")))
            )
          ) {
            violations.push("SQL session expiry comparison");
          }
        }
      }
    }
  });
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
  // timeout: reads and parses every production API source file, which is CPU-bound.
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
        'import { session } from "@/api/db/auth-schema"; db.select({ expiresAt: session.expiresAt }); const verify = (row: Row) => { if (row.expiresAt <= now) return null; };',
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
