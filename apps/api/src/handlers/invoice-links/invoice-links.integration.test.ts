import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { INVOICE_LINE_SOURCE } from "@stll/api-contract";
import { buildCzechQrPaymentPayload, variableSymbolOf } from "@stll/invoicing";
import { sha256Hex } from "@stll/sha256/bun";

import { member, user as authUser } from "@/api/db/auth-schema";
import {
  auditLogs,
  featureEnrolments,
  INVOICE_PAYMENT_ORIGIN,
  INVOICE_STATUS,
  invoiceLines,
  invoicePayments,
  invoices,
  invoiceSends,
  sellerProfiles,
} from "@/api/db/schema";
import type { InvoiceStatus } from "@/api/db/schema";
import {
  createSafeDb,
  createScopedDb,
  createTenantlessDb,
} from "@/api/db/scoped";
import { loadLinkedInvoiceData } from "@/api/handlers/invoice-links/document";
import { createDownloadInvoiceLinkFile } from "@/api/handlers/invoice-links/download";
import { buildLinkedEInvoice } from "@/api/handlers/invoice-links/e-invoice";
import { parseInvoiceLinkInvoiceRow } from "@/api/handlers/invoice-links/function-rows";
import { invoiceLinksRoute } from "@/api/handlers/invoice-links/routes";
import { createViewInvoiceLink } from "@/api/handlers/invoice-links/view";
import readInvoiceById from "@/api/handlers/invoices/get";
import type { InvoiceLinkMessage } from "@/api/handlers/invoices/sends/create";
import { createSendInvoice } from "@/api/handlers/invoices/sends/create";
import listInvoiceSends from "@/api/handlers/invoices/sends/list";
import revokeInvoiceSend from "@/api/handlers/invoices/sends/revoke";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditEvent } from "@/api/lib/audit-log";
import { INVOICE_DOCUMENT_PROJECTION } from "@/api/lib/billing/invoice-detail";
import {
  loadInvoiceExport,
  toExportRecords,
} from "@/api/lib/billing/invoice-export-records";
import { invoiceLinkResponsePolicy } from "@/api/lib/billing/invoice-link-response-policy";
import {
  createInvoiceLinkToken,
  hashInvoiceLinkToken,
  resolveInvoiceLink,
} from "@/api/lib/billing/invoice-links";
import type { InvoicePdfRenderer } from "@/api/lib/billing/invoice-pdf/document";
import { createInvoiceFormatters } from "@/api/lib/billing/invoice-pdf/render-helpers";
import { qrSvg } from "@/api/lib/billing/invoice-pdf/typst/data";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  createInvoiceLinkTokenAdmission,
  INVOICE_LINK_TOKEN_BUDGET,
} from "@/api/lib/rate-limit/invoice-link-admission";
import {
  InMemoryRateLimitContext,
  isRateLimitMiddleware,
  rateLimit,
  scopedGenerator,
} from "@/api/lib/rate-limit/rate-limit";
import type { TokenScopedDatabase } from "@/api/lib/root-scoped-db";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { serveForTest } from "@/api/tests/helpers/test-server";
import type { TestServer } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// timeout: the shared PGlite fixture applies every migration on first use.
setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let sellerA: SafeId<"sellerProfile">;
let server: TestServer;
let limitedServer: TestServer;

const seededInvoiceIds: SafeId<"invoice">[] = [];
const seededSellerIds: SafeId<"sellerProfile">[] = [];

/** Every email the send handler hands to the transport. */
const delivered: InvoiceLinkMessage[] = [];
/** Addresses the fake transport refuses. */
const refused = new Set<string>();

const sendInvoice = createSendInvoice({
  deliver: async (message) => {
    if (refused.has(message.to)) {
      throw new Error("Mailbox unavailable");
    }
    delivered.push(message);
  },
  isDeliveryConfigured: () => true,
});

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7 invoice");

const tokenDb = (): TokenScopedDatabase => ({
  scoped: ({ organizationId, userId, workspaceIds }) =>
    asTestRaw<ReturnType<TokenScopedDatabase["scoped"]>>(
      createScopedDb(testDb, workspaceIds, organizationId, userId),
    ),
  tenantless: asTestRaw<TokenScopedDatabase["tenantless"]>(
    createTenantlessDb(testDb),
  ),
});

type LinkRouteOptions = {
  budget: ReturnType<typeof rateLimit>;
  database?: TokenScopedDatabase;
  isAvailable?: () => boolean;
  renderInvoice?: InvoicePdfRenderer;
  buildEInvoice?: typeof buildLinkedEInvoice;
};

/** The production route table's shape, with test doubles for its seams. */
const linkRoutes = ({
  budget,
  database = tokenDb(),
  isAvailable = () => true,
  buildEInvoice = buildLinkedEInvoice,
  renderInvoice = async () =>
    Result.ok({
      status: "rendered" as const,
      pdf: PDF_BYTES,
      compileMs: 1,
      peakRssBytes: 1,
    }),
}: LinkRouteOptions) => {
  const admitToken = createInvoiceLinkTokenAdmission(
    new InMemoryRateLimitContext(),
  );
  return routes(
    {
      "/view": {
        POST: createViewInvoiceLink({
          db: database,
          isAvailable,
          buildEInvoice,
          admitToken,
        }),
      },
      "/download": {
        POST: createDownloadInvoiceLinkFile({
          db: database,
          isAvailable,
          renderInvoice,
          buildEInvoice,
          admitToken,
        }),
      },
    },
    {
      prefix: "/public/invoice-links",
      middleware: [invoiceLinkResponsePolicy, budget],
    },
  );
};

const budgetOf = (max: number) =>
  rateLimit({
    context: new InMemoryRateLimitContext(),
    generator: scopedGenerator("invoice-link-test"),
    duration: 60_000,
    max,
  });

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  await testDb
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [ids.userA1, ids.userB1]));
  await testDb
    .insert(featureEnrolments)
    .values([
      {
        organizationId: ids.orgA,
        userId: ids.userA1,
        featureId: "time-billing",
      },
      {
        organizationId: ids.orgB,
        userId: ids.userB1,
        featureId: "time-billing",
      },
    ])
    .onConflictDoNothing();
  sellerA = createSafeId<"sellerProfile">();
  seededSellerIds.push(sellerA);
  await testDb.insert(sellerProfiles).values({
    id: sellerA,
    organizationId: ids.orgA,
    legalName: "Example Law Office",
    country: "CZ",
    registrationId: "12345678",
    addressLine1: "Example street 1",
    city: "Prague",
    postalCode: "110 00",
    email: "billing@firm.example.test",
    defaultCurrency: "CZK",
    iban: "CZ3301000000000002970297",
  });
  server = serveForTest(
    createHttpApp({
      routes: linkRoutes({ budget: budgetOf(1000) }),
      middleware: [errorBoundary],
    }),
  );
  limitedServer = serveForTest(
    createHttpApp({
      routes: linkRoutes({ budget: budgetOf(2) }),
      middleware: [errorBoundary],
    }),
  );
});

afterAll(async () => {
  try {
    await server.stop();
    await limitedServer.stop();
    if (seededInvoiceIds.length > 0) {
      await testDb
        .delete(invoices)
        .where(inArray(invoices.id, seededInvoiceIds));
    }
    if (seededSellerIds.length > 0) {
      await testDb
        .delete(sellerProfiles)
        .where(inArray(sellerProfiles.id, seededSellerIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

type Tenant = "A" | "B";

/** UUIDv7 ids share their time prefix, so the number takes the random tail. */
const numberOf = (invoiceId: string) => `LINK-${invoiceId.slice(-12)}`;

const tenantOf = (tenant: Tenant) =>
  tenant === "A"
    ? { organizationId: ids.orgA, workspaceId: ids.wsA1, userId: ids.userA1 }
    : { organizationId: ids.orgB, workspaceId: ids.wsB1, userId: ids.userB1 };

const seedInvoice = async ({
  tenant = "A",
  status,
}: {
  tenant?: Tenant;
  status: InvoiceStatus;
}) => {
  const { organizationId, workspaceId } = tenantOf(tenant);
  const invoiceId = createSafeId<"invoice">();
  seededInvoiceIds.push(invoiceId);
  await testDb.insert(invoices).values({
    id: invoiceId,
    organizationId,
    workspaceId,
    invoiceNumber: numberOf(invoiceId),
    invoiceDate: "2026-10-01",
    taxableSupplyDate: "2026-10-01",
    dueDate: "2026-10-15",
    currency: "CZK",
    language: "cs",
    status,
    sellerProfileId: tenant === "A" ? sellerA : null,
    buyerName: "Example Client",
    buyerRegistrationId: "87654321",
    buyerAddressLine1: "Client street 2",
    buyerCity: "Brno",
    buyerPostalCode: "602 00",
    buyerCountry: "CZ",
    finalizedAt: status === INVOICE_STATUS.DRAFT ? null : new Date(),
    netAmount: cents(100_000),
    vatAmount: cents(0),
    totalAmount: cents(100_000),
  });
  await testDb.insert(invoiceLines).values({
    organizationId,
    workspaceId,
    invoiceId,
    position: 0,
    description: "Contract review",
    quantity: "1",
    unit: "h",
    unitPrice: cents(100_000),
    vatRateBps: 0,
    vatTreatment: "not_vat_payer",
    netAmount: cents(100_000),
    vatAmount: cents(0),
    grossAmount: cents(100_000),
    source: INVOICE_LINE_SOURCE.MANUAL,
  });
  return invoiceId;
};

const memberContext = ({
  tenant,
  invoiceId,
  route,
  body = {},
  extraParams = {},
  auditEvents = [],
  senderId,
}: {
  tenant: Tenant;
  invoiceId: SafeId<"invoice">;
  route: ApiRoutePath;
  body?: unknown;
  extraParams?: Record<string, string>;
  auditEvents?: AuditEvent[];
  senderId?: SafeId<"user">;
}) => {
  const { organizationId, workspaceId } = tenantOf(tenant);
  const userId = senderId ?? tenantOf(tenant).userId;
  const recordAuditEvent = async (
    _tx: unknown,
    events: AuditEvent | AuditEvent[],
  ) => {
    auditEvents.push(...(Array.isArray(events) ? events : [events]));
  };
  return {
    getActiveWorkspaceIds: async () => [workspaceId],
    getAccessibleWorkspaces: async () => [
      { id: workspaceId, status: "active" },
    ],
    getWorkspaceAccess: async () => ({ id: workspaceId, status: "active" }),
    params: { workspaceId, invoiceId, ...extraParams },
    query: {},
    body,
    createAuditRecorder: () => recordAuditEvent,
    recordAuditEvent,
    memberRole: sessionMemberRole("owner"),
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    promptCachingEnabled: false,
    request: new Request("https://example.test/invoice/sends", {
      method: "POST",
    }),
    route,
    safeDb: createSafeDb(testDb, [workspaceId], organizationId, userId),
    scopedDb: createScopedDb(testDb, [workspaceId], organizationId, userId),
    session: { id: null, activeOrganizationId: organizationId },
    user: { id: userId, email: `${userId}@member.example.test` },
    workspaceId,
  };
};

const send = async (
  invoiceId: SafeId<"invoice">,
  recipients: string[],
  {
    tenant = "A",
    auditEvents = [],
    senderId,
  }: {
    tenant?: Tenant;
    auditEvents?: AuditEvent[];
    senderId?: SafeId<"user">;
  } = {},
) =>
  await sendInvoice.handler(
    asTestRaw<Parameters<typeof sendInvoice.handler>[0]>(
      memberContext({
        tenant,
        invoiceId,
        route: "/v1/invoices/:workspaceId/:invoiceId/sends",
        body: { recipients, message: "For October." },
        auditEvents,
        ...(senderId === undefined ? {} : { senderId }),
      }),
    ),
  );

const revoke = async (
  invoiceId: SafeId<"invoice">,
  sendId: string,
  tenant: Tenant = "A",
) =>
  await revokeInvoiceSend.handler(
    asTestRaw<Parameters<typeof revokeInvoiceSend.handler>[0]>(
      memberContext({
        tenant,
        invoiceId,
        route: "/v1/invoices/:workspaceId/:invoiceId/sends/:sendId/revoke",
        extraParams: { sendId },
      }),
    ),
  );

/** The token the last email to `to` carried. */
const tokenSentTo = (to: string) => {
  const message = delivered.findLast((candidate) => candidate.to === to);
  const token = message?.link.split("#").at(1);
  if (token === undefined) {
    throw new Error(`No link was emailed to ${to}`);
  }
  return token;
};

const post = async (
  target: TestServer,
  path: "view" | "download",
  body: unknown,
) =>
  await target.fetch(`http://localhost/public/invoice-links/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const sendRows = async (invoiceId: SafeId<"invoice">) =>
  await testDb
    .select()
    .from(invoiceSends)
    .where(eq(invoiceSends.invoiceId, invoiceId));

const createStandaloneLink = async (invoiceId: SafeId<"invoice">) => {
  const token = createInvoiceLinkToken();
  const tokenHash = hashInvoiceLinkToken(token);
  await testDb.insert(invoiceSends).values({
    id: createSafeId<"invoiceSend">(),
    organizationId: ids.orgA,
    invoiceId,
    sentByUserId: ids.userA1,
    recipients: ["settlement@example.test"],
    language: "cs",
    replyTo: "billing@firm.example.test",
    tokenHash,
    expiresAt: new Date(Date.now() + 86_400_000),
    deliveryStatus: "delivered",
  });
  return { token, tokenHash };
};

const addPayment = async (
  invoiceId: SafeId<"invoice">,
  {
    amount,
    paidOn,
    origin = INVOICE_PAYMENT_ORIGIN.RECORDED,
    voided = false,
  }: {
    amount: number;
    paidOn: string;
    origin?: (typeof INVOICE_PAYMENT_ORIGIN)[keyof typeof INVOICE_PAYMENT_ORIGIN];
    voided?: boolean;
  },
) =>
  await testDb.insert(invoicePayments).values({
    id: createSafeId<"invoicePayment">(),
    organizationId: ids.orgA,
    invoiceId,
    amount: cents(amount),
    paidOn,
    method: "bank_transfer",
    origin,
    recordedBy: origin === INVOICE_PAYMENT_ORIGIN.LEGACY ? null : ids.userA1,
    voidedAt: voided ? new Date("2026-10-05T12:00:00.000Z") : null,
    voidedBy: voided ? ids.userA1 : null,
  });

const paidDateOf = (
  result: ReturnType<typeof toExportRecords>,
): string | null => {
  if (result.isErr()) {
    return panic("Expected invoice export records for settlement parity");
  }
  const record = result.value.at(0);
  if (!record) {
    return panic("Expected one invoice export record for settlement parity");
  }
  return record.paidDate;
};

const readPublicAndAuthenticatedPaidDates = async (
  invoiceId: SafeId<"invoice">,
  token: string,
) => {
  const { organizationId, workspaceId, userId } = tenantOf("A");
  const database = tokenDb();
  const scope = await resolveInvoiceLink(database, token);
  if (scope === null) {
    return panic("Expected a resolvable invoice link for settlement parity");
  }
  const linked = await database.scoped({
    organizationId,
    userId: null,
    workspaceIds: scope.workspaceIds,
  })((tx) => loadLinkedInvoiceData(tx, { ...scope, db: database }));
  if (linked === null) {
    return panic("Expected a linked invoice for settlement parity");
  }
  const publicRecords = toExportRecords(linked.exportData, [invoiceId]);
  const authenticated = await database.scoped({
    organizationId,
    userId,
    workspaceIds: [workspaceId],
  })((tx) =>
    loadInvoiceExport(tx, {
      organizationId,
      workspaceId,
      invoiceIds: [invoiceId],
    }),
  );
  const authenticatedRecords = toExportRecords(authenticated, [invoiceId]);
  return {
    publicPaidDate: paidDateOf(publicRecords),
    authenticatedPaidDate: paidDateOf(authenticatedRecords),
  };
};

const readSettlementFunction = async (tenant: Tenant, tokenHash: string) => {
  const { organizationId, workspaceId } = tenantOf(tenant);
  return await tokenDb().scoped({
    organizationId,
    userId: null,
    workspaceIds: [workspaceId],
  })(
    async (tx) =>
      await tx
        .select({
          latest_paid_on: sql`latest_paid_on::text`,
          paid_amount: sql`paid_amount`.mapWith(Number),
        })
        .from(sql`public.invoice_link_settlement(${tokenHash})`),
  );
};

const invoiceStatus = async (invoiceId: SafeId<"invoice">) =>
  (
    await testDb
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
  ).at(0)?.status;

describe("sending an invoice by link", () => {
  test("a member without time-billing enrolment cannot create an invoice link", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    const deliveredBefore = delivered.length;
    const auditEvents: AuditEvent[] = [];
    await testDb
      .delete(featureEnrolments)
      .where(
        and(
          eq(featureEnrolments.organizationId, ids.orgA),
          eq(featureEnrolments.userId, ids.userA1),
          eq(featureEnrolments.featureId, "time-billing"),
        ),
      );
    try {
      // The safe handler resolves the member's feature-access decision before
      // running its callback; no deployment-flag override is involved.
      expect(
        await send(invoiceId, ["not-enrolled@example.test"], { auditEvents }),
      ).toMatchObject({ code: 404 });
      expect(await sendRows(invoiceId)).toEqual([]);
      expect(delivered).toHaveLength(deliveredBefore);
      expect(auditEvents).toEqual([]);
      expect(await invoiceStatus(invoiceId)).toBe(INVOICE_STATUS.FINALIZED);
    } finally {
      await testDb
        .insert(featureEnrolments)
        .values({
          organizationId: ids.orgA,
          userId: ids.userA1,
          featureId: "time-billing",
        })
        .onConflictDoNothing();
    }
  });

  test("emails each recipient a link, replies to the seller, and marks it sent", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    const auditEvents: AuditEvent[] = [];
    const result = await send(
      invoiceId,
      ["client@example.test", "accounts@example.test"],
      {
        auditEvents,
      },
    );

    expect(result).toMatchObject({
      deliveryStatus: "delivered",
      failedRecipients: [],
      replyTo: "billing@firm.example.test",
      invoiceStatus: INVOICE_STATUS.SENT,
    });
    expect(await invoiceStatus(invoiceId)).toBe(INVOICE_STATUS.SENT);
    const emails = delivered.filter((message) =>
      ["client@example.test", "accounts@example.test"].includes(message.to),
    );
    expect(emails.map((message) => message.to).toSorted()).toEqual([
      "accounts@example.test",
      "client@example.test",
    ]);
    for (const email of emails) {
      expect(email.replyTo).toBe("billing@firm.example.test");
      expect(email.lang).toBe("cs");
      expect(email.firmName).toBe("Example Law Office");
      expect(email.message).toBe("For October.");
      expect(email.link).toMatch(/\/invoice-link#[a-f0-9]{64}$/u);
      const link = new URL(email.link);
      expect(link.pathname).toBe("/invoice-link");
      expect(link.search).toBe("");
      expect(link.hash).toMatch(/^#[a-f0-9]{64}$/u);
      expect(`${link.pathname}${link.search}`).not.toContain(
        link.hash.slice(1),
      );
    }
    const [row] = await sendRows(invoiceId);
    const token = tokenSentTo("client@example.test");
    // Only the hash is stored; the raw token never reaches the database.
    expect(row?.tokenHash).toBe(sha256Hex(token));
    expect(row?.tokenHash).not.toBe(token);
    expect(row?.recipients.toSorted()).toEqual([
      "accounts@example.test",
      "client@example.test",
    ]);
    expect(row?.sentByUserId).toBe(ids.userA1);
    expect(auditEvents.map((event) => event.changes)).toContainEqual({
      sentTo: {
        old: null,
        new: ["client@example.test", "accounts@example.test"],
      },
    });
    expect(auditEvents.map((event) => event.changes)).toContainEqual({
      status: { old: INVOICE_STATUS.FINALIZED, new: INVOICE_STATUS.SENT },
      action: { old: null, new: "send" },
    });
  });

  test("sending a zero-total invoice settles it and resending preserves its first sent time", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    await testDb
      .update(invoices)
      .set({ netAmount: cents(0), totalAmount: cents(0) })
      .where(eq(invoices.id, invoiceId));
    expect(await send(invoiceId, ["zero@example.test"])).toMatchObject({
      invoiceStatus: INVOICE_STATUS.PAID,
      deliveryStatus: "delivered",
    });
    const first = await testDb.query.invoices.findFirst({
      where: { id: { eq: invoiceId } },
    });
    expect(first?.status).toBe(INVOICE_STATUS.PAID);
    expect(first?.sentAt).toBeInstanceOf(Date);
    expect(await send(invoiceId, ["zero-again@example.test"])).toMatchObject({
      invoiceStatus: INVOICE_STATUS.PAID,
    });
    const again = await testDb.query.invoices.findFirst({
      where: { id: { eq: invoiceId } },
    });
    expect(again?.sentAt).toEqual(first?.sentAt);
    expect(await sendRows(invoiceId)).toHaveLength(2);
  });

  test("never sends a draft or a void invoice", async () => {
    for (const status of [INVOICE_STATUS.DRAFT, INVOICE_STATUS.VOID]) {
      const invoiceId = await seedInvoice({ status });
      const before = delivered.length;
      expect(await send(invoiceId, ["client@example.test"])).toMatchObject({
        code: 409,
        response: { code: "invoice_not_sendable" },
      });
      expect(delivered.length).toBe(before);
      expect(await sendRows(invoiceId)).toEqual([]);
    }
  });

  test("records refused recipients, and a send that reached nobody revokes its link", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    refused.add("bounce@example.test");
    refused.add("bounce-too@example.test");
    try {
      expect(
        await send(invoiceId, ["bounce@example.test", "partial@example.test"]),
      ).toMatchObject({
        deliveryStatus: "partial",
        failedRecipients: ["bounce@example.test"],
      });
      const failed = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
      expect(await send(failed, ["bounce-too@example.test"])).toMatchObject({
        code: 502,
      });
      const [row] = await sendRows(failed);
      expect(row?.deliveryStatus).toBe("failed");
      expect(row?.revokedAt).not.toBeNull();
      expect(await invoiceStatus(failed)).toBe(INVOICE_STATUS.FINALIZED);
    } finally {
      refused.clear();
    }
  });

  test("limits sends per invoice", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await send(invoiceId, ["repeat@example.test"])).toMatchObject({
        deliveryStatus: "delivered",
      });
    }
    const before = delivered.length;
    expect(await send(invoiceId, ["repeat@example.test"])).toMatchObject({
      code: 429,
      response: { code: "invoice_send_limit" },
    });
    expect(delivered.length).toBe(before);
    expect(await sendRows(invoiceId)).toHaveLength(5);
  });

  test("limits sends per organization, counting every invoice of it", async () => {
    const busy = await seedInvoice({
      tenant: "B",
      status: INVOICE_STATUS.SENT,
    });
    await testDb.insert(invoiceSends).values(
      Array.from({ length: 200 }, () => ({
        id: createSafeId<"invoiceSend">(),
        organizationId: ids.orgB,
        invoiceId: busy,
        sentByUserId: ids.userB1,
        recipients: ["earlier@example.test"],
        language: "cs" as const,
        replyTo: "b@example.test",
        tokenHash: sha256Hex(Bun.randomUUIDv7()),
        expiresAt: new Date(Date.now() + 86_400_000),
        deliveryStatus: "delivered" as const,
      })),
    );
    const next = await seedInvoice({
      tenant: "B",
      status: INVOICE_STATUS.FINALIZED,
    });
    expect(
      await send(next, ["client-b@example.test"], { tenant: "B" }),
    ).toMatchObject({
      code: 429,
      response: { code: "invoice_send_limit" },
    });
    expect(await sendRows(next)).toEqual([]);
    // The other suites send for this organization too.
    await testDb.delete(invoiceSends).where(eq(invoiceSends.invoiceId, busy));
  });

  test("refuses when this server cannot send email", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    const unconfigured = createSendInvoice({
      deliver: async () => {},
      isDeliveryConfigured: () => false,
    });
    expect(
      await unconfigured.handler(
        asTestRaw<Parameters<typeof unconfigured.handler>[0]>(
          memberContext({
            tenant: "A",
            invoiceId,
            route: "/v1/invoices/:workspaceId/:invoiceId/sends",
            body: { recipients: ["client@example.test"] },
          }),
        ),
      ),
    ).toMatchObject({ code: 503, response: { code: "email_unavailable" } });
    expect(await sendRows(invoiceId)).toEqual([]);
  });

  test("lists the sends with the client's addresses to start from", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    await send(invoiceId, ["listed@example.test"]);
    const listed = await listInvoiceSends.handler(
      asTestRaw<Parameters<typeof listInvoiceSends.handler>[0]>(
        memberContext({
          tenant: "A",
          invoiceId,
          route: "/v1/invoices/:workspaceId/:invoiceId/sends",
        }),
      ),
    );
    expect(listed).toMatchObject({
      replyTo: "billing@firm.example.test",
      sends: [
        {
          recipients: ["listed@example.test"],
          linkStatus: "active",
          deliveryStatus: "delivered",
          firstViewedAt: null,
          sentBy: { id: ids.userA1 },
        },
      ],
    });
  });
});

describe("invoice send row security", () => {
  test("the app role cannot insert or update an organization A send to reference an organization B invoice", async () => {
    const ownInvoice = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    const foreignInvoice = await seedInvoice({
      tenant: "B",
      status: INVOICE_STATUS.FINALIZED,
    });
    await send(ownInvoice, ["tenant-fence@example.test"]);
    const [existing] = await sendRows(ownInvoice);
    expect(existing).toBeDefined();
    if (existing === undefined) {
      return panic("Expected the recorded invoice send");
    }
    const own = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
    const inserted = await own(
      async (tx) =>
        await tx.insert(invoiceSends).values({
          id: createSafeId<"invoiceSend">(),
          organizationId: ids.orgA,
          invoiceId: foreignInvoice,
          recipients: ["foreign@example.test"],
          language: "cs",
          replyTo: "billing@firm.example.test",
          tokenHash: sha256Hex(createSafeId<"invoiceSend">()),
          expiresAt: existing.expiresAt,
        }),
    );
    expect(inserted.isErr()).toBe(true);
    const updated = await own(
      async (tx) =>
        await tx
          .update(invoiceSends)
          .set({ invoiceId: foreignInvoice })
          .where(eq(invoiceSends.id, existing.id)),
    );
    expect(updated.isErr()).toBe(true);
    expect(await sendRows(foreignInvoice)).toEqual([]);
    expect(await sendRows(ownInvoice)).toHaveLength(1);
  });

  test("a send is visible only with its invoice, and the app role cannot delete one", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    await send(invoiceId, ["rls@example.test"]);
    const readAs = async (
      workspaceId: SafeId<"workspace">,
      userId: SafeId<"user">,
    ) =>
      await createScopedDb(
        testDb,
        [workspaceId],
        ids.orgA,
        userId,
      )(
        async (tx) =>
          await tx
            .select({ id: invoiceSends.id })
            .from(invoiceSends)
            .where(eq(invoiceSends.invoiceId, invoiceId)),
      );
    expect(await readAs(ids.wsA1, ids.userA1)).toHaveLength(1);
    // Another matter's member reaches neither the invoice nor its sends.
    expect(await readAs(ids.wsA2, ids.userA2)).toEqual([]);
    const deleted = await createScopedDb(
      testDb,
      [ids.wsA1],
      ids.orgA,
      ids.userA1,
    )(
      async (tx) =>
        await Result.tryPromise(
          async () =>
            await tx
              .delete(invoiceSends)
              .where(eq(invoiceSends.invoiceId, invoiceId))
              .returning({ id: invoiceSends.id }),
        ),
    );
    expect(deleted.isOk() ? deleted.value : []).toEqual([]);
    expect(await sendRows(invoiceId)).toHaveLength(1);
  });
});

describe("opening an invoice link", () => {
  test("view and both downloads share one token budget while another link remains available", async () => {
    const own = await sentInvoice("shared-token-budget@example.test");
    const other = await sentInvoice("independent-token-budget@example.test");
    await using target = serveForTest(
      createHttpApp({
        routes: linkRoutes({ budget: budgetOf(1000) }),
        middleware: [errorBoundary],
      }),
    );
    const operations = ["view", "pdf", "e_invoice"] as const;
    for (let attempt = 0; attempt < INVOICE_LINK_TOKEN_BUDGET.max; attempt++) {
      const operation = operations[attempt % operations.length];
      const response =
        operation === "view"
          ? await post(target, "view", { token: own.token })
          : await post(target, "download", {
              token: own.token,
              file: operation,
            });
      expect(response.status).toBe(200);
    }
    for (const operation of operations) {
      const response =
        operation === "view"
          ? await post(target, "view", { token: own.token })
          : await post(target, "download", {
              token: own.token,
              file: operation,
            });
      expect(response.status).toBe(429);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
    expect((await post(target, "view", { token: other.token })).status).toBe(
      200,
    );
  });

  test("repeated unknown-token lookups cool down before another database lookup", async () => {
    const database = tokenDb();
    let lookups = 0;
    const measuredDatabase = {
      scoped: database.scoped,
      tenantless: async (read) => {
        lookups += 1;
        return await database.tenantless(read);
      },
    } satisfies TokenScopedDatabase;
    await using target = serveForTest(
      createHttpApp({
        routes: linkRoutes({
          budget: budgetOf(1000),
          database: measuredDatabase,
        }),
        middleware: [errorBoundary],
      }),
    );
    const token = createInvoiceLinkToken();
    for (let attempt = 0; attempt < INVOICE_LINK_TOKEN_BUDGET.max; attempt++) {
      expect((await post(target, "view", { token })).status).toBe(404);
    }
    expect(lookups).toBe(INVOICE_LINK_TOKEN_BUDGET.max);
    for (const file of ["pdf", "e_invoice"]) {
      expect((await post(target, "download", { token, file })).status).toBe(
        429,
      );
    }
    expect(lookups).toBe(INVOICE_LINK_TOKEN_BUDGET.max);
    expect(
      (await post(target, "view", { token: createInvoiceLinkToken() })).status,
    ).toBe(404);
    expect(lookups).toBe(INVOICE_LINK_TOKEN_BUDGET.max + 1);
  });

  test("send, view, downloads and refused lookups keep plaintext tokens out of telemetry and audits", async () => {
    const logs = installRecordingLogger();
    const analytics = installRecordingAnalytics();
    try {
      const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
      const auditEvents: AuditEvent[] = [];
      expect(
        await send(invoiceId, ["token-secrecy@example.test"], { auditEvents }),
      ).toMatchObject({ deliveryStatus: "delivered" });
      const token = tokenSentTo("token-secrecy@example.test");
      expect((await post(server, "view", { token })).status).toBe(200);
      for (const file of ["pdf", "e_invoice"]) {
        expect((await post(server, "download", { token, file })).status).toBe(
          200,
        );
      }
      const [sendRow] = await sendRows(invoiceId);
      if (sendRow === undefined) {
        return panic("Expected send history for token secrecy coverage");
      }
      expect(await revoke(invoiceId, sendRow.id)).toMatchObject({
        revokedAt: expect.any(String),
      });
      expect((await post(server, "view", { token })).status).toBe(404);
      expect(
        (await post(server, "download", { token, file: "pdf" })).status,
      ).toBe(404);
      const recordedAudits = await testDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, invoiceId));
      expect(recordedAudits.map(({ action }) => action).toSorted()).toEqual([
        "access",
        "download",
        "download",
      ]);
      expect(auditEvents.length).toBeGreaterThan(0);
      for (const recorded of [
        logs.records,
        analytics.events,
        analytics.groupIdentifies,
        auditEvents,
        recordedAudits,
        await sendRows(invoiceId),
      ]) {
        expect(JSON.stringify(recorded)).not.toContain(token);
      }
    } finally {
      analytics.restore();
      logs.restore();
    }
  });

  test("public summaries and every download disable caching and referrers, including refused lookups", async () => {
    const { token } = await sentInvoice("response-headers@example.test");
    for (const candidate of [token, "0".repeat(64)]) {
      const expectedStatus = candidate === token ? 200 : 404;
      const responses = [
        await post(server, "view", { token: candidate }),
        await post(server, "download", { token: candidate, file: "pdf" }),
        await post(server, "download", {
          token: candidate,
          file: "e_invoice",
        }),
      ];
      for (const response of responses) {
        expect(response.status).toBe(expectedStatus);
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      }
    }
  });

  const sentInvoice = async (to: string) => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    await send(invoiceId, [to]);
    return { invoiceId, token: tokenSentTo(to) };
  };

  test("shows the invoice, stamps the first view, and audits every open", async () => {
    const { invoiceId, token } = await sentInvoice("view@example.test");
    const response = await post(server, "view", { token });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      language: "cs",
      seller: "Example Law Office",
      buyer: "Example Client",
      paid: false,
      files: {
        pdf: { fileName: expect.stringContaining("LINK-") },
        eInvoice: { format: "isdoc" },
      },
    });
    const [row] = await sendRows(invoiceId);
    const firstViewedAt = row?.firstViewedAt;
    expect(firstViewedAt).toBeInstanceOf(Date);

    expect((await post(server, "view", { token })).status).toBe(200);
    const [again] = await sendRows(invoiceId);
    expect(again?.firstViewedAt).toEqual(firstViewedAt ?? null);
    const opens = await testDb
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceId, invoiceId),
          eq(auditLogs.action, "access"),
        ),
      );
    expect(opens).toHaveLength(2);
  });

  test("streams the PDF and the e-invoice, each recorded as a download", async () => {
    const { invoiceId, token } = await sentInvoice("files@example.test");
    const pdf = await post(server, "download", { token, file: "pdf" });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain("attachment");
    expect(new Uint8Array(await pdf.arrayBuffer())).toEqual(PDF_BYTES);

    const eInvoice = await post(server, "download", {
      token,
      file: "e_invoice",
    });
    expect(eInvoice.status).toBe(200);
    expect(await eInvoice.text()).toContain("<Invoice");

    const downloads = await testDb
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceId, invoiceId),
          eq(auditLogs.action, "download"),
        ),
      );
    expect(downloads).toHaveLength(2);
  });

  test.each([
    ["view", "revoked"],
    ["view", "expired"],
    ["pdf", "revoked"],
    ["pdf", "expired"],
    ["e_invoice", "revoked"],
    ["e_invoice", "expired"],
  ] as const)(
    "%s refuses delivery and access audit when the link becomes %s after its work",
    async (responseKind, invalidation) => {
      const { invoiceId, token } = await sentInvoice(
        `${responseKind}-${invalidation}@example.test`,
      );
      let completedWork = false;
      const invalidate = async () => {
        await testDb
          .update(invoiceSends)
          .set(
            invalidation === "revoked"
              ? { revokedAt: new Date() }
              : { expiresAt: new Date(0) },
          )
          .where(eq(invoiceSends.invoiceId, invoiceId));
        completedWork = true;
      };
      const target = serveForTest(
        createHttpApp({
          routes: linkRoutes({
            budget: budgetOf(1000),
            renderInvoice: async () => {
              await invalidate();
              return Result.ok({
                status: "rendered" as const,
                pdf: PDF_BYTES,
                compileMs: 1,
                peakRssBytes: 1,
              });
            },
            buildEInvoice: async (linked) => {
              const built = await buildLinkedEInvoice(linked);
              if (built.isErr() || built.value === null) {
                return panic(
                  "Expected a built e-invoice before invalidating its link",
                );
              }
              await invalidate();
              return built;
            },
          }),
          middleware: [errorBoundary],
        }),
      );
      try {
        const response =
          responseKind === "view"
            ? await post(target, "view", { token })
            : await post(target, "download", { token, file: responseKind });
        expect(completedWork).toBe(true);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
          code: "invoice_link_unavailable",
        });
        const [sendRow] = await sendRows(invoiceId);
        expect(sendRow?.firstViewedAt).toBeNull();
        const accesses = await testDb
          .select({ action: auditLogs.action })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.resourceId, invoiceId),
              eq(
                auditLogs.action,
                responseKind === "view" ? "access" : "download",
              ),
            ),
          );
        expect(accesses).toEqual([]);
      } finally {
        await target.stop();
      }
    },
  );

  test("a wrong or malformed token opens nothing", async () => {
    await sentInvoice("wrong@example.test");
    for (const token of ["0".repeat(64), "not-a-token", "A".repeat(64), 42]) {
      const response = await post(server, "view", { token });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        code: "invoice_link_unavailable",
      });
      expect(
        (await post(server, "download", { token, file: "pdf" })).status,
      ).toBe(404);
      expect(
        (await post(server, "download", { token, file: "e_invoice" })).status,
      ).toBe(404);
    }
  });

  test("an expired link opens nothing", async () => {
    const { invoiceId, token } = await sentInvoice("expired@example.test");
    await testDb
      .update(invoiceSends)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invoiceSends.invoiceId, invoiceId));
    expect((await post(server, "view", { token })).status).toBe(404);
    expect(
      (await post(server, "download", { token, file: "pdf" })).status,
    ).toBe(404);
    expect(
      (await post(server, "download", { token, file: "e_invoice" })).status,
    ).toBe(404);
  });

  test("a revoked link opens nothing, and revoking keeps the first revocation", async () => {
    const { invoiceId, token } = await sentInvoice("revoked@example.test");
    const [row] = await sendRows(invoiceId);
    const sendId = row?.id ?? "";
    const first = await revoke(invoiceId, sendId);
    expect(first).toMatchObject({ id: sendId });
    expect(await revoke(invoiceId, sendId)).toEqual(first);
    expect((await post(server, "view", { token })).status).toBe(404);
    expect(
      (await post(server, "download", { token, file: "pdf" })).status,
    ).toBe(404);
    expect(
      (await post(server, "download", { token, file: "e_invoice" })).status,
    ).toBe(404);
  });

  test("a voided invoice closes the link", async () => {
    const voided = await sentInvoice("voided@example.test");
    await testDb
      .update(invoices)
      .set({ status: INVOICE_STATUS.VOID })
      .where(eq(invoices.id, voided.invoiceId));
    expect((await post(server, "view", { token: voided.token })).status).toBe(
      404,
    );
    expect(
      (await post(server, "download", { token: voided.token, file: "pdf" }))
        .status,
    ).toBe(404);
    expect(
      (
        await post(server, "download", {
          token: voided.token,
          file: "e_invoice",
        })
      ).status,
    ).toBe(404);
  });

  test("a live link keeps opening and downloading after its sender leaves and deletes their account", async () => {
    const senderId = mintAuthProviderId<"user">();
    const memberId = mintAuthProviderIdValue();
    await testDb.insert(authUser).values({
      id: senderId,
      name: "Invoice sender",
      email: `${senderId}@example.test`,
      emailVerified: true,
    });
    await testDb.insert(member).values({
      id: memberId,
      organizationId: ids.orgA,
      userId: senderId,
      role: "owner",
      createdAt: new Date(),
    });
    try {
      const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
      const result = await send(invoiceId, ["departed@example.test"], {
        senderId,
      });
      expect(result).toMatchObject({
        deliveryStatus: "delivered",
        invoiceStatus: INVOICE_STATUS.SENT,
      });
      const token = tokenSentTo("departed@example.test");
      expect((await sendRows(invoiceId)).at(0)?.sentByUserId).toBe(senderId);
      await testDb.delete(member).where(eq(member.id, memberId));
      expect(
        await testDb
          .select({ id: member.id })
          .from(member)
          .where(eq(member.userId, senderId)),
      ).toEqual([]);
      for (const state of ["removed", "deleted"]) {
        if (state === "deleted") {
          await testDb.delete(authUser).where(eq(authUser.id, senderId));
          expect((await sendRows(invoiceId)).at(0)?.sentByUserId).toBeNull();
        }
        const opened = await post(server, "view", { token });
        expect(opened.status).toBe(200);
        expect(await opened.json()).toMatchObject({ buyer: "Example Client" });
        for (const file of ["pdf", "e_invoice"]) {
          const downloaded = await post(server, "download", { token, file });
          expect(downloaded.status).toBe(200);
          expect((await downloaded.arrayBuffer()).byteLength).toBeGreaterThan(
            0,
          );
        }
      }
      expect((await sendRows(invoiceId)).at(0)?.firstViewedAt).toBeInstanceOf(
        Date,
      );
    } finally {
      await testDb.delete(authUser).where(eq(authUser.id, senderId));
    }
  });

  test("a link reaches only its own invoice, never another invoice or tenant", async () => {
    const own = await sentInvoice("tenant-a@example.test");
    const sibling = await sentInvoice("same-tenant@example.test");
    const other = await seedInvoice({
      tenant: "B",
      status: INVOICE_STATUS.FINALIZED,
    });
    await send(other, ["tenant-b@example.test"], { tenant: "B" });
    const otherToken = tokenSentTo("tenant-b@example.test");

    const ownView: unknown = await (
      await post(server, "view", { token: own.token })
    ).json();
    const otherView: unknown = await (
      await post(server, "view", { token: otherToken })
    ).json();
    expect(JSON.stringify(ownView)).toContain(numberOf(own.invoiceId));
    expect(JSON.stringify(ownView)).not.toContain(numberOf(other));
    expect(JSON.stringify(ownView)).not.toContain(numberOf(sibling.invoiceId));
    const projected = await tokenDb().tenantless(
      async (tx) =>
        await tx
          .select(INVOICE_DOCUMENT_PROJECTION)
          .from(
            sql`public.invoice_link_invoice(${sha256Hex(own.token)}) AS invoices`,
          ),
    );
    expect(
      projected.map(parseInvoiceLinkInvoiceRow).map(({ id }) => id),
    ).toEqual([own.invoiceId]);
    expect(JSON.stringify(otherView)).toContain(numberOf(other));
    expect(JSON.stringify(otherView)).not.toContain("Example Law Office");

    // Another organization cannot revoke this organization's link.
    const [ownRow] = await sendRows(own.invoiceId);
    expect(await revoke(own.invoiceId, ownRow?.id ?? "", "B")).toMatchObject({
      code: 404,
    });
    const [still] = await sendRows(own.invoiceId);
    expect(still?.revokedAt).toBeNull();
  });

  test("a deployment without time billing answers like a dead link", async () => {
    const { token } = await sentInvoice("disabled@example.test");
    await using disabled = serveForTest(
      createHttpApp({
        routes: linkRoutes({
          budget: budgetOf(1000),
          isAvailable: () => false,
        }),
        middleware: [errorBoundary],
      }),
    );
    expect((await post(disabled, "view", { token })).status).toBe(404);
    expect(
      (await post(disabled, "download", { token, file: "pdf" })).status,
    ).toBe(404);
    expect((await post(server, "view", { token })).status).toBe(200);
  });

  test("the mounted routes spend the per-address budget", () => {
    expect(invoiceLinksRoute.map(({ path }) => path).toSorted()).toEqual([
      "/public/invoice-links/download",
      "/public/invoice-links/view",
    ]);
    for (const entry of invoiceLinksRoute) {
      expect(entry.middleware.some(isRateLimitMiddleware)).toBe(true);
    }
  });

  test("the per-address budget refuses rapid attempts", async () => {
    const { token } = await sentInvoice("budget@example.test");
    expect((await post(limitedServer, "view", { token })).status).toBe(200);
    expect((await post(limitedServer, "view", { token })).status).toBe(200);
    expect((await post(limitedServer, "view", { token })).status).toBe(429);
    expect(
      (await post(limitedServer, "view", { token: "0".repeat(64) })).status,
    ).toBe(429);
  });
});

describe("invoice payment requests", () => {
  test("email and public payment details/QR use the authenticated outstanding balance and restore it after voiding", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.SENT });
    await addPayment(invoiceId, { amount: 60_000, paidOn: "2026-10-02" });
    const { money } = createInvoiceFormatters({
      currency: "CZK",
      locale: "cs",
    });
    const firstSend = await send(invoiceId, ["outstanding@example.test"]);
    expect(firstSend).toMatchObject({ deliveryStatus: "delivered" });
    expect(
      delivered.findLast(({ to }) => to === "outstanding@example.test")
        ?.amountDue,
    ).toBe(money(40_000));
    const token = tokenSentTo("outstanding@example.test");
    const assertBalance = async (outstandingAmount: number) => {
      const authenticated = await readInvoiceById.handler(
        asTestRaw<Parameters<typeof readInvoiceById.handler>[0]>(
          memberContext({
            tenant: "A",
            invoiceId,
            route: "/v1/invoices/:workspaceId/:invoiceId",
          }),
        ),
      );
      expect(authenticated).toMatchObject({ outstandingAmount });
      const response = await post(server, "view", { token });
      expect(response.status).toBe(200);
      const page: unknown = await response.json();
      expect(page).not.toHaveProperty("paidAmount");
      const variableSymbol = variableSymbolOf({
        number: numberOf(invoiceId),
        reference: null,
      });
      const payload = buildCzechQrPaymentPayload({
        documentType: "invoice",
        iban: "CZ3301000000000002970297",
        amountMinor: cents(outstandingAmount),
        currency: "CZK",
        dueDate: "2026-10-15",
        message: numberOf(invoiceId),
        ...(variableSymbol === null ? {} : { variableSymbol }),
      }).unwrap();
      if (payload.status !== "payable") {
        return panic("Expected a payable Czech invoice QR");
      }
      expect(page).toMatchObject({
        outstandingAmount,
        totals: expect.arrayContaining([
          { label: expect.any(String), value: money(100_000) },
        ]),
        payment: {
          fields: expect.arrayContaining([
            { label: expect.any(String), value: money(outstandingAmount) },
          ]),
          qrSvg: qrSvg(payload.payload, "M"),
        },
      });
    };
    await assertBalance(40_000);
    await testDb
      .update(invoicePayments)
      .set({ voidedAt: new Date(), voidedBy: ids.userA1 })
      .where(eq(invoicePayments.invoiceId, invoiceId));
    expect(await send(invoiceId, ["restored@example.test"])).toMatchObject({
      deliveryStatus: "delivered",
    });
    expect(
      delivered.findLast(({ to }) => to === "restored@example.test")?.amountDue,
    ).toBe(money(100_000));
    await assertBalance(100_000);
  });
});

describe("public invoice settlement projection", () => {
  const expectPaidDateParity = async (
    invoiceId: SafeId<"invoice">,
    token: string,
  ) => {
    const dates = await readPublicAndAuthenticatedPaidDates(invoiceId, token);
    expect(dates.publicPaidDate).toBe(dates.authenticatedPaidDate);
    return dates.publicPaidDate;
  };

  test("unpaid and partially paid invoices have no settlement date", async () => {
    const unpaid = await seedInvoice({ status: INVOICE_STATUS.SENT });
    const unpaidLink = await createStandaloneLink(unpaid);
    expect(await expectPaidDateParity(unpaid, unpaidLink.token)).toBeNull();
    expect(await readSettlementFunction("A", unpaidLink.tokenHash)).toEqual([
      { latest_paid_on: null, paid_amount: 0 },
    ]);

    const partial = await seedInvoice({ status: INVOICE_STATUS.SENT });
    await addPayment(partial, { amount: 25_000, paidOn: "2026-10-02" });
    const partialLink = await createStandaloneLink(partial);
    expect(await expectPaidDateParity(partial, partialLink.token)).toBeNull();
    expect(await readSettlementFunction("A", partialLink.tokenHash)).toEqual([
      { latest_paid_on: null, paid_amount: 25_000 },
    ]);
  });

  test("a paid invoice uses its latest non-voided payment date", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.PAID });
    await testDb
      .update(invoices)
      .set({ paidAt: new Date("2026-10-05T12:00:00.000Z") })
      .where(eq(invoices.id, invoiceId));
    await addPayment(invoiceId, { amount: 60_000, paidOn: "2026-10-03" });
    await addPayment(invoiceId, { amount: 40_000, paidOn: "2026-10-04" });
    await addPayment(invoiceId, {
      amount: 100_000,
      paidOn: "2026-10-06",
      voided: true,
    });
    const link = await createStandaloneLink(invoiceId);
    expect(await expectPaidDateParity(invoiceId, link.token)).toBe(
      "2026-10-04",
    );
  });

  test("a paid invoice loses its settlement date when its payment is voided back to sent", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.PAID });
    await addPayment(invoiceId, { amount: 100_000, paidOn: "2026-10-03" });
    const link = await createStandaloneLink(invoiceId);
    expect(await expectPaidDateParity(invoiceId, link.token)).toBe(
      "2026-10-03",
    );
    await testDb
      .update(invoicePayments)
      .set({ voidedAt: new Date(), voidedBy: ids.userA1 })
      .where(eq(invoicePayments.invoiceId, invoiceId));
    await testDb
      .update(invoices)
      .set({ status: INVOICE_STATUS.SENT, paidAt: null })
      .where(eq(invoices.id, invoiceId));
    expect(await expectPaidDateParity(invoiceId, link.token)).toBeNull();
    expect(await readSettlementFunction("A", link.tokenHash)).toMatchObject([
      { latest_paid_on: null },
    ]);
  });

  test("a zero-total send uses the legacy paidAt date", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    await testDb
      .update(invoices)
      .set({ netAmount: cents(0), vatAmount: cents(0), totalAmount: cents(0) })
      .where(eq(invoices.id, invoiceId));
    await testDb
      .update(invoiceLines)
      .set({
        unitPrice: cents(0),
        netAmount: cents(0),
        vatAmount: cents(0),
        grossAmount: cents(0),
      })
      .where(eq(invoiceLines.invoiceId, invoiceId));
    expect(
      await send(invoiceId, ["zero-settlement@example.test"]),
    ).toMatchObject({
      invoiceStatus: INVOICE_STATUS.PAID,
    });
    const token = tokenSentTo("zero-settlement@example.test");
    expect(await expectPaidDateParity(invoiceId, token)).not.toBeNull();
    const page: unknown = await (await post(server, "view", { token })).json();
    expect(page).toMatchObject({ outstandingAmount: 0, payment: null });
    expect(page).not.toHaveProperty("paidAmount");
  });

  test("legacy payment rows retain their recorded paid date", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.PAID });
    await testDb
      .update(invoices)
      .set({ paidAt: new Date("2026-10-05T12:00:00.000Z") })
      .where(eq(invoices.id, invoiceId));
    await addPayment(invoiceId, {
      amount: 100_000,
      paidOn: "2026-09-28",
      origin: INVOICE_PAYMENT_ORIGIN.LEGACY,
    });
    const link = await createStandaloneLink(invoiceId);
    expect(await expectPaidDateParity(invoiceId, link.token)).toBe(
      "2026-09-28",
    );
  });

  test("settlement function returns no rows for revoked, expired, or foreign-tenant links", async () => {
    const revokedInvoice = await seedInvoice({ status: INVOICE_STATUS.PAID });
    await addPayment(revokedInvoice, {
      amount: 100_000,
      paidOn: "2026-10-03",
    });
    const revoked = await createStandaloneLink(revokedInvoice);
    expect(await readSettlementFunction("A", revoked.tokenHash)).toHaveLength(
      1,
    );
    await testDb
      .update(invoiceSends)
      .set({ revokedAt: new Date() })
      .where(eq(invoiceSends.tokenHash, revoked.tokenHash));
    expect(await readSettlementFunction("A", revoked.tokenHash)).toEqual([]);

    const expiredInvoice = await seedInvoice({ status: INVOICE_STATUS.PAID });
    await addPayment(expiredInvoice, {
      amount: 100_000,
      paidOn: "2026-10-03",
    });
    const expired = await createStandaloneLink(expiredInvoice);
    expect(await readSettlementFunction("A", expired.tokenHash)).toHaveLength(
      1,
    );
    await testDb
      .update(invoiceSends)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invoiceSends.tokenHash, expired.tokenHash));
    expect(await readSettlementFunction("A", expired.tokenHash)).toEqual([]);

    const foreignInvoice = await seedInvoice({ status: INVOICE_STATUS.PAID });
    await addPayment(foreignInvoice, {
      amount: 100_000,
      paidOn: "2026-10-03",
    });
    const foreign = await createStandaloneLink(foreignInvoice);
    expect(await readSettlementFunction("A", foreign.tokenHash)).toHaveLength(
      1,
    );
    expect(await readSettlementFunction("B", foreign.tokenHash)).toEqual([]);
  });
});
