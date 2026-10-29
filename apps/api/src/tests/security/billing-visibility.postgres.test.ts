import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { parseTimeEntryListPage } from "@stll/api-contract/time-entries";
import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import { memberHasPermissions } from "@stll/permissions";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  contacts,
  entities,
  expenses,
  featureEnrolments,
  invoices,
  timeEntries,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import createContact from "@/api/handlers/contacts/create";
import getContact from "@/api/handlers/contacts/get";
import updateContact from "@/api/handlers/contacts/update";
import listExpenses from "@/api/handlers/expenses/list";
import listInvoices from "@/api/handlers/invoices/list";
import setBillingAccess from "@/api/handlers/organization-settings/members/billing-access/update";
import listApprovalQueue from "@/api/handlers/time-entries/approval-queue/list";
import getTimeEntry from "@/api/handlers/time-entries/get";
import listTimeEntries from "@/api/handlers/time-entries/list";
import { checkHandlerConfigurationAdmission } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { resolveMemberAuthorization } from "@/api/lib/auth";
import { moneyPaths } from "@/api/lib/billing/money-response";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import {
  authorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { isRecord } from "@/api/lib/type-guards";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolOutputContract,
} from "@/api/mcp/static-tool-definitions";
import { hasMcpToolAuthority } from "@/api/mcp/write-tool-authority";
import { apiApp } from "@/api/server";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_AUDIT,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { writeScalingViolations } from "@/api/tests/read-scaling/measurement";
import {
  memberBillingScalingScenario,
  seedMemberBillingScaling,
} from "@/api/tests/read-scaling/member-billing-access";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const RATE = cents(12_345);
const DAY = "2026-10-01";

const createFixture = () => {
  const organizationId = mintAuthProviderId<"organization">();
  const otherOrganizationId = mintAuthProviderId<"organization">();
  const workspaceId = createSafeId<"workspace">();
  const otherWorkspaceId = createSafeId<"workspace">();
  const foreignEntryId = createSafeId<"timeEntry">();
  const actors = ORGANIZATION_ROLE_NAMES.flatMap((role) =>
    (role === "member" ? [false, true] : [false]).map((billingAccess) => ({
      role,
      billingAccess,
      memberId: mintAuthProviderIdValue(),
      userId: mintAuthProviderId<"user">(),
      entryId: createSafeId<"timeEntry">(),
    })),
  );
  const contactId = createSafeId<"contact">();
  const owner =
    actors.find(({ role }) => role === "owner") ??
    panic("Owner fixture missing");
  return {
    organizationId,
    otherOrganizationId,
    workspaceId,
    otherWorkspaceId,
    foreignEntryId,
    contactId,
    actors,
    owner,
  };
};

type Fixture = ReturnType<typeof createFixture>;
type Actor = Fixture["actors"][number];

const seedFixture = async (db: GatedTestDb, fixture: Fixture) => {
  const {
    organizationId,
    otherOrganizationId,
    workspaceId,
    otherWorkspaceId,
    foreignEntryId,
    contactId,
    actors,
    owner,
  } = fixture;
  await db.insert(organization).values(
    [organizationId, otherOrganizationId].map((id) => ({
      id,
      name: "Billing permission fixture",
      slug: id,
      createdAt: new Date(),
    })),
  );
  await recordNewOrganizationAccessState(db, {
    organizationId,
    now: new Date(),
  });
  await recordNewOrganizationAccessState(db, {
    organizationId: otherOrganizationId,
    now: new Date(),
  });
  await db.insert(user).values(
    actors.map(({ userId }) => ({
      id: userId,
      name: "Billing reader",
      email: `${userId}@example.test`,
      emailVerified: true,
    })),
  );
  await db.insert(member).values(
    actors.map(({ role, userId, billingAccess, memberId }) => ({
      id: memberId,
      billingAccess,
      organizationId,
      userId,
      role,
      createdAt: new Date(),
    })),
  );
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId: otherOrganizationId,
    userId: owner.userId,
    role: "owner",
    createdAt: new Date(),
  });
  await db.insert(featureEnrolments).values(
    actors.map(({ userId }) => ({
      organizationId,
      userId,
      featureId: "time-billing" as const,
    })),
  );
  await db.insert(workspaces).values([
    {
      id: workspaceId,
      organizationId,
      name: "Billing matter",
      reference: workspaceId,
    },
    {
      id: otherWorkspaceId,
      organizationId: otherOrganizationId,
      name: "Other matter",
      reference: otherWorkspaceId,
    },
  ]);
  await db
    .insert(workspaceMembers)
    .values(actors.map(({ userId }) => ({ workspaceId, userId })));
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: otherWorkspaceId, userId: owner.userId });
  await db.insert(timeEntries).values({
    id: foreignEntryId,
    organizationId: otherOrganizationId,
    workspaceId: otherWorkspaceId,
    userId: owner.userId,
    dateWorked: DAY,
    timezoneId: "UTC",
    durationMinutes: 60,
    billedMinutes: 60,
    rateAtEntry: RATE,
    currency: "USD",
    narrative: "Other organization work",
  });
  await db.insert(timeEntries).values(
    actors.map(({ userId, entryId }) => ({
      id: entryId,
      organizationId,
      workspaceId,
      userId,
      dateWorked: DAY,
      timezoneId: "UTC",
      durationMinutes: 60,
      billedMinutes: 60,
      rateAtEntry: RATE,
      currency: "USD",
      narrative: "Recorded work",
      status: "submitted" as const,
      approverUserId: userId,
    })),
  );
  const expenseContextId = createSafeId<"entity">();
  await db.insert(entities).values({
    id: expenseContextId,
    workspaceId,
    kind: "task",
    name: "Expense context",
    createdBy: owner.userId,
  });
  await db.insert(expenses).values({
    id: createSafeId<"expense">(),
    organizationId,
    workspaceId,
    userId: owner.userId,
    matterId: expenseContextId,
    dateIncurred: DAY,
    amount: RATE,
    currency: "USD",
    category: "other",
    description: "Recorded expense",
  });
  await db.insert(invoices).values({
    id: createSafeId<"invoice">(),
    organizationId,
    workspaceId,
    invoiceDate: DAY,
    currency: "USD",
    totalAmount: RATE,
  });
  await db.insert(contacts).values({
    id: contactId,
    organizationId,
    type: "person",
    displayName: "Rate contact",
    defaultHourlyRate: RATE,
    currency: "USD",
  });
};

type ActorContextOptions = { db: GatedTestDb; fixture: Fixture; actor: Actor };
const contextForActor = async ({
  db,
  fixture: { organizationId, workspaceId },
  actor,
}: ActorContextOptions) => {
  const membership = await resolveMemberAuthorization(
    { organizationId, userId: actor.userId },
    db,
  );
  if (!membership) {
    return panic("Fixture membership missing");
  }
  return createTestHandlerContext({
    audit: NO_AUDIT,
    safeDb: createSafeDb(
      markRlsDatabase(db),
      [workspaceId],
      organizationId,
      actor.userId,
    ),
    scopedDb: createScopedDb(
      markRlsDatabase(db),
      [workspaceId],
      organizationId,
      actor.userId,
    ),
    workspaceId,
    session: { activeOrganizationId: organizationId },
    user: { id: actor.userId },
    memberRole: sessionMemberRole(actor.role, membership.billingAccess),
    body: {},
    query: {},
    params: { workspaceId },
    getWorkspaceAccess: async () => ({
      id: workspaceId,
      status: "active" as const,
    }),
    getActiveWorkspaceIds: async () => [workspaceId],
    getAccessibleWorkspaces: async () => [
      { id: workspaceId, status: "active" as const },
    ],
  });
};

const assertContactAndExpenseVisibility = async ({
  db,
  fixture,
  actor,
}: ActorContextOptions) => {
  const base = await contextForActor({ db, fixture, actor });
  const monetary =
    actor.billingAccess || actor.role === "owner" || actor.role === "admin";
  const { contactId } = fixture;
  const contact = await getContact.handler(
    asTestRaw({ ...base, params: { contactId } }),
  );
  expect(contact, actor.role).toMatchObject({
    id: contactId,
    defaultHourlyRate: monetary ? RATE : null,
  });
  const expenseResult = await listExpenses.handler(asTestRaw(base));
  expect(expenseResult, actor.role).toMatchObject(
    monetary ? { items: [{ amount: RATE }] } : { code: 403 },
  );
  if (monetary) {
    return;
  }
  const created = await createContact.handler(
    asTestRaw({
      ...base,
      body: {
        id: createSafeId<"contact">(),
        type: "person",
        displayName: "Priced contact",
        defaultHourlyRate: RATE,
      },
    }),
  );
  expect(created, actor.role).toMatchObject({ code: 403 });
  for (const body of [{ defaultHourlyRate: RATE }, { currency: "EUR" }]) {
    const updated = await updateContact.handler(
      asTestRaw({ ...base, params: { contactId }, body }),
    );
    expect(updated, actor.role).toMatchObject({ code: 403 });
  }
};

const assertMonetaryAdmission = async ({
  db,
  fixture,
  actor,
}: ActorContextOptions) => {
  const context = await contextForActor({ db, fixture, actor });
  const monetary =
    actor.billingAccess || actor.role === "owner" || actor.role === "admin";
  let routes = 0;
  for (const { definition, path } of apiApp.routes) {
    const config = asTestRaw<HandlerConfig>(definition.config);
    if (
      config.access !== "read" ||
      !config.permissions?.billing?.includes("read")
    ) {
      continue;
    }
    routes += 1;
    expect(
      checkHandlerConfigurationAdmission({
        principal: {
          memberRole: context.memberRole,
          readEmail: () => context.user.email,
        },
        config,
      }),
      path,
    ).toBe(
      monetary &&
        memberHasPermissions({
          role: actor.role,
          billingAccess: true,
          permissions: config.permissions,
        })
        ? "allowed"
        : "permission_required",
    );
  }
  expect(routes).toBeGreaterThan(10);
  for (const definition of DEFAULT_MCP_TOOL_DEFINITIONS) {
    const contract = getStaticMcpToolOutputContract(definition.name);
    const paths = moneyPaths(contract?.outputSchemaSource);
    if (
      paths.length === 0 ||
      definition.permissions.type !== "all" ||
      !("billing" in definition.permissions.permissions) ||
      !definition.permissions.permissions.billing?.includes("read")
    ) {
      continue;
    }
    expect(
      hasMcpToolAuthority(
        { memberRole: actor.role, billingAccess: actor.billingAccess },
        definition,
      ),
      definition.name,
    ).toBe(
      monetary &&
        memberHasPermissions({
          role: actor.role,
          billingAccess: true,
          permissions: definition.permissions.permissions,
        }),
    );
  }
};

const assertActorVisibility = async ({
  db,
  fixture,
  actor,
}: ActorContextOptions) => {
  const { workspaceId, otherWorkspaceId, foreignEntryId } = fixture;
  const monetary =
    actor.billingAccess || actor.role === "owner" || actor.role === "admin";
  const base = await contextForActor({ db, fixture, actor });
  const invoiceResult = await listInvoices.handler(asTestRaw(base));
  if (monetary) {
    expect(invoiceResult, actor.role).toMatchObject({
      items: [{ totalAmount: RATE }],
    });
  } else {
    expect(invoiceResult, actor.role).toMatchObject({
      code: 403,
      response: { code: "forbidden" },
    });
  }
  const listResult = await listTimeEntries.handler(
    asTestRaw({ ...base, query: { scope: "me" } }),
  );
  if (actor.role === "external") {
    expect(listResult).toMatchObject({ code: 403 });
    return;
  }
  expect(listResult, actor.role).toMatchObject({
    items: [{ id: actor.entryId, rateAtEntry: monetary ? RATE : null }],
  });
  expect(parseTimeEntryListPage(listResult), actor.role).not.toBeNull();
  const detail = await getTimeEntry.handler(
    asTestRaw({ ...base, params: { workspaceId, id: actor.entryId } }),
  );
  expect(detail, actor.role).toMatchObject({
    id: actor.entryId,
    rateAtEntry: monetary ? RATE : null,
  });
  const queue = await listApprovalQueue.handler(asTestRaw(base));
  expect(isRecord(queue) && Array.isArray(queue.items)).toBe(true);
  if (isRecord(queue) && Array.isArray(queue.items)) {
    expect(queue.items.length).toBeGreaterThan(0);
    for (const item of queue.items) {
      expect(item, actor.role).toMatchObject({
        rateAtEntry: monetary ? RATE : null,
      });
    }
  }
  const attenuated = authorizedMemberRole({
    role: actor.role,
    credential: {
      type: "attenuated",
      permissions: { timeEntry: ["read"] },
    },
  });
  const narrowed = await getTimeEntry.handler(
    asTestRaw({
      ...base,
      memberRole: attenuated,
      params: { workspaceId, id: actor.entryId },
    }),
  );
  expect(narrowed).toMatchObject({
    id: actor.entryId,
    rateAtEntry: null,
  });
  const foreign = await getTimeEntry.handler(
    asTestRaw({
      ...base,
      workspaceId: otherWorkspaceId,
      params: { workspaceId: otherWorkspaceId, id: foreignEntryId },
      getWorkspaceAccess: async () => ({
        id: otherWorkspaceId,
        status: "active" as const,
      }),
    }),
  );
  expect(foreign).toMatchObject({ code: 404 });
};

const assertMemberCannotAddGrant = async (
  db: GatedTestDb,
  fixture: Fixture,
) => {
  const { actors, organizationId, workspaceId } = fixture;
  const ordinaryMember = actors.find(
    ({ role, billingAccess }) => role === "member" && !billingAccess,
  );
  expect(ordinaryMember).toBeDefined();
  if (ordinaryMember) {
    const cannotAddGrant = authorizedMemberRole({
      role: "member",
      credential: {
        type: "attenuated",
        permissions: { timeEntry: ["read"], billing: ["read"] },
      },
    });
    const result = await getTimeEntry.handler(
      asTestRaw(
        createTestHandlerContext({
          audit: NO_AUDIT,
          safeDb: createSafeDb(
            markRlsDatabase(db),
            [workspaceId],
            organizationId,
            ordinaryMember.userId,
          ),
          scopedDb: createScopedDb(
            markRlsDatabase(db),
            [workspaceId],
            organizationId,
            ordinaryMember.userId,
          ),
          workspaceId,
          session: { activeOrganizationId: organizationId },
          user: { id: ordinaryMember.userId },
          memberRole: cannotAddGrant,
          params: { workspaceId, id: ordinaryMember.entryId },
          query: {},
        }),
      ),
    );
    expect(result).toMatchObject({
      id: ordinaryMember.entryId,
      rateAtEntry: null,
    });
  }
};

const assertBillingGrantToggle = async (db: GatedTestDb, fixture: Fixture) => {
  const target =
    fixture.actors.find(
      ({ role, billingAccess }) => role === "member" && !billingAccess,
    ) ?? panic("Member missing");
  const ownerContext = await contextForActor({
    db,
    fixture,
    actor: fixture.owner,
  });
  const recorder = createAuditRecorder({
    organizationId: fixture.organizationId,
    workspaceId: null,
    userId: fixture.owner.userId,
    request: new Request("https://example.test/member-billing-access"),
    server: null,
  });
  for (const billingAccess of [true, false]) {
    const result = await setBillingAccess.handler(
      asTestRaw({
        ...ownerContext,
        recordAuditEvent: recorder,
        params: { memberId: target.memberId },
        body: { billingAccess },
      }),
    );
    expect(result).toEqual({ memberId: target.memberId, billingAccess });
    const [stored] = await db
      .select({ billingAccess: member.billingAccess })
      .from(member)
      .where(
        and(
          eq(member.id, target.memberId),
          eq(member.organizationId, fixture.organizationId),
        ),
      );
    expect(stored).toEqual({ billingAccess });
    const actor = { ...target, billingAccess };
    await assertActorVisibility({ db, fixture, actor });
    await assertContactAndExpenseVisibility({ db, fixture, actor });
    await assertMonetaryAdmission({ db, fixture, actor });
  }
  const ordinary = await contextForActor({ db, fixture, actor: target });
  expect(
    await setBillingAccess.handler(
      asTestRaw({
        ...ordinary,
        params: { memberId: target.memberId },
        body: { billingAccess: true },
      }),
    ),
  ).toMatchObject({ code: 403 });
};

const cleanUpFixture = async (db: GatedTestDb, fixture: Fixture) => {
  const {
    organizationId,
    otherOrganizationId,
    workspaceId,
    otherWorkspaceId,
    actors,
  } = fixture;
  await db
    .delete(expenses)
    .where(
      inArray(expenses.organizationId, [organizationId, otherOrganizationId]),
    );
  await db
    .delete(invoices)
    .where(
      inArray(invoices.organizationId, [organizationId, otherOrganizationId]),
    );
  await db
    .delete(timeEntries)
    .where(
      inArray(timeEntries.organizationId, [
        organizationId,
        otherOrganizationId,
      ]),
    );
  await db
    .delete(workspaces)
    .where(inArray(workspaces.id, [workspaceId, otherWorkspaceId]));
  await db
    .delete(organization)
    .where(inArray(organization.id, [organizationId, otherOrganizationId]));
  await db.delete(user).where(
    inArray(
      user.id,
      actors.map(({ userId }) => userId),
    ),
  );
};

if (!databaseUrl || !runPostgres) {
  describe.skip("billing visibility (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {
      expect(databaseUrl).toBeDefined();
    });
  });
} else {
  test("real scoped reads separate monetary authority, own time, and organization scope", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const fixture = createFixture();
      try {
        await seedFixture(db, fixture);
        for (const actor of fixture.actors) {
          await assertActorVisibility({ db, fixture, actor });
          await assertContactAndExpenseVisibility({ db, fixture, actor });
          await assertMonetaryAdmission({ db, fixture, actor });
        }
        await assertMemberCannotAddGrant(db, fixture);
        await assertBillingGrantToggle(db, fixture);
      } finally {
        await cleanUpFixture(db, fixture);
      }
    });
  });
  test("billing grant assignment keeps database work fixed at 10 and 200 members", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const small = await seedMemberBillingScaling(db, 10);
      const large = await seedMemberBillingScaling(db, 200);
      try {
        const at10 = await memberBillingScalingScenario.measure(small);
        const at200 = await memberBillingScalingScenario.measure(large);
        expect(at10.statements).toBeGreaterThan(0);
        expect(at10.transactionRoundTrips).toBeGreaterThan(0);
        expect(writeScalingViolations({ small: at10, large: at200 })).toEqual(
          [],
        );
        console.info("billing-grant-scaling", JSON.stringify({ at10, at200 }));
      } finally {
        await small.cleanup();
        await large.cleanup();
      }
    });
  });
}
