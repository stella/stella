import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import {
  AUDIT_DETAIL_POLICY,
  projectAuditReadChanges,
} from "@/api/lib/audit-log-details";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log.constants";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/auth/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";

const PRINCIPAL = { organizationId: "org_test", userId: "user_test" };
const CHANGES = { amount: { old: 100, new: 200 } };

const missingClassifications = (
  resources: readonly string[],
  policies: Readonly<Record<string, unknown>>,
) => resources.filter((resource) => !Object.hasOwn(policies, resource));

describe("audit detail policy census", () => {
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
                  grants: {
                    [policy.featureId]: [
                      {
                        type: "organization",
                        organizationId: PRINCIPAL.organizationId,
                      },
                    ],
                  },
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
          const previous = env[policy.feature];
          const restoreMode = setRuntimeModeForTesting({
            mode: RUNTIME_MODE.strict,
          });
          try {
            env[policy.feature] = false;
            expect(projectAuditReadChanges(input)).toEqual({
              changesStatus: "feature_unavailable",
              changes: null,
            });
            env[policy.feature] = true;
            expect(projectAuditReadChanges(input)).toEqual({
              changesStatus: "visible",
              changes: CHANGES,
            });
          } finally {
            env[policy.feature] = previous;
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
  const file = ts.createSourceFile(
    "writer.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const writes: { resourceType: string; operation: string | null }[] = [];
  const property = (object: ts.ObjectLiteralExpression, name: string) =>
    object.properties.find(
      (entry): entry is ts.PropertyAssignment =>
        ts.isPropertyAssignment(entry) && entry.name.getText(file) === name,
    )?.initializer;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "recordAuditEvent"
    ) {
      const payload = node.arguments.at(1);
      if (!payload || !ts.isObjectLiteralExpression(payload)) {
        throw new TypeError(
          "Feature audit writes require a classified object payload",
        );
      }
      const resource = property(payload, "resourceType");
      if (
        !resource ||
        !ts.isPropertyAccessExpression(resource) ||
        resource.expression.getText(file) !== "AUDIT_RESOURCE_TYPE"
      ) {
        throw new TypeError("Feature audit writes require a resource constant");
      }
      const resourceType = Object.entries(AUDIT_RESOURCE_TYPE).find(
        ([name]) => name === resource.name.text,
      )?.[1];
      if (!resourceType) {
        throw new TypeError("Feature audit resource requires a classification");
      }
      const metadata = property(payload, "metadata");
      if (metadata && !ts.isObjectLiteralExpression(metadata)) {
        throw new TypeError(
          "Feature audit metadata requires an explicit operation classification",
        );
      }
      const operation = metadata ? property(metadata, "operation") : undefined;
      if (operation && !ts.isStringLiteral(operation)) {
        throw new TypeError(
          "Feature audit operation requires a literal classification",
        );
      }
      writes.push({ resourceType, operation: operation?.text ?? null });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
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

  test("requires an inspectable operation at the writer boundary", () => {
    expect(() =>
      auditedWrites(
        `recordAuditEvent(tx, {resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM, metadata: {operation: nextOperation}});`,
      ),
    ).toThrow("Feature audit operation requires a literal classification");
  });
});

for (const operation of Object.keys(
  AUDIT_DETAIL_POLICY[AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM].operations,
)) {
  test(`${operation} requires its resource deployment policy as well as enrolment`, () => {
    const previous = env.FEATURE_LEGAL_LISTS;
    const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    const featureId = LIST_VERIFICATION_FEATURE_ID;
    const featureAccessSnapshot = createFeatureAccessSnapshot({
      ...PRINCIPAL,
      decisions: new Map([
        [
          featureId,
          decideFeatureAccess({
            ...PRINCIPAL,
            registry: FEATURE_REGISTRY,
            featureId,
            grants: {
              [featureId]: [
                {
                  type: "organization",
                  organizationId: PRINCIPAL.organizationId,
                },
              ],
            },
            user: { email: "test@example.test", emailVerified: true },
            membership: true,
            enrolments: [{ ...PRINCIPAL, featureId }],
          }),
        ],
      ]),
    });
    try {
      env.FEATURE_LEGAL_LISTS = false;
      expect(
        projectAuditReadChanges({
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
          metadata: { operation },
          changes: CHANGES,
          featureAccessSnapshot,
          principal: PRINCIPAL,
        }),
      ).toEqual({ changesStatus: "feature_unavailable", changes: null });
    } finally {
      env.FEATURE_LEGAL_LISTS = previous;
      restoreMode();
    }
  });
}
