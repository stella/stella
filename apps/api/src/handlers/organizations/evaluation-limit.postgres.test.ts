import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";
import { organizationCreateOutputSchema } from "@stll/api-contract/organization-create";
import { createTestState } from "@stll/test-state";

import { SETTING_USER_ID } from "@/api/db/rls";
import { rootDb } from "@/api/db/root";
import {
  accountAuditLogs,
  organizationConfiguredAccess,
  usageEntitlements,
  usagePolicies,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { organizationsRoute } from "@/api/handlers/organizations/routes";
import { ORGANIZATION_EVALUATION_STARTED_EVENT_TYPE } from "@/api/lib/audit-log.constants";
import { getAuth } from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import {
  FREE_TIER_OFF,
  resolveOrganizationAccess,
} from "@/api/lib/usage/organization-access";
import {
  readOrganizationAccessSnapshot,
  readOriginalOrganizationAccessSnapshot,
} from "@/api/lib/usage/organization-access-snapshot";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import { serveRoutesForTest } from "@/api/tests/helpers/serve-routes";
import type { TestServer } from "@/api/tests/helpers/test-server";

const testState = createTestState({ file: import.meta.path, config: env });
const EVALUATION_LIMIT_CODE = "organization_evaluation_limit_reached";
// timeout: Each test creates several organizations through their complete lifecycle.
setDefaultTimeout(120_000);

const enableEvaluations = () => {
  testState.setConfig("FEATURE_ORG_ACCESS_STATE", true);
  testState.setConfig("ORG_EVALUATION_PERIOD_DAYS", 3);
};

type CreateOrganizationRequestOptions = {
  api: TestServer;
  browser: HumanBrowser;
  key: string;
};

const requestCreation = async ({
  api,
  browser,
  key,
}: CreateOrganizationRequestOptions) =>
  await api.fetch(
    new Request("http://localhost/organizations", {
      method: "POST",
      headers: {
        cookie: browser.cookieHeader(),
        "content-type": "application/json",
        origin: "http://localhost:3000",
        "Idempotency-Key": key,
        [CAPABILITY_REQUEST_HEADER]: "organizations.create",
      },
      body: JSON.stringify({ name: "Evaluation limit fixture" }),
    }),
  );

const createOrganization = async (
  options: CreateOrganizationRequestOptions,
) => {
  const response = await requestCreation(options);
  expect(response.status, await response.clone().text()).toBe(200);
  return v.parse(organizationCreateOutputSchema, await response.json());
};

const expectQuotaRefusal = async (response: Response) => {
  expect(response.status, await response.clone().text()).toBe(403);
  expect(await response.json()).toMatchObject({ code: EVALUATION_LIMIT_CODE });
};

const evaluationGrants = async (browser: HumanBrowser) =>
  await rootDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config(${SETTING_USER_ID}, ${browser.userId}, true)`,
    );
    return await tx
      .select({ resourceId: accountAuditLogs.resourceId })
      .from(accountAuditLogs)
      .where(
        and(
          eq(accountAuditLogs.userId, brandPersistedUserId(browser.userId)),
          eq(
            accountAuditLogs.eventType,
            ORGANIZATION_EVALUATION_STARTED_EVENT_TYPE,
          ),
        ),
      )
      .orderBy(accountAuditLogs.resourceId)
      .limit(4);
  });

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "lifetime organization evaluation allowance on PostgreSQL",
  () => {
    test("three evaluations exhaust the allowance even after an organization is deleted", async () => {
      enableEvaluations();
      const suffix = Bun.randomUUIDv7();
      const browser = await signInHuman(
        `evaluation-lifetime-${suffix}@example.test`,
      );
      await using api = serveRoutesForTest(organizationsRoute);
      const first = await createOrganization({
        api,
        browser,
        key: `${suffix}-first`,
      });
      await createOrganization({ api, browser, key: `${suffix}-second` });
      await createOrganization({ api, browser, key: `${suffix}-third` });
      expect(
        await createOrganization({ api, browser, key: `${suffix}-first` }),
      ).toStrictEqual(first);
      const grants = await evaluationGrants(browser);
      expect(grants).toHaveLength(3);
      await expectQuotaRefusal(
        await requestCreation({ api, browser, key: `${suffix}-fourth` }),
      );
      await getAuth().api.deleteOrganization({
        headers: browser.headers(),
        body: { organizationId: first.organizationId },
      });
      const organizations = await getAuth().api.listOrganizations({
        headers: browser.headers(),
      });
      expect(organizations.map(({ id }) => id)).not.toContain(
        first.organizationId,
      );
      await expectQuotaRefusal(
        await requestCreation({ api, browser, key: `${suffix}-after-delete` }),
      );
      expect(await evaluationGrants(browser)).toEqual(grants);
    });

    test("parallel creates share the final evaluation slot", async () => {
      enableEvaluations();
      const suffix = Bun.randomUUIDv7();
      const browser = await signInHuman(
        `evaluation-race-${suffix}@example.test`,
      );
      await using api = serveRoutesForTest(organizationsRoute);
      await createOrganization({ api, browser, key: `${suffix}-first` });
      await createOrganization({ api, browser, key: `${suffix}-second` });
      const responses = await Promise.all([
        requestCreation({ api, browser, key: `${suffix}-race-a` }),
        requestCreation({ api, browser, key: `${suffix}-race-b` }),
      ]);
      expect(responses.map(({ status }) => status).toSorted()).toEqual([
        200, 403,
      ]);
      for (const response of responses) {
        if (response.status === 403) {
          await expectQuotaRefusal(response);
        } else {
          v.parse(organizationCreateOutputSchema, await response.json());
        }
      }
      expect(await evaluationGrants(browser)).toHaveLength(3);
      const organizations = await getAuth().api.listOrganizations({
        headers: browser.headers(),
      });
      expect(organizations).toHaveLength(3);
    });

    test("existing paid access and membership survive exhausted evaluations and do not consume a slot", async () => {
      testState.setConfig("FEATURE_ORG_ACCESS_STATE", false);
      const suffix = Bun.randomUUIDv7();
      const browser = await signInHuman(
        `evaluation-paid-${suffix}@example.test`,
      );
      await using api = serveRoutesForTest(organizationsRoute);
      const paid = await createOrganization({
        api,
        browser,
        key: `${suffix}-paid`,
      });
      const organizationId = brandPersistedOrganizationId(paid.organizationId);
      const periodStart = new Date("2026-01-01T00:00:00.000Z");
      const periodEnd = new Date("2100-01-01T00:00:00.000Z");
      const usagePolicyId = createSafeId<"usagePolicy">();
      await rootDb.insert(usagePolicies).values({
        id: usagePolicyId,
        policyKey: `evaluation-paid-${suffix}`,
        displayName: "Paid evaluation-limit fixture",
        monthlyUsageUnits: 1000,
        serviceActionsPerPeriod: 1000,
      });
      await rootDb.insert(usageEntitlements).values({
        organizationId,
        usagePolicyId,
        source: "hosted",
        status: "active",
        seats: 1,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        hostedEntitlementExternalId: `paid-${suffix}`,
        hostedEntitlementCreatedAt: periodStart,
      });
      const original = await readOriginalOrganizationAccessSnapshot(
        rootDb,
        organizationId,
      );
      await rootDb.insert(organizationConfiguredAccess).values({
        organizationId,
        sourceSignature: JSON.stringify(original ?? null),
        sourceEntitlementCreatedAt: periodStart,
        sourceEntitlementExternalId: `paid-${suffix}`,
        sourceEntitlementStatus: "active",
        sourceCancelAtPeriodEnd: false,
        configuredAccessStatus: "active",
        configuredPeriodEndsAt: periodEnd,
        serviceActionsPerPeriod: 1000,
      });
      const readPaidAccess = async () =>
        await rootDb
          .select()
          .from(organizationConfiguredAccess)
          .where(
            eq(organizationConfiguredAccess.organizationId, organizationId),
          )
          .limit(1);
      testState.setConfig("FEATURE_CONFIGURED_ACCESS", true);
      const effectivePaidAccess = async () =>
        resolveOrganizationAccess({
          snapshot: await readOrganizationAccessSnapshot(
            rootDb,
            organizationId,
          ),
          now: periodStart,
          freeTier: FREE_TIER_OFF,
        });
      const before = await readPaidAccess();
      expect(await effectivePaidAccess()).toEqual({
        type: "paid",
        deadline: periodEnd,
        serviceActionsPerPeriod: 1000,
      });
      expect(before).toHaveLength(1);
      expect(await evaluationGrants(browser)).toHaveLength(0);
      enableEvaluations();
      await createOrganization({ api, browser, key: `${suffix}-first` });
      await createOrganization({ api, browser, key: `${suffix}-second` });
      await createOrganization({ api, browser, key: `${suffix}-third` });
      await expectQuotaRefusal(
        await requestCreation({ api, browser, key: `${suffix}-fourth` }),
      );
      expect(await evaluationGrants(browser)).toHaveLength(3);
      expect(await readPaidAccess()).toEqual(before);
      expect(await effectivePaidAccess()).toEqual({
        type: "paid",
        deadline: periodEnd,
        serviceActionsPerPeriod: 1000,
      });
      const organizations = await getAuth().api.listOrganizations({
        headers: browser.headers(),
      });
      expect(organizations).toHaveLength(4);
      expect(organizations.map(({ id }) => id)).toContain(paid.organizationId);
      await browser.setActiveOrganization(paid.organizationId);
      const activeMember = await getAuth().api.getActiveMember({
        headers: browser.headers(),
      });
      expect(activeMember).toMatchObject({
        organizationId: paid.organizationId,
        userId: browser.userId,
        role: "owner",
      });
    });
  },
);
