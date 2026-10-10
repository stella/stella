import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import type { Transaction } from "@/api/db/root";
import { auditLogs } from "@/api/db/schema";
import { env } from "@/api/env";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import {
  auditChangesForResource,
  AUDIT_DETAIL_POLICY,
  auditReadChangesSql,
  projectAuditReadChanges,
} from "@/api/lib/audit-log-details";
import type { AuditResourceDetailPolicy } from "@/api/lib/audit-log-details";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
} from "@/api/lib/audit-log.constants";
import { createSafeId } from "@/api/lib/branded-types";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import { featurePrerequisiteClosure } from "@/api/lib/feature-access/prerequisites";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

setDefaultTimeout(120_000);

const SAMPLE_CHANGES = { value: { old: 1, new: 2 } };
const entries = Object.values(AUDIT_RESOURCE_TYPE).flatMap((resourceType) =>
  [
    null,
    "ordinary_operation",
    ...Object.keys(AUDIT_DETAIL_POLICY[resourceType].operations),
  ].flatMap((operation) =>
    [null, SAMPLE_CHANGES].map((changes) => ({
      id: createSafeId<"auditLog">(),
      resourceType,
      metadata: operation === null ? null : { operation },
      changes: auditChangesForResource(resourceType, changes),
    })),
  ),
);
const entryIds = entries.map(({ id }) => id);
const testState = createTestState({ file: import.meta.path, config: env });

const resourcePolicies = ({
  default: policy,
  operations,
}: AuditResourceDetailPolicy) => [policy, ...Object.values(operations)];
const detailPolicies =
  Object.values(AUDIT_DETAIL_POLICY).flatMap(resourcePolicies);
const callerFeatures = [
  ...new Set(
    detailPolicies.flatMap((detailPolicy) =>
      detailPolicy.type === "caller-feature" ? [detailPolicy.featureId] : [],
    ),
  ),
];
const deploymentFeatures = [
  ...new Set([
    "FEATURE_LEGAL_LISTS",
    ...detailPolicies.flatMap((detailPolicy) =>
      detailPolicy.type === "deployment-feature" ? [detailPolicy.feature] : [],
    ),
  ] as const),
];

testState.beforeAll(async () => {
  ({ testDb, ids } = await getRlsFixture());
  const recordAuditEvent = createBackgroundAuditRecorder({
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
    execution: {
      performer: { type: "user", id: ids.userA1 },
      trigger: { type: "direct" },
    },
  });
  await Promise.all(
    entries.map(async ({ id, resourceType, changes, metadata }) => {
      const event = {
        action: AUDIT_ACTION.UPDATE,
        resourceId: id,
        metadata: metadata ?? {},
      };
      const tx = asTestRaw<Transaction>(testDb);
      if (
        resourceType === AUDIT_RESOURCE_TYPE.CHAT_THREAD ||
        resourceType === AUDIT_RESOURCE_TYPE.CHAT_MESSAGE ||
        resourceType === AUDIT_RESOURCE_TYPE.CHAT_FILE
      ) {
        await recordAuditEvent(tx, {
          ...event,
          resourceType,
          changes: changes === null ? null : {},
        });
        return;
      }
      await recordAuditEvent(tx, {
        ...event,
        resourceType,
        changes: changes === null ? null : SAMPLE_CHANGES,
      });
    }),
  );
});

afterAll(async () => {
  await testDb.delete(auditLogs).where(inArray(auditLogs.resourceId, entryIds));
  await releaseRlsFixture();
});

describe("audit query and response projections agree", () => {
  test.each(
    [false, true].flatMap((deploymentEnabled) =>
      [false, true].flatMap((callerEnabled) =>
        [false, true].map((defaultEnabled) => ({
          deploymentEnabled,
          callerEnabled,
          defaultEnabled,
        })),
      ),
    ),
  )(
    "resource and operation policies agree with %j",
    async ({ deploymentEnabled, callerEnabled, defaultEnabled }) => {
      const principal = { organizationId: ids.orgA, userId: ids.userA1 };
      const featureAccessSnapshot = createFeatureAccessSnapshot({
        ...principal,
        decisions: new Map(
          callerFeatures
            .filter(
              (featureId) =>
                defaultEnabled || featureId !== LEGAL_LISTS_FEATURE_ID,
            )
            .map((featureId) => [
              featureId,
              decideFeatureAccess({
                ...principal,
                featureId,
                registry: FEATURE_REGISTRY,
                grants: callerEnabled
                  ? Object.fromEntries(
                      [
                        ...featurePrerequisiteClosure(
                          FEATURE_REGISTRY,
                          featureId,
                        ),
                      ].map((id) => [
                        id,
                        [
                          {
                            type: "organization" as const,
                            organizationId: ids.orgA,
                          },
                        ],
                      ]),
                    )
                  : {},
                user: { email: "reviewer@example.test", emailVerified: true },
                membership: true,
                enrolments: [{ ...principal, featureId }],
              }),
            ]),
        ),
      });
      const context = { principal, featureAccessSnapshot };
      const contexts = [
        context,
        { principal, featureAccessSnapshot: undefined },
      ];
      const restoreMode = setRuntimeModeForTesting({
        mode: RUNTIME_MODE.strict,
      });
      try {
        for (const feature of deploymentFeatures) {
          testState.setConfig(feature, deploymentEnabled);
        }
        for (const readContext of contexts) {
          const projected = await testDb
            .select({
              id: auditLogs.resourceId,
              changes: auditReadChangesSql(readContext),
            })
            .from(auditLogs)
            .where(inArray(auditLogs.resourceId, entryIds));
          const sample = alias(auditLogs, "audit_projection_sample");
          const aliased = await testDb
            .select({
              id: sample.resourceId,
              changes: auditReadChangesSql(readContext, sample),
            })
            .from(sample)
            .where(inArray(sample.resourceId, entryIds));
          for (const rows of [projected, aliased]) {
            expect(rows).toHaveLength(entries.length);
            const byId = new Map(rows.map((row) => [row.id, row.changes]));
            for (const entry of entries) {
              expect(byId.has(entry.id)).toBe(true);
              expect(byId.get(entry.id)).toEqual(
                projectAuditReadChanges({ ...entry, ...readContext }).changes,
              );
            }
          }
        }
      } finally {
        restoreMode();
      }
    },
  );
});
