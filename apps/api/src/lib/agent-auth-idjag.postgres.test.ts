import { panic, Result } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { ORGANIZATION_EVALUATION_LIMIT_REACHED_CODE } from "@stll/api-contract/organization-create";
import { createTestState } from "@stll/test-state";

import { member, organization } from "@/api/db/auth-schema";
import { SETTING_USER_ID } from "@/api/db/rls";
import { rootDb } from "@/api/db/root";
import {
  accountAuditLogs,
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
} from "@/api/db/schema";
import { env } from "@/api/env";
import {
  autoProvision,
  createAgentFirstOrganization,
} from "@/api/lib/agent-auth-idjag";
import { ORGANIZATION_EVALUATION_STARTED_EVENT_TYPE } from "@/api/lib/audit-log.constants";
import { getAuth } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const testState = createTestState({ file: import.meta.path, config: env });
// timeout: Each test creates organizations through their complete lifecycle.
setDefaultTimeout(120_000);

const enableEvaluations = () => {
  testState.setConfig("FEATURE_ORG_ACCESS_STATE", true);
  testState.setConfig("ORG_EVALUATION_PERIOD_DAYS", 3);
};

/** FORCE RLS binds even owner reads of account history to the account. */
const accountCreationAudit = async (userId: SafeId<"user">) =>
  await rootDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config(${SETTING_USER_ID}, ${userId}, true)`,
    );
    return await tx
      .select({
        eventType: accountAuditLogs.eventType,
        resourceId: accountAuditLogs.resourceId,
        groupId: accountAuditLogs.groupId,
        createdAt: accountAuditLogs.createdAt,
      })
      .from(accountAuditLogs)
      .where(
        and(
          eq(accountAuditLogs.userId, userId),
          inArray(accountAuditLogs.eventType, [
            "organization.created",
            ORGANIZATION_EVALUATION_STARTED_EVENT_TYPE,
          ]),
        ),
      )
      .orderBy(accountAuditLogs.resourceId, accountAuditLogs.eventType);
  });

const ownedOrganizationNames = async (userId: SafeId<"user">) =>
  (
    await rootDb
      .select({ name: organization.name })
      .from(organization)
      .innerJoin(member, eq(member.organizationId, organization.id))
      .where(and(eq(member.userId, userId), eq(member.role, "owner")))
      .orderBy(organization.name)
  ).map(({ name }) => name);

const accessStates = async (organizationId: SafeId<"organization">) =>
  await rootDb
    .select({
      state: organizationAccessStates.state,
      createdAt: organizationAccessStates.createdAt,
    })
    .from(organizationAccessStates)
    .where(eq(organizationAccessStates.organizationId, organizationId));

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "agent first-organization provisioning on PostgreSQL",
  () => {
    test("an agent-provisioned account's first organization holds an evaluation grant written with it", async () => {
      enableEvaluations();
      const provisioned = await autoProvision(
        `agent-provision-${Bun.randomUUIDv7()}@example.test`,
      );
      if (Result.isError(provisioned)) {
        return panic("Agent provisioning failed", provisioned.error);
      }
      const { userId, organizationId } = provisioned.value;
      expect(await ownedOrganizationNames(userId)).toHaveLength(1);

      const audit = await accountCreationAudit(userId);
      expect(
        audit.map(({ eventType, resourceId }) => ({ eventType, resourceId })),
      ).toEqual([
        { eventType: "organization.created", resourceId: organizationId },
        {
          eventType: ORGANIZATION_EVALUATION_STARTED_EVENT_TYPE,
          resourceId: organizationId,
        },
      ]);
      // Both events and the organization's initial state carry the
      // transaction timestamp: one transaction wrote all of them.
      const [state] = await accessStates(organizationId);
      if (state === undefined) {
        return panic("The provisioned organization has no access state");
      }
      expect(state.state).toBe(ORGANIZATION_ACCESS_STATE.evaluationPeriod);
      expect(audit.map(({ createdAt }) => createdAt)).toEqual([
        state.createdAt,
        state.createdAt,
      ]);
      expect(new Set(audit.map(({ groupId }) => groupId)).size).toBe(1);
    });

    test("agent first-organization creation consumes grants and is refused at the lifetime limit without writing", async () => {
      enableEvaluations();
      const created = await getAuth().api.createAgentUser({
        body: {
          email: `agent-limit-${Bun.randomUUIDv7()}@example.test`,
          name: "Agent",
          emailVerified: true,
        },
      });
      const userId = brandPersistedUserId(created.id);
      const admit = async (name: string) => {
        const admitted = await createAgentFirstOrganization({ userId, name });
        if (Result.isError(admitted)) {
          return panic("Agent organization creation failed", admitted.error);
        }
        return admitted.value.organizationId;
      };
      const admitted = [
        await admit("First"),
        await admit("Second"),
        await admit("Third"),
      ];
      const auditBefore = await accountCreationAudit(userId);
      expect(
        auditBefore
          .filter(
            ({ eventType }) =>
              eventType === ORGANIZATION_EVALUATION_STARTED_EVENT_TYPE,
          )
          .map(({ resourceId }) => resourceId)
          .toSorted(),
      ).toEqual(admitted.toSorted());

      const refused = await createAgentFirstOrganization({
        userId,
        name: "Fourth",
      });
      if (!Result.isError(refused)) {
        return panic("The fourth evaluation organization was admitted");
      }
      expect(HandlerError.is(refused.error)).toBe(true);
      expect(refused.error).toMatchObject({
        status: 403,
        code: ORGANIZATION_EVALUATION_LIMIT_REACHED_CODE,
      });
      expect(await ownedOrganizationNames(userId)).toEqual([
        "First",
        "Second",
        "Third",
      ]);
      expect(await accountCreationAudit(userId)).toEqual(auditBefore);
    });
  },
);
