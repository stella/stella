import { Result } from "better-result";
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
import { sha256Hex } from "@stll/sha256/bun";

import { member, user as authUser } from "@/api/db/auth-schema";
import {
  auditLogs,
  featureEnrolments,
  INVOICE_STATUS,
  invoiceLines,
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
import { createDownloadInvoiceLinkFile } from "@/api/handlers/invoice-links/download";
import { invoiceLinksRoute } from "@/api/handlers/invoice-links/routes";
import { createViewInvoiceLink } from "@/api/handlers/invoice-links/view";
import type { InvoiceLinkMessage } from "@/api/handlers/invoices/sends/create";
import { createSendInvoice } from "@/api/handlers/invoices/sends/create";
import listInvoiceSends from "@/api/handlers/invoices/sends/list";
import revokeInvoiceSend from "@/api/handlers/invoices/sends/revoke";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
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
  isAvailable?: () => boolean;
};

/** The production route table's shape, with test doubles for its seams. */
const linkRoutes = ({ budget, isAvailable = () => true }: LinkRouteOptions) =>
  routes(
    {
      "/view": {
        POST: createViewInvoiceLink({ db: tokenDb(), isAvailable }),
      },
      "/download": {
        POST: createDownloadInvoiceLinkFile({
          db: tokenDb(),
          isAvailable,
          renderInvoice: async () =>
            Result.ok({
              status: "rendered" as const,
              pdf: PDF_BYTES,
              compileMs: 1,
              peakRssBytes: 1,
            }),
        }),
      },
    },
    { prefix: "/public/invoice-links", middleware: [budget] },
  );

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
        senderId,
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

const invoiceStatus = async (invoiceId: SafeId<"invoice">) =>
  (
    await testDb
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
  ).at(0)?.status;

describe("sending an invoice by link", () => {
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
          .select({ id: invoices.id })
          .from(
            sql`public.invoice_link_invoice(${sha256Hex(own.token)}) AS invoices`,
          ),
    );
    expect(projected).toEqual([{ id: own.invoiceId }]);
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
