import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  featureEnrolments,
  invoiceLines,
  invoices,
  sellerProfiles,
  timeEntries,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import recordInvoicePayment from "@/api/handlers/invoices/payments/create";
import transitionInvoice from "@/api/handlers/invoices/transition";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toNumberPatternScopeKey } from "@/api/lib/billing/number-pattern";
import type { SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { persistSlovakFirmSeed } from "./seed-slovak-firm";
import {
  buildSlovakFirmSeed,
  SLOVAK_SEED_PEOPLE,
} from "./seed-slovak-firm.data";

let rlsFixture: Awaited<ReturnType<typeof getRlsFixture>>;
beforeAll(async () => {
  rlsFixture = await getRlsFixture();
});
afterAll(releaseRlsFixture);

type TransitionContext = Parameters<typeof transitionInvoice.handler>[0];

type TransitionContextOptions = {
  testDb: TestDatabase;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  invoiceId: SafeId<"invoice">;
  action: TransitionContext["body"]["action"];
};

const createTransitionContext = ({
  testDb,
  organizationId,
  userId,
  workspaceId,
  invoiceId,
  action,
}: TransitionContextOptions) => {
  const recordAuditEvent: TransitionContext["recordAuditEvent"] =
    async () => {};
  return asTestRaw<TransitionContext>({
    getActiveWorkspaceIds: async () => [workspaceId],
    getAccessibleWorkspaces: async () => [
      { id: workspaceId, status: "active" },
    ],
    getWorkspaceAccess: async () => ({ id: workspaceId, status: "active" }),
    body: { action },
    createAuditRecorder: () => recordAuditEvent,
    memberRole: sessionMemberRole("owner"),
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    managedAIResidency: "eu",
    promptCachingEnabled: false,
    params: { workspaceId, invoiceId },
    recordAuditEvent,
    request: new Request(`https://example.test/workspaces/${workspaceId}`),
    route:
      "/v1/invoices/:workspaceId/:invoiceId/transition" satisfies ApiRoutePath,
    safeDb: createSafeDb(testDb, [workspaceId], organizationId, userId),
    scopedDb: createScopedDb(testDb, [workspaceId], organizationId, userId),
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
    workspaceId,
  });
};

test("Slovak seeded documents pass actual finalize, send and partial-payment operations", async () => {
  const { testDb, ids } = rlsFixture;
  const now = new Date("2026-10-30T10:15:00Z");
  const fixture = buildSlovakFirmSeed(now);
  await testDb
    .insert(featureEnrolments)
    .values({
      organizationId: ids.orgA,
      userId: ids.userA1,
      featureId: "time-billing",
    })
    .onConflictDoNothing();
  await testDb
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, ids.userA1));
  await testDb
    .insert(sellerProfiles)
    .values({ ...fixture.seller, organizationId: ids.orgA });
  for (const invoice of fixture.invoiceRows) {
    await testDb.insert(invoices).values({
      ...invoice,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      clientId: null,
      status: "draft",
      finalizedAt: null,
      sentAt: null,
      invoiceNumber: invoice.invoiceNumber ?? "SK-2026-0002",
    });
  }
  for (const entry of fixture.time.filter(
    ({ invoiceId }) => invoiceId !== null,
  )) {
    await testDb.insert(timeEntries).values({
      ...entry,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      approverUserId: ids.userA1,
      approvedByUserId: ids.userA1,
    });
  }
  for (const line of fixture.lines) {
    await testDb
      .insert(invoiceLines)
      .values({ ...line, organizationId: ids.orgA, workspaceId: ids.wsA1 });
  }
  const context = (
    invoiceId: TransitionContext["params"]["invoiceId"],
    action: TransitionContext["body"]["action"],
  ) =>
    createTransitionContext({
      testDb,
      organizationId: ids.orgA,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
      invoiceId,
      action,
    });
  for (const invoice of fixture.invoiceRows) {
    const finalized = await transitionInvoice.handler(
      context(invoice.id, "finalize"),
    );
    expect(finalized).toEqual({ id: invoice.id });
    const stored = await testDb.query.invoices.findFirst({
      where: { id: { eq: invoice.id } },
    });
    expect(stored?.status).toBe("finalized");
    expect(stored?.totalAmount).toBe(invoice.totalAmount);
    expect(stored?.netAmount).toBe(invoice.netAmount);
    expect(stored?.vatAmount).toBe(invoice.vatAmount);
    expect(stored?.finalizedAt).toBeInstanceOf(Date);
    const repeated = await transitionInvoice.handler(
      context(invoice.id, "finalize"),
    );
    expect(repeated).toEqual({
      code: 409,
      response: { message: "Cannot finalize invoice from its current status" },
    });
    if (invoice.id !== fixture.payment.invoiceId) {
      continue;
    }
    const sent = await transitionInvoice.handler(context(invoice.id, "send"));
    expect(sent).toEqual({ id: invoice.id });
    const payment = await recordInvoicePayment.handler({
      ...context(invoice.id, "send"),
      route: "/v1/invoices/:workspaceId/:invoiceId/payments",
      body: {
        amount: fixture.payment.amount,
        paidOn: fixture.payment.paidOn,
        method: fixture.payment.method,
        reference: fixture.payment.reference,
        note: null,
      },
    });
    expect(payment).toMatchObject({ amount: fixture.payment.amount });
    const paidInvoice = await testDb.query.invoices.findFirst({
      where: { id: { eq: invoice.id } },
    });
    expect(paidInvoice?.status).toBe("sent");
    expect(paidInvoice?.paidAt).toBeNull();
  }
  await testDb.delete(invoiceLines).where(
    inArray(
      invoiceLines.id,
      fixture.lines.map(({ id }) => id),
    ),
  );
  await testDb.delete(timeEntries).where(
    inArray(
      timeEntries.id,
      fixture.time.map(({ id }) => id),
    ),
  );
  await testDb.delete(invoices).where(
    inArray(
      invoices.id,
      fixture.invoiceRows.map(({ id }) => id),
    ),
  );
  await testDb
    .delete(sellerProfiles)
    .where(eq(sellerProfiles.id, fixture.seller.id));
}, 120_000); // timeout: measured PGlite schema setup and billing transitions take up to 9 seconds per test.

test("Slovak persistence converges when the seed is replayed", async () => {
  const { testDb, ids } = rlsFixture;
  await testDb
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, ids.userA1));
  const now = new Date("2026-10-30T10:15:00Z");
  const fixture = buildSlovakFirmSeed(now);
  await testDb.insert(organization).values({
    id: fixture.organizationId,
    name: fixture.seller.legalName,
    slug: "slovak-replay-fixture",
    createdAt: now,
  });
  await testDb.transaction(async (tx) =>
    recordNewOrganizationAccessState(tx, {
      organizationId: fixture.organizationId,
      now,
    }),
  );
  for (const person of SLOVAK_SEED_PEOPLE) {
    await testDb.insert(user).values({
      id: person.id,
      name: person.name,
      email: person.email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await testDb.insert(member).values({
      id: `member-${person.id}`,
      organizationId: fixture.organizationId,
      userId: person.id,
      role: person.role,
      createdAt: now,
    });
  }
  await testDb.insert(member).values({
    id: "member-primary-slovak-replay",
    organizationId: fixture.organizationId,
    userId: ids.userA1,
    role: "owner",
    createdAt: now,
  });
  for (let replay = 0; replay < 2; replay++) {
    await testDb.transaction(async (tx) =>
      persistSlovakFirmSeed(tx, { fixture, primaryUserId: ids.userA1 }),
    );
    const storedTime = await testDb.query.timeEntries.findMany({
      where: { organizationId: { eq: fixture.organizationId } },
    });
    const storedInvoices = await testDb.query.invoices.findMany({
      where: { organizationId: { eq: fixture.organizationId } },
    });
    const storedPayments = await testDb.query.invoicePayments.findMany({
      where: { organizationId: { eq: fixture.organizationId } },
    });
    const storedTimers = await testDb.query.timeTimers.findMany({
      where: { organizationId: { eq: fixture.organizationId } },
    });
    expect(storedTime).toHaveLength(fixture.time.length);
    expect(storedInvoices).toHaveLength(2);
    expect(storedPayments).toHaveLength(1);
    expect(storedTimers).toHaveLength(1);
    expect(storedPayments.at(0)?.amount).toBe(fixture.payment.amount);
    expect(storedTime.map(({ dateWorked }) => dateWorked).toSorted()).toEqual(
      fixture.time.map(({ dateWorked }) => dateWorked).toSorted(),
    );
  }
  const submitted = fixture.time.find(({ status }) => status === "submitted");
  const untouched = fixture.time.find(
    ({ status, returnedAt, invoiceId, billable }) =>
      status === "draft" &&
      returnedAt === null &&
      invoiceId === null &&
      billable,
  );
  const originalIssued = fixture.invoiceRows.find(
    ({ status }) => status === "sent",
  );
  if (
    submitted === undefined ||
    untouched === undefined ||
    originalIssued?.invoiceNumber === undefined ||
    originalIssued.invoiceNumber === null ||
    originalIssued.finalizedAt === null
  ) {
    panic(
      "Slovak replay fixture requires submitted time, untouched draft time and an issued invoice",
    );
  }
  await testDb
    .update(timeEntries)
    .set({ status: "approved", approvedByUserId: ids.userA1, approvedAt: now })
    .where(eq(timeEntries.id, submitted.id));
  const later = buildSlovakFirmSeed(new Date("2027-02-05T10:15:00Z"));
  const discardedInvoice = later.invoiceRows.find(
    ({ status }) => status === "sent",
  );
  if (
    discardedInvoice?.finalizedAt === undefined ||
    discardedInvoice.finalizedAt === null
  ) {
    panic("Slovak replay fixture requires an issued invoice");
  }
  expect(discardedInvoice.invoiceNumber).not.toBe(originalIssued.invoiceNumber);
  expect(later.today).not.toBe(untouched.dateWorked);
  await testDb.transaction(async (tx) =>
    persistSlovakFirmSeed(tx, { fixture: later, primaryUserId: ids.userA1 }),
  );
  const reviewed = await testDb.query.timeEntries.findFirst({
    where: { id: { eq: submitted.id } },
  });
  expect(reviewed?.status).toBe("approved");
  expect(reviewed?.approvedByUserId).toBe(ids.userA1);
  expect(reviewed?.approvedAt).toEqual(now);
  expect(reviewed?.dateWorked).toBe(submitted.dateWorked);
  const refreshed = await testDb.query.timeEntries.findFirst({
    where: { id: { eq: untouched.id } },
  });
  expect(refreshed?.dateWorked).toBe(later.today);
  const retainedInvoice = await testDb.query.invoices.findFirst({
    where: { id: { eq: originalIssued.id } },
  });
  expect(retainedInvoice?.invoiceDate).toBe(originalIssued.invoiceDate);
  expect(retainedInvoice?.finalizedAt).toEqual(originalIssued.finalizedAt);
  expect(retainedInvoice?.invoiceNumber).toBe(originalIssued.invoiceNumber);
  const allocations = await testDb.query.numberSeriesAllocations.findMany({
    where: { organizationId: { eq: fixture.organizationId } },
  });
  expect(allocations.map(({ number }) => number)).toEqual([
    originalIssued.invoiceNumber,
  ]);
  expect(allocations.at(0)?.issuedAt).toEqual(originalIssued.finalizedAt);
  const counters = await testDb.query.numberSeriesCounters.findMany({
    where: { organizationId: { eq: fixture.organizationId } },
  });
  expect(counters).toHaveLength(1);
  expect(counters.map(({ periodKey }) => periodKey)).not.toContain(
    toNumberPatternScopeKey({
      pattern: "SK-{YYYY}-{SEQ}",
      now: discardedInvoice.finalizedAt,
      timeZone: "UTC",
    }),
  );
  const draft = fixture.invoiceRows.find(({ status }) => status === "draft");
  expect(draft).toBeDefined();
  if (draft?.workspaceId === undefined) {
    panic("Slovak seed must contain a draft attached to its original matter");
  }
  const before = await testDb.query.invoices.findFirst({
    where: { id: { eq: draft.id } },
  });
  expect(before?.invoiceNumber).toBeNull();
  const finalized = await transitionInvoice.handler(
    createTransitionContext({
      testDb,
      organizationId: fixture.organizationId,
      userId: ids.userA1,
      workspaceId: draft.workspaceId,
      invoiceId: draft.id,
      action: "finalize",
    }),
  );
  expect(finalized).toEqual({ id: draft.id });
  const issued = await testDb.query.invoices.findFirst({
    where: { id: { eq: draft.id } },
  });
  expect(issued?.status).toBe("finalized");
  expect(issued?.invoiceNumber).toBe("SK-2026-0002");
  expect(issued?.sellerProfileId).toBe(fixture.seller.id);
  expect(issued?.workspaceId).toBe(draft.workspaceId);
  expect(issued?.organizationId).toBe(fixture.organizationId);
  expect(issued?.netAmount).toBe(draft.netAmount);
  expect(issued?.totalAmount).toBe(draft.totalAmount);
  expect(issued?.vatAmount).toBe(cents(0));
  const storedLines = await testDb.query.invoiceLines.findMany({
    where: { invoiceId: { eq: draft.id } },
  });
  expect(storedLines.map(({ vatTreatment }) => vatTreatment)).toEqual([
    "reverse_charge",
  ]);
}, 120_000); // timeout: measured PGlite schema setup and billing transitions take up to 9 seconds per test.
