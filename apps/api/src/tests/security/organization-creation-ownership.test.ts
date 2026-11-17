import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  type ModuleExportName,
  type Node,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree";

const apiRoot = path.resolve(import.meta.dir, "../../..");

const OWNER_FILE = "src/lib/db/organization-creation.ts";
const OWNER_CALL = /\b(?:create|insert)OrganizationWithEvaluation\(/u;
const ACCOUNT_OWNER = "createOrganizationForAccount";
const ENDPOINT_ADAPTER = "createOrganizationInTransaction";
const ENDPOINT_ADAPTER_FILE =
  "src/lib/auth/create-organization-in-transaction.ts";
const RAW_ORGANIZATION_INSERT =
  /\binsert\s+into\s+(?:"?public"?\.)?"?organization"?[\s(]/iu;

const exportName = (name: ModuleExportName) =>
  name.type === "Identifier" ? name.name : name.value;

const isAuthSchema = (specifier: string) =>
  /(?:^|\/)auth-schema(?:\.ts)?$/u.test(specifier);

const calleeName = (node: Node): string | undefined => {
  if (node.type !== "CallExpression") {
    return undefined;
  }
  if (node.callee.type === "Identifier") {
    return node.callee.name;
  }
  if (
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.property.type === "Identifier"
  ) {
    return node.callee.property.name;
  }
  return undefined;
};

/** `auth.api.createOrganization` or the raw endpoint `organizationCreateEndpoint`. */
const organizationPluginCreate = (node: Node): string | undefined => {
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression"
  ) {
    return undefined;
  }
  const { callee } = node;
  const { object, property } = callee;
  if (callee.computed || property.type !== "Identifier") {
    return undefined;
  }
  if (property.name === "organizationCreateEndpoint") {
    return property.name;
  }
  const receiverIsAuthApi =
    (object.type === "Identifier" && object.name === "api") ||
    (object.type === "MemberExpression" &&
      !object.computed &&
      object.property.type === "Identifier" &&
      object.property.name === "api");
  return property.name === "createOrganization" && receiverIsAuthApi
    ? property.name
    : undefined;
};

/** The endpoint adapter is only ever the account owner's injected writer. */
const insideAccountOwnerDependencies = (ancestors: readonly Node[]) =>
  ancestors.some(
    (ancestor, index) =>
      calleeName(ancestor) === ACCOUNT_OWNER &&
      ancestor.type === "CallExpression" &&
      ancestor.arguments.some(
        (argument) =>
          argument.type === "ObjectExpression" &&
          ancestors.at(index + 1) === argument,
      ),
  );

/**
 * Every production write of an organization row: a Drizzle insert into the
 * auth-schema table or a raw SQL insert (only the owner module writes these),
 * and the organization plugin's create (only the endpoint adapter calls it,
 * and only the account owner receives the adapter).
 */
const organizationInsertViolations = (file: string, source: string) => {
  const { program, locate } = parseSource(file, source);
  const tableBindings = new Set<string>();
  const schemaNamespaces = new Set<string>();
  walk(program, (node) => {
    if (node.type !== "ImportDeclaration" || !isAuthSchema(node.source.value)) {
      return;
    }
    for (const specifier of node.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") {
        schemaNamespaces.add(specifier.local.name);
      } else if (
        specifier.type === "ImportSpecifier" &&
        exportName(specifier.imported) === "organization"
      ) {
        tableBindings.add(specifier.local.name);
      }
    }
  });
  const isOrganizationTable = (node: Node | undefined) =>
    (node?.type === "Identifier" && tableBindings.has(node.name)) ||
    (node?.type === "MemberExpression" &&
      !node.computed &&
      node.object.type === "Identifier" &&
      schemaNamespaces.has(node.object.name) &&
      node.property.type === "Identifier" &&
      node.property.name === "organization");

  const violations: string[] = [];
  const report = (node: Node, kind: string) => {
    violations.push(`${file}:${locate(node.start).line}: ${kind}`);
  };
  walk(program, (node, ancestors) => {
    if (
      file !== OWNER_FILE &&
      node.type === "TemplateLiteral" &&
      RAW_ORGANIZATION_INSERT.test(
        node.quasis.map((quasi) => quasi.value.raw).join(" "),
      )
    ) {
      report(node, "raw organization insert");
    }
    if (
      file !== ENDPOINT_ADAPTER_FILE &&
      node.type === "Identifier" &&
      node.name === ENDPOINT_ADAPTER &&
      ancestors.at(-1)?.type !== "ImportSpecifier" &&
      !insideAccountOwnerDependencies(ancestors)
    ) {
      report(node, `${ENDPOINT_ADAPTER} outside ${ACCOUNT_OWNER}`);
    }
    if (
      file !== OWNER_FILE &&
      node.type === "CallExpression" &&
      calleeName(node) === "insert" &&
      isOrganizationTable(node.arguments.at(0))
    ) {
      report(node, "organization table insert");
    }
    const pluginCreate = organizationPluginCreate(node);
    if (file !== ENDPOINT_ADAPTER_FILE && pluginCreate !== undefined) {
      report(node, `organization plugin ${pluginCreate}`);
    }
  });
  return violations;
};

const TABLE_IMPORT = 'import { organization } from "@/api/db/auth-schema";';
const ADAPTER_IMPORT =
  'import { createOrganizationInTransaction } from "@/api/lib/auth/create-organization-in-transaction";';

describe("organization creation ownership", () => {
  test.each([
    [
      `${TABLE_IMPORT}\nawait tx.insert(organization).values(row);`,
      "src/lib/example.ts:2: organization table insert",
    ],
    [
      'import { organization as org } from "../db/auth-schema";\nawait db.insert(org).values(row).onConflictDoNothing();',
      "src/lib/example.ts:2: organization table insert",
    ],
    [
      'import * as authSchema from "@/api/db/auth-schema";\nawait tx.insert(authSchema.organization).values(row);',
      "src/lib/example.ts:2: organization table insert",
    ],
    [
      "await tx.execute(sql`INSERT INTO organization (id, name, slug) VALUES ('a', 'b', 'c')`);",
      "src/lib/example.ts:1: raw organization insert",
    ],
    [
      "await auth.api.createOrganization({ body });",
      "src/lib/example.ts:1: organization plugin createOrganization",
    ],
    [
      "await auth.organizationCreateEndpoint({ body, context });",
      "src/lib/example.ts:1: organization plugin organizationCreateEndpoint",
    ],
    [
      `${ADAPTER_IMPORT}\nawait createOrganizationInTransaction({ transaction, body });`,
      "src/lib/example.ts:2: createOrganizationInTransaction outside createOrganizationForAccount",
    ],
  ])("flags a bypassing insert: %s", (source, violation) => {
    expect(organizationInsertViolations("src/lib/example.ts", source)).toEqual([
      violation,
    ]);
  });

  test.each([
    `${TABLE_IMPORT}\nawait tx.insert(member).values(row);\nawait tx.select().from(organization);`,
    "await reviewAccountOrganizations.createOrganization({ organizationId, ownerUserId });",
    `${ADAPTER_IMPORT}\nawait createOrganizationForAccount(input, { createOrganization: createOrganizationInTransaction });`,
    'import { organization } from "@/api/db/schema/other";\nawait tx.insert(organization).values(row);',
  ])("accepts an unrelated or owned write: %s", (source) => {
    expect(organizationInsertViolations("src/lib/example.ts", source)).toEqual(
      [],
    );
  });

  test("the owner module and the endpoint adapter are the only writers", () => {
    expect(
      organizationInsertViolations(
        OWNER_FILE,
        `${TABLE_IMPORT}\nawait tx.insert(organization).values(row);`,
      ),
    ).toEqual([]);
    expect(
      organizationInsertViolations(
        ENDPOINT_ADAPTER_FILE,
        "await auth.organizationCreateEndpoint({ body, context });",
      ),
    ).toEqual([]);
  });

  test("production organization inserts go through the creation owner", async () => {
    const files = [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: apiRoot })]
      .filter(
        (file) =>
          !file.endsWith(".test.ts") &&
          !file.endsWith(".spec.ts") &&
          !file.startsWith("src/tests/"),
      )
      .toSorted();
    const violations: string[] = [];
    const ownerCallers: string[] = [];
    for (const file of files) {
      const source = await Bun.file(path.join(apiRoot, file)).text();
      if (!/organization/iu.test(source)) {
        continue;
      }
      violations.push(...organizationInsertViolations(file, source));
      if (file !== OWNER_FILE && OWNER_CALL.test(source)) {
        ownerCallers.push(file);
      }
    }
    expect(violations).toEqual([]);
    // A scan that silently matched nothing would pass vacuously.
    expect(ownerCallers).toEqual([
      "src/db/root.ts",
      "src/lib/db/review-account-organization-store.ts",
      "src/lib/smoke-session/store.ts",
      "src/lib/synthetic-principal/store.ts",
    ]);
  });
});
