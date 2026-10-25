import { describe, expect, test } from "bun:test";
import { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import path from "node:path";

import { RUNTIME_MODE } from "@stll/runtime-mode";
import {
  type Node,
  type ObjectExpression,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree";

import { auditLogs } from "@/api/db/schema";
import { env } from "@/api/env";
import {
  AUDIT_DETAIL_POLICY,
  auditReadActivityActionSql,
  projectAuditReadChanges,
} from "@/api/lib/audit-log-details";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log.constants";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import { featurePrerequisiteClosure } from "@/api/lib/feature-access/prerequisites";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { LIST_VERIFICATION_ITEM_OPERATION } from "@/api/lib/lists/item-operations";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { createTestState } from "@/api/tests/helpers/test-state";

const testState = createTestState({ file: import.meta.path, config: env });

const PRINCIPAL = { organizationId: "org_test", userId: "user_test" };
const CHANGES = { amount: { old: 100, new: 200 } };

const missingClassifications = (
  resources: readonly string[],
  policies: Readonly<Record<string, unknown>>,
) => resources.filter((resource) => !Object.hasOwn(policies, resource));

describe("audit detail policy census", () => {
  test("activity classification matches the declared index expression", () => {
    const index = getTableConfig(auditLogs).indexes.find(
      ({ config }) =>
        config.name ===
        "audit_logs_org_workspace_activity_action_created_id_idx",
    );
    const expression = index?.config.columns.at(2);
    if (!(expression instanceof SQL)) {
      throw new TypeError("Activity action index requires an SQL expression");
    }
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(auditReadActivityActionSql())).toEqual(
      dialect.sqlToQuery(expression),
    );
  });
  test("classifies every audited resource exactly once", () => {
    const resources = Object.values(AUDIT_RESOURCE_TYPE);
    expect(missingClassifications(resources, AUDIT_DETAIL_POLICY)).toEqual([]);
    expect(Object.keys(AUDIT_DETAIL_POLICY).toSorted()).toEqual(
      resources.toSorted(),
    );
  });

  test("detects an omitted resource classification", () => {
    const { [AUDIT_RESOURCE_TYPE.TIME_ENTRY]: _omitted, ...incomplete } =
      AUDIT_DETAIL_POLICY;
    expect(
      missingClassifications(Object.values(AUDIT_RESOURCE_TYPE), incomplete),
    ).toEqual([AUDIT_RESOURCE_TYPE.TIME_ENTRY]);
  });

  test("requires a classification for a stored resource", () => {
    expect(() =>
      projectAuditReadChanges({
        resourceType: "unclassified_resource",
        metadata: null,
        changes: CHANGES,
        featureAccessSnapshot: undefined,
        principal: PRINCIPAL,
      }),
    ).toThrow("Audit resource requires a detail policy");
  });

  for (const [resourceType, { default: policy }] of Object.entries(
    AUDIT_DETAIL_POLICY,
  )) {
    test(`${resourceType} follows its declared detail policy`, () => {
      const input = {
        resourceType,
        metadata: null,
        changes: CHANGES,
        featureAccessSnapshot: undefined,
        principal: PRINCIPAL,
      };
      switch (policy.type) {
        case "ungated":
          expect(projectAuditReadChanges(input)).toEqual({
            changesStatus: "visible",
            changes: resourceType.startsWith("chat_") ? {} : CHANGES,
          });
          return;
        case "caller-feature": {
          expect(projectAuditReadChanges(input)).toEqual({
            changesStatus: "feature_unavailable",
            changes: null,
          });
          expect(
            projectAuditReadChanges({
              ...input,
              featureAccessSnapshot: createFeatureAccessSnapshot({
                ...PRINCIPAL,
                decisions: new Map([[policy.featureId, { status: "hidden" }]]),
              }),
            }),
          ).toEqual({ changesStatus: "feature_unavailable", changes: null });
          const featureAccessSnapshot = createFeatureAccessSnapshot({
            ...PRINCIPAL,
            decisions: new Map([
              [
                policy.featureId,
                decideFeatureAccess({
                  ...PRINCIPAL,
                  registry: FEATURE_REGISTRY,
                  grants: Object.fromEntries(
                    [
                      ...featurePrerequisiteClosure(
                        FEATURE_REGISTRY,
                        policy.featureId,
                      ),
                    ].map((id) => [
                      id,
                      [
                        {
                          type: "organization" as const,
                          organizationId: PRINCIPAL.organizationId,
                        },
                      ],
                    ]),
                  ),
                  featureId: policy.featureId,
                  user: { email: "test@example.test", emailVerified: true },
                  membership: true,
                  enrolments: [{ ...PRINCIPAL, featureId: policy.featureId }],
                }),
              ],
            ]),
          });
          expect(
            projectAuditReadChanges({ ...input, featureAccessSnapshot }),
          ).toEqual({
            changesStatus: "visible",
            changes: CHANGES,
          });
          return;
        }
        case "deployment-feature": {
          const restoreMode = setRuntimeModeForTesting({
            mode: RUNTIME_MODE.strict,
          });
          try {
            testState.setConfig(policy.feature, false);
            expect(projectAuditReadChanges(input)).toEqual({
              changesStatus: "feature_unavailable",
              changes: null,
            });
            testState.setConfig(policy.feature, true);
            expect(projectAuditReadChanges(input)).toEqual({
              changesStatus: "visible",
              changes: CHANGES,
            });
          } finally {
            restoreMode();
          }
          return;
        }
        default:
          policy satisfies never;
      }
    });
  }
});

const auditedWrites = (source: string) => {
  const file = parseSource("writer.ts", source);
  const writes: { resourceType: string; operation: string | null }[] = [];
  const operationImports = new Set(
    file.program.body.flatMap((statement) => {
      if (
        statement.type !== "ImportDeclaration" ||
        statement.source.value !== "@/api/lib/lists/item-operations"
      ) {
        return [];
      }
      return statement.specifiers.flatMap((binding) =>
        binding.type === "ImportSpecifier" &&
        (binding.imported.type === "Identifier"
          ? binding.imported.name
          : binding.imported.value) === "LIST_VERIFICATION_ITEM_OPERATION"
          ? [binding.local.name]
          : [],
      );
    }),
  );
  const operationValue = (operation: Node | undefined) => {
    if (!operation) {
      return null;
    }
    if (operation.type === "Literal" && typeof operation.value === "string") {
      return operation.value;
    }
    if (
      operation.type === "MemberExpression" &&
      !operation.computed &&
      operation.property.type === "Identifier" &&
      operation.object.type === "Identifier" &&
      operationImports.has(operation.object.name)
    ) {
      const operationName = operation.property.name;
      const value = Object.entries(LIST_VERIFICATION_ITEM_OPERATION).find(
        ([name]) => name === operationName,
      )?.[1];
      if (value !== undefined) {
        return value;
      }
    }
    throw new TypeError(
      "Feature audit operation requires a shared constant or literal classification",
    );
  };
  const property = (object: ObjectExpression, name: string) => {
    const entry = object.properties.find(
      (candidate) =>
        candidate.type === "Property" &&
        candidate.kind === "init" &&
        !candidate.method &&
        !candidate.shorthand &&
        source.slice(candidate.key.start, candidate.key.end) === name,
    );
    return entry?.type === "Property" ? entry.value : undefined;
  };
  const mappedObjectLiteral = (expression: Node) => {
    if (
      expression.type !== "CallExpression" ||
      expression.callee.type !== "MemberExpression" ||
      expression.callee.computed ||
      expression.callee.property.type !== "Identifier" ||
      expression.callee.property.name !== "map"
    ) {
      return undefined;
    }
    const mapper = expression.arguments.at(0);
    if (!mapper || mapper.type !== "ArrowFunctionExpression") {
      return undefined;
    }
    const body =
      mapper.body.type === "ParenthesizedExpression"
        ? mapper.body.expression
        : mapper.body;
    return body.type === "ObjectExpression" ? body : undefined;
  };
  // A batch write is inspected entry by entry: each element is an object
  // literal or a spread of `items.map((item) => ({ ... }))`.
  const auditPayloads = (payload: Node | undefined): ObjectExpression[] => {
    if (payload?.type === "ObjectExpression") {
      return [payload];
    }
    if (payload?.type === "ArrayExpression") {
      return payload.elements.map((element) => {
        if (element?.type === "ObjectExpression") {
          return element;
        }
        const mapped =
          element?.type === "SpreadElement"
            ? mappedObjectLiteral(element.argument)
            : undefined;
        if (!mapped) {
          throw new TypeError(
            "Feature audit writes require a classified object payload",
          );
        }
        return mapped;
      });
    }
    throw new TypeError(
      "Feature audit writes require a classified object payload",
    );
  };
  const classify = (payload: ObjectExpression) => {
    const resource = property(payload, "resourceType");
    if (
      !resource ||
      resource.type !== "MemberExpression" ||
      resource.computed ||
      resource.property.type !== "Identifier" ||
      source.slice(resource.object.start, resource.object.end) !==
        "AUDIT_RESOURCE_TYPE"
    ) {
      throw new TypeError("Feature audit writes require a resource constant");
    }
    const resourceName = resource.property.name;
    const resourceType = Object.entries(AUDIT_RESOURCE_TYPE).find(
      ([name]) => name === resourceName,
    )?.[1];
    if (!resourceType) {
      throw new TypeError("Feature audit resource requires a classification");
    }
    const metadata = property(payload, "metadata");
    if (metadata && metadata.type !== "ObjectExpression") {
      throw new TypeError(
        "Feature audit metadata requires an explicit operation classification",
      );
    }
    const operation = metadata ? property(metadata, "operation") : undefined;
    writes.push({ resourceType, operation: operationValue(operation) });
  };
  walk(file.program, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "recordAuditEvent"
    ) {
      for (const payload of auditPayloads(node.arguments.at(1))) {
        classify(payload);
      }
    }
  });
  return writes;
};

const verificationWritesWithoutPolicy = (source: string) =>
  auditedWrites(source).filter(({ resourceType, operation }) => {
    const entry = Object.entries(AUDIT_DETAIL_POLICY).find(
      ([resource]) => resource === resourceType,
    )?.[1];
    if (!entry) {
      return true;
    }
    const policy =
      Object.entries(entry.operations).find(
        ([name]) => name === operation,
      )?.[1] ?? entry.default;
    return (
      policy.type !== "caller-feature" ||
      policy.featureId !== LIST_VERIFICATION_FEATURE_ID
    );
  });

describe("feature-owned audit operations", () => {
  test("classifies every audit write in verification-owned handler directories", () => {
    const root = path.resolve(import.meta.dir, "../../../..");
    const sources = FEATURE_REGISTRY[
      LIST_VERIFICATION_FEATURE_ID
    ].ownership.handlerDirectories.flatMap((directory) =>
      [
        ...new Bun.Glob("**/*.ts").scanSync({
          cwd: path.join(root, directory),
          onlyFiles: true,
        }),
      ]
        .filter((file) => !file.endsWith(".test.ts"))
        .map((file) => ({
          file: path.join(directory, file),
          source: readFileSync(path.join(root, directory, file), "utf-8"),
        })),
    );
    expect(sources.length).toBeGreaterThan(0);
    expect(
      sources.reduce(
        (count, { source }) => count + auditedWrites(source).length,
        0,
      ),
    ).toBeGreaterThan(0);
    for (const { file, source } of sources) {
      expect({
        file,
        unclassified: verificationWritesWithoutPolicy(source),
      }).toEqual({ file, unclassified: [] });
    }
  });

  test("detects a new operation without its feature classification", () => {
    const source = `recordAuditEvent(tx, {resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM, metadata: {operation: "new_item_operation"}});`;
    expect(verificationWritesWithoutPolicy(source)).toEqual([
      {
        resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
        operation: "new_item_operation",
      },
    ]);
  });

  test("classifies each entry of a batch audit write", () => {
    const source = `recordAuditEvent(tx, [
      {resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_VERIFICATION},
      ...items.map((item) => ({resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM, metadata: {operation: "new_item_operation"}})),
    ]);`;
    expect(verificationWritesWithoutPolicy(source)).toEqual([
      {
        resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
        operation: "new_item_operation",
      },
    ]);
    expect(() => auditedWrites("recordAuditEvent(tx, [...entries]);")).toThrow(
      "Feature audit writes require a classified object payload",
    );
  });

  test("requires an inspectable operation at the writer boundary", () => {
    expect(() =>
      auditedWrites(
        `recordAuditEvent(tx, {resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM, metadata: {operation: nextOperation}});`,
      ),
    ).toThrow(
      "Feature audit operation requires a shared constant or literal classification",
    );
  });

  test("classifies the shared operations through their imported owner", () => {
    for (const [name, operation] of Object.entries(
      LIST_VERIFICATION_ITEM_OPERATION,
    )) {
      const source = `import { LIST_VERIFICATION_ITEM_OPERATION as operationOwner } from "@/api/lib/lists/item-operations";
        recordAuditEvent(tx, {resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM, metadata: {operation: operationOwner.${name}}});`;
      expect(auditedWrites(source)).toEqual([
        { resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM, operation },
      ]);
      expect(verificationWritesWithoutPolicy(source)).toEqual([]);
    }
    expect(() =>
      auditedWrites(`recordAuditEvent(tx, {resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
      metadata: {operation: LIST_VERIFICATION_ITEM_OPERATION.factDetailsSet}});`),
    ).toThrow(
      "Feature audit operation requires a shared constant or literal classification",
    );
  });
});

const legalListAuditSnapshot = () =>
  createFeatureAccessSnapshot({
    ...PRINCIPAL,
    decisions: new Map(
      [LEGAL_LISTS_FEATURE_ID, LIST_VERIFICATION_FEATURE_ID].map(
        (featureId) => [
          featureId,
          decideFeatureAccess({
            ...PRINCIPAL,
            registry: FEATURE_REGISTRY,
            featureId,
            grants: Object.fromEntries(
              [
                ...featurePrerequisiteClosure(
                  FEATURE_REGISTRY,
                  LIST_VERIFICATION_FEATURE_ID,
                ),
              ].map((id) => [
                id,
                [
                  {
                    type: "organization" as const,
                    organizationId: PRINCIPAL.organizationId,
                  },
                ],
              ]),
            ),
            user: { email: "test@example.test", emailVerified: true },
            membership: true,
          }),
        ],
      ),
    ),
  });

test("ordinary legal-list audit details require caller access", () => {
  const input = {
    resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST,
    metadata: null,
    changes: CHANGES,
    principal: PRINCIPAL,
  };
  expect(
    projectAuditReadChanges({ ...input, featureAccessSnapshot: undefined }),
  ).toEqual({ changesStatus: "feature_unavailable", changes: null });
  expect(
    projectAuditReadChanges({
      ...input,
      featureAccessSnapshot: legalListAuditSnapshot(),
    }),
  ).toEqual({ changesStatus: "visible", changes: CHANGES });
});

for (const operation of Object.keys(
  AUDIT_DETAIL_POLICY[AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM].operations,
)) {
  test(`${operation} uses its operation policy independently of the default`, () => {
    const granted = legalListAuditSnapshot();
    expect(granted.decisions.get(LIST_VERIFICATION_FEATURE_ID)?.status).toBe(
      "enabled",
    );
    const verificationOnly = createFeatureAccessSnapshot({
      ...PRINCIPAL,
      decisions: new Map(
        [...granted.decisions].filter(
          ([featureId]) => featureId !== LEGAL_LISTS_FEATURE_ID,
        ),
      ),
    });
    const input = {
      resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
      metadata: { operation },
      changes: CHANGES,
      principal: PRINCIPAL,
    };
    expect(
      projectAuditReadChanges({
        ...input,
        featureAccessSnapshot: verificationOnly,
      }),
    ).toEqual({ changesStatus: "visible", changes: CHANGES });
    expect(
      projectAuditReadChanges({ ...input, featureAccessSnapshot: granted }),
    ).toEqual({ changesStatus: "visible", changes: CHANGES });
  });
}
