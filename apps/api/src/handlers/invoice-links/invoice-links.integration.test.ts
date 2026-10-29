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
import * as v from "valibot";

import {
  INVOICE_LINE_INPUT_LIMITS,
  INVOICE_LINE_SOURCE,
  INVOICE_SEND_LIMITS,
} from "@stll/api-contract";
import { compareCodeUnit } from "@stll/collation";
import { buildCzechQrPaymentPayload, variableSymbolOf } from "@stll/invoicing";
import { waitForExternalState } from "@stll/property-testing/external-state";
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
  timeEntries,
  workspaces,
} from "@/api/db/schema";
import type { InvoiceStatus } from "@/api/db/schema";
import {
  createSafeDb,
  createScopedDb,
  createTenantlessDb,
} from "@/api/db/scoped";
import {
  INVOICE_LINK_DOCUMENT_PROJECTION,
  loadLinkedInvoiceData,
} from "@/api/handlers/invoice-links/document";
import { createDownloadInvoiceLinkFile } from "@/api/handlers/invoice-links/download";
import { buildLinkedEInvoice } from "@/api/handlers/invoice-links/e-invoice";
import { parseInvoiceLinkInvoiceRow } from "@/api/handlers/invoice-links/function-rows";
import { invoiceLinksRoute } from "@/api/handlers/invoice-links/routes";
import { createViewInvoiceLink } from "@/api/handlers/invoice-links/view";
import readInvoiceById from "@/api/handlers/invoices/get";
import type { InvoiceLinkMessage } from "@/api/handlers/invoices/sends/create";
import {
  createSendInvoice,
  prepareInvoiceSend,
} from "@/api/handlers/invoices/sends/create";
import listInvoiceSends from "@/api/handlers/invoices/sends/list";
import revokeInvoiceSend from "@/api/handlers/invoices/sends/revoke";
import transitionInvoice from "@/api/handlers/invoices/transition";
import updateInvoice from "@/api/handlers/invoices/update";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import {
  loadInvoiceExport,
  toExportRecords,
} from "@/api/lib/billing/invoice-export-records";
import { invoiceLinkResponsePolicy } from "@/api/lib/billing/invoice-link-response-policy";
import {
  createInvoiceLinkToken,
  hashInvoiceLinkToken,
  INVOICE_SENDS_PER_INVOICE_PER_DAY,
  INVOICE_SENDS_PER_ORGANIZATION_PER_DAY,
  resolveInvoiceLink,
} from "@/api/lib/billing/invoice-links";
import type { InvoicePdfRenderer } from "@/api/lib/billing/invoice-pdf/document";
import {
  invoiceDocumentRenderOptions,
  loadInvoiceDocument,
} from "@/api/lib/billing/invoice-pdf/document";
import { createInvoiceFormatters } from "@/api/lib/billing/invoice-pdf/render-helpers";
import { qrSvg } from "@/api/lib/billing/invoice-pdf/typst/data";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { TRANSITIONS as DATABASE_TRANSITIONS } from "@/api/lib/db/transition-specs";
import {
  transition as transitionStatus,
  transitionBatch,
} from "@/api/lib/db/transitions";
import { cents } from "@/api/lib/money";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { createInvoiceEmailAdmission } from "@/api/lib/rate-limit/invoice-email-admission";
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
const verifiedSellerUserId = mintAuthProviderId<"user">();

const sendInvoice = createSendInvoice({
  deliver: async (message) => {
    if (refused.has(message.to)) {
      throw new Error("Mailbox unavailable");
    }
    delivered.push(message);
  },
  isDeliveryConfigured: () => true,
  admitEmail: async () =>
    Result.ok({
      release: async () => {},
      commit: async () => {},
    }),
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
  await testDb.insert(authUser).values({
    id: verifiedSellerUserId,
    name: "Verified billing contact",
    email: "billing@firm.example.test",
    emailVerified: true,
  });
  await testDb.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId: ids.orgA,
    userId: verifiedSellerUserId,
    role: "member",
    createdAt: new Date(),
  });
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
    await testDb.delete(authUser).where(eq(authUser.id, verifiedSellerUserId));
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

const listSendHistory = async (
  invoiceId: SafeId<"invoice">,
  query: { cursor?: string; limit?: number } = {},
) => {
  const result = await listInvoiceSends.handler(
    asTestRaw<Parameters<typeof listInvoiceSends.handler>[0]>({
      ...memberContext({
        tenant: "A",
        invoiceId,
        route: "/v1/invoices/:workspaceId/:invoiceId/sends",
      }),
      query,
    }),
  );
  if (!("items" in result)) {
    return panic("Expected invoice send history to remain available");
  }
  return result;
};

const transitionLinkedInvoice = async (
  invoiceId: SafeId<"invoice">,
  {
    action,
    auditEvents = [],
  }: {
    action: "finalize" | "revert_to_draft" | "void";
    auditEvents?: AuditEvent[];
  },
) =>
  await transitionInvoice.handler(
    asTestRaw<Parameters<typeof transitionInvoice.handler>[0]>(
      memberContext({
        tenant: "A",
        invoiceId,
        route: "/v1/invoices/:workspaceId/:invoiceId/transition",
        body: { action },
        auditEvents,
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

const createStandaloneLink = async (
  invoiceId: SafeId<"invoice">,
  {
    expiresAt = new Date(Date.now() + 86_400_000),
    deliveryStatus = "delivered",
  }: { expiresAt?: Date; deliveryStatus?: "pending" | "delivered" } = {},
) => {
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
    expiresAt,
    deliveryStatus: "pending",
  });
  if (deliveryStatus === "delivered") {
    await testDb
      .update(invoiceSends)
      .set({ deliveryStatus })
      .where(eq(invoiceSends.tokenHash, tokenHash));
  }
  return { token, tokenHash };
};

type InvoiceGraph = typeof DATABASE_TRANSITIONS.invoices.edges;
type InvoiceGraphEdge = {
  [From in keyof InvoiceGraph]: {
    from: readonly [From];
    to: InvoiceGraph[From][number];
  };
}[keyof InvoiceGraph];

const isInvoiceGraphEdge = (edge: {
  from: readonly [string];
  to: string;
}): edge is InvoiceGraphEdge =>
  Object.entries(DATABASE_TRANSITIONS.invoices.edges).some(
    ([from, targets]) =>
      from === edge.from[0] && targets.some((to) => to === edge.to),
  );

const invoiceGraphEdges = Object.entries(DATABASE_TRANSITIONS.invoices.edges)
  .flatMap(([from, targets]) =>
    targets.map((to) => ({ from: [from] as const, to })),
  )
  .filter(isInvoiceGraphEdge);

const invoiceTransitionRecorder = () =>
  createBackgroundAuditRecorder({
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
    execution: {
      performer: { type: "user", id: ids.userA1 },
      trigger: { type: "system", source: "invoice_link_transition_test" },
    },
  });

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
  const publicScope = database.scoped({
    organizationId,
    userId: null,
    workspaceIds: [],
  });
  const linked = await publicScope((tx) =>
    loadLinkedInvoiceData(tx, { ...scope, scopedDb: publicScope }),
  );
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
  const { organizationId } = tenantOf(tenant);
  return await tokenDb().scoped({
    organizationId,
    userId: null,
    workspaceIds: [],
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
  test("unenrolling keeps existing link history and revocation available while refusing new sends", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    const firstSend = await send(invoiceId, [
      "cleanup-after-unenrolment@example.test",
    ]);
    if (!("id" in firstSend) || typeof firstSend.id !== "string") {
      return panic("Expected a successful send before unenrolment");
    }
    const sendId = firstSend.id;
    const existing = {
      invoiceId,
      token: tokenSentTo("cleanup-after-unenrolment@example.test"),
    };
    const pending = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
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
      const listed = await listInvoiceSends.handler(
        asTestRaw<Parameters<typeof listInvoiceSends.handler>[0]>(
          memberContext({
            tenant: "A",
            invoiceId: existing.invoiceId,
            route: "/v1/invoices/:workspaceId/:invoiceId/sends",
          }),
        ),
      );
      expect(listed).toMatchObject({ items: [{ id: sendId }] });
      expect(await revoke(existing.invoiceId, sendId)).toMatchObject({
        id: sendId,
      });
      expect(
        (await sendRows(existing.invoiceId)).at(0)?.revokedAt,
      ).toBeInstanceOf(Date);
      expect(
        (await post(server, "view", { token: existing.token })).status,
      ).toBe(404);
      expect(
        await send(pending, ["still-disabled@example.test"]),
      ).toMatchObject({ code: 404 });
      expect(await sendRows(pending)).toEqual([]);
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

  test.each([
    {
      refusal: "draft",
      status: INVOICE_STATUS.DRAFT,
      historyCount: 0,
      expectedCode: 409,
    },
    {
      refusal: "void",
      status: INVOICE_STATUS.VOID,
      historyCount: 0,
      expectedCode: 409,
    },
    {
      refusal: "invoice cap",
      status: INVOICE_STATUS.FINALIZED,
      historyCount: INVOICE_SENDS_PER_INVOICE_PER_DAY,
      expectedCode: 429,
    },
    {
      refusal: "organization cap",
      status: INVOICE_STATUS.FINALIZED,
      historyCount: INVOICE_SENDS_PER_ORGANIZATION_PER_DAY,
      expectedCode: 429,
    },
    {
      refusal: "unverified",
      status: INVOICE_STATUS.FINALIZED,
      historyCount: 0,
      expectedCode: 404,
    },
  ] as const)(
    "$refusal refusal never reserves shared email quota",
    async ({ refusal, status, historyCount, expectedCode }) => {
      const invoiceId = await seedInvoice({ status });
      const historyInvoiceId =
        refusal === "organization cap"
          ? await seedInvoice({ status: INVOICE_STATUS.SENT })
          : invoiceId;
      const history = Array.from({ length: historyCount }, () => ({
        id: createSafeId<"invoiceSend">(),
        organizationId: ids.orgA,
        invoiceId: historyInvoiceId,
        recipients: ["prior-reservation@example.test"],
        language: "en" as const,
        replyTo: "billing@firm.example.test",
        tokenHash: hashInvoiceLinkToken(createInvoiceLinkToken()),
        expiresAt: new Date(Date.now() + 86_400_000),
        deliveryStatus: "pending" as const,
      }));
      if (history.length > 0) {
        await testDb.insert(invoiceSends).values(history);
      }
      const counter = new InMemoryRateLimitContext();
      const keys = new Set<string>();
      const admit = createInvoiceEmailAdmission({
        increment: (key, duration) => {
          keys.add(key);
          return counter.increment(key, duration);
        },
        decrement: (key) => counter.decrement(key),
        complete: (key) => counter.complete(key),
      });
      let admissions = 0;
      const transported: InvoiceLinkMessage[] = [];
      const guarded = createSendInvoice({
        isDeliveryConfigured: () => true,
        admitEmail: async (options) => {
          admissions += 1;
          return await admit(options);
        },
        deliver: async (message) => {
          transported.push(message);
        },
      });
      if (refusal === "unverified") {
        await testDb
          .update(authUser)
          .set({ emailVerified: false })
          .where(eq(authUser.id, ids.userA1));
      }
      try {
        const result = await guarded.handler(
          asTestRaw<Parameters<typeof guarded.handler>[0]>(
            memberContext({
              tenant: "A",
              invoiceId,
              route: "/v1/invoices/:workspaceId/:invoiceId/sends",
              body: { recipients: ["refused-before-quota@example.test"] },
            }),
          ),
        );
        expect(result).toMatchObject({
          code: expectedCode,
        });
        expect(admissions).toBe(0);
        expect([...keys]).toEqual([]);
        expect(transported).toEqual([]);
        expect(await sendRows(invoiceId)).toHaveLength(
          historyInvoiceId === invoiceId ? historyCount : 0,
        );
      } finally {
        counter.kill();
        if (refusal === "unverified") {
          await testDb
            .update(authUser)
            .set({ emailVerified: true })
            .where(eq(authUser.id, ids.userA1));
        }
        if (history.length > 0) {
          await testDb.delete(invoiceSends).where(
            inArray(
              invoiceSends.id,
              history.map(({ id }) => id),
            ),
          );
        }
      }
    },
  );

  test("a change after quota reservation refunds every slot without transport or a send row", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    const counter = new InMemoryRateLimitContext();
    const keys = new Set<string>();
    const admit = createInvoiceEmailAdmission({
      increment: (key, duration) => {
        keys.add(key);
        return counter.increment(key, duration);
      },
      decrement: (key) => counter.decrement(key),
      complete: (key) => counter.complete(key),
    });
    let admissions = 0;
    let releases = 0;
    let commits = 0;
    const transported: InvoiceLinkMessage[] = [];
    const racing = createSendInvoice({
      isDeliveryConfigured: () => true,
      admitEmail: async (options) => {
        admissions += 1;
        const reserved = await admit(options);
        if (reserved.isErr()) {
          return reserved;
        }
        expect(keys.size).toBeGreaterThan(0);
        expect([...keys].every((key) => counter.read(key)?.count === 1)).toBe(
          true,
        );
        expect(
          await transitionLinkedInvoice(invoiceId, { action: "void" }),
        ).toEqual({ id: invoiceId });
        return Result.ok({
          release: async () => {
            releases += 1;
            await reserved.value.release();
          },
          commit: async () => {
            commits += 1;
            await reserved.value.commit();
          },
        });
      },
      deliver: async (message) => {
        transported.push(message);
      },
    });
    try {
      const result = await racing.handler(
        asTestRaw<Parameters<typeof racing.handler>[0]>(
          memberContext({
            tenant: "A",
            invoiceId,
            route: "/v1/invoices/:workspaceId/:invoiceId/sends",
            body: {
              recipients: ["race-a@example.test", "race-b@example.test"],
            },
          }),
        ),
      );
      expect(result).toMatchObject({ code: 409 });
      expect(admissions).toBe(1);
      expect(releases).toBe(1);
      expect(commits).toBe(0);
      expect([...keys].every((key) => counter.read(key)?.count === 0)).toBe(
        true,
      );
      expect(transported).toEqual([]);
      expect(await sendRows(invoiceId)).toEqual([]);
      expect(await invoiceStatus(invoiceId)).toBe(INVOICE_STATUS.VOID);
    } finally {
      counter.kill();
    }
  });

  test.each(["quota", "unavailable"] as const)(
    "a refused %s email admission creates no send and calls no transport",
    async (refusal) => {
      const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
      const transported: InvoiceLinkMessage[] = [];
      const admitEmail = createInvoiceEmailAdmission({
        increment: () => {
          if (refusal === "unavailable") {
            throw new Error("Shared email counter unavailable");
          }
          return { count: 1001, start: 0, nextReset: new Date(86_400_000) };
        },
        decrement: () => {},
        complete: () => {},
      });
      const limitedSend = createSendInvoice({
        isDeliveryConfigured: () => true,
        admitEmail,
        deliver: async (message) => {
          transported.push(message);
        },
      });
      const result = await limitedSend.handler(
        asTestRaw<Parameters<typeof limitedSend.handler>[0]>(
          memberContext({
            tenant: "A",
            invoiceId,
            route: "/v1/invoices/:workspaceId/:invoiceId/sends",
            body: { recipients: ["limited@example.test"] },
          }),
        ),
      );
      expect(result).toMatchObject({ code: refusal === "quota" ? 429 : 503 });
      expect(transported).toEqual([]);
      expect(await sendRows(invoiceId)).toEqual([]);
      expect(await invoiceStatus(invoiceId)).toBe(INVOICE_STATUS.FINALIZED);
    },
  );

  test("the request note boundary accepts one thousand characters and refuses a longer note", () => {
    expect(INVOICE_SEND_LIMITS.messageMaxChars).toBe(1000);
    expect(
      v.safeParse(sendInvoice.config.body, {
        recipients: ["note@example.test"],
        message: "x".repeat(INVOICE_SEND_LIMITS.messageMaxChars),
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(sendInvoice.config.body, {
        recipients: ["note@example.test"],
        message: "x".repeat(INVOICE_SEND_LIMITS.messageMaxChars + 1),
      }).success,
    ).toBe(false);
  });

  test.each(["unverified member", "verified nonmember"] as const)(
    "a seller email owned by an %s falls back to the sender's verified address",
    async (sellerIdentity) => {
      const userId = mintAuthProviderId<"user">();
      const email = `${userId}@seller.example.test`;
      await testDb.insert(authUser).values({
        id: userId,
        name: "Seller contact",
        email,
        emailVerified: sellerIdentity === "verified nonmember",
      });
      if (sellerIdentity === "unverified member") {
        await testDb.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId: ids.orgA,
          userId,
          role: "member",
          createdAt: new Date(),
        });
      }
      try {
        await testDb
          .update(sellerProfiles)
          .set({ email })
          .where(eq(sellerProfiles.id, sellerA));
        const [sender] = await testDb
          .select({ email: authUser.email })
          .from(authUser)
          .where(eq(authUser.id, ids.userA1));
        const invoiceId = await seedInvoice({
          status: INVOICE_STATUS.FINALIZED,
        });
        const recipient = `${userId}@recipient.example.test`;
        expect(await send(invoiceId, [recipient])).toMatchObject({
          deliveryStatus: "delivered",
          replyTo: sender?.email,
        });
        expect(delivered.findLast(({ to }) => to === recipient)?.replyTo).toBe(
          sender?.email,
        );
        expect((await sendRows(invoiceId)).at(0)?.replyTo).toBe(sender?.email);
        const listed = await listInvoiceSends.handler(
          asTestRaw<Parameters<typeof listInvoiceSends.handler>[0]>(
            memberContext({
              tenant: "A",
              invoiceId,
              route: "/v1/invoices/:workspaceId/:invoiceId/sends",
            }),
          ),
        );
        expect(listed).toMatchObject({ replyTo: sender?.email });
      } finally {
        await testDb
          .update(sellerProfiles)
          .set({ email: "billing@firm.example.test" })
          .where(eq(sellerProfiles.id, sellerA));
        await testDb.delete(authUser).where(eq(authUser.id, userId));
      }
    },
  );

  test.each([-7, 7])(
    "preparation derives expiry from the database clock despite a %s-day application clock skew",
    async (skewDays) => {
      const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
      const prepared = await tokenDb().scoped({
        organizationId: ids.orgA,
        userId: ids.userA1,
        workspaceIds: [ids.wsA1],
      })(async (tx) => {
        const result = await prepareInvoiceSend(tx, {
          invoiceId,
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          userId: ids.userA1,
          recipients: ["clock-skew@example.test"],
          message: null,
          tokenHash: hashInvoiceLinkToken(createInvoiceLinkToken()),
          now: new Date(Date.now() + skewDays * 86_400_000),
          recordAuditEvent: invoiceTransitionRecorder(),
        });
        if (result.isErr()) {
          return panic("Valid preparation must survive application clock skew");
        }
        const [clock] = await tx
          .select({
            expectedExpiry: sql`now() + interval '60 days'`.mapWith(
              invoiceSends.expiresAt,
            ),
            storedExpiry: invoiceSends.expiresAt,
          })
          .from(invoiceSends)
          .where(eq(invoiceSends.id, result.value.sendId))
          .limit(1);
        if (clock === undefined) {
          return panic("Prepared invoice send must persist its expiry");
        }
        return { returnedExpiry: result.value.expiresAt, ...clock };
      });
      expect(prepared.returnedExpiry).toEqual(prepared.expectedExpiry);
      expect(prepared.storedExpiry).toEqual(prepared.expectedExpiry);
    },
  );

  test("an in-flight send is pending until delivery activates its link", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    const entered = Promise.withResolvers<InvoiceLinkMessage>();
    const release = Promise.withResolvers<undefined>();
    const blocked = createSendInvoice({
      isDeliveryConfigured: () => true,
      admitEmail: async () =>
        Result.ok({
          release: async () => {},
          commit: async () => {},
        }),
      deliver: async (message) => {
        entered.resolve(message);
        await release.promise;
      },
    });
    const sending = blocked.handler(
      asTestRaw<Parameters<typeof blocked.handler>[0]>(
        memberContext({
          tenant: "A",
          invoiceId,
          route: "/v1/invoices/:workspaceId/:invoiceId/sends",
          body: { recipients: ["pending-projection@example.test"] },
        }),
      ),
    );
    const message = await entered.promise;
    const token = message.link.split("#").at(1);
    if (token === undefined) {
      release.resolve(undefined);
      await sending;
      return panic("The blocked transport must carry an invoice token");
    }
    try {
      const listed = await listSendHistory(invoiceId);
      expect(listed.items).toMatchObject([
        { deliveryStatus: "pending", linkStatus: "pending" },
      ]);
      expect((await post(server, "view", { token })).status).toBe(404);
    } finally {
      release.resolve(undefined);
      await sending;
    }
    expect(await sending).toMatchObject({ deliveryStatus: "delivered" });
    expect((await listSendHistory(invoiceId)).items).toMatchObject([
      { deliveryStatus: "delivered", linkStatus: "active" },
    ]);
    expect((await post(server, "view", { token })).status).toBe(200);
  });

  test("a pending send cannot advance a revised and re-finalized invoice or reactivate its withdrawn link", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    const auditEvents: AuditEvent[] = [];
    const transported: InvoiceLinkMessage[] = [];
    const withdrawalStamps: Date[] = [];
    const racing = createSendInvoice({
      isDeliveryConfigured: () => true,
      admitEmail: async () =>
        Result.ok({
          release: async () => {},
          commit: async () => {},
        }),
      deliver: async (message) => {
        transported.push(message);
        expect(
          await transitionLinkedInvoice(invoiceId, {
            action: "revert_to_draft",
            auditEvents,
          }),
        ).toEqual({ id: invoiceId });
        const original = (await sendRows(invoiceId)).at(0);
        if (original?.revokedAt === undefined || original.revokedAt === null) {
          return panic("Reverting must withdraw the in-flight invoice link");
        }
        withdrawalStamps.push(original.revokedAt);
        expect(
          await updateInvoice.handler(
            asTestRaw<Parameters<typeof updateInvoice.handler>[0]>(
              memberContext({
                tenant: "A",
                invoiceId,
                route: "/v1/invoices/:workspaceId/:invoiceId",
                body: {
                  reference: "REVISED-DURING-SEND",
                  notes: "Revised document",
                },
              }),
            ),
          ),
        ).toEqual({ id: invoiceId });
        expect(
          await transitionLinkedInvoice(invoiceId, {
            action: "finalize",
            auditEvents,
          }),
        ).toEqual({ id: invoiceId });
      },
    });
    const result = await racing.handler(
      asTestRaw<Parameters<typeof racing.handler>[0]>(
        memberContext({
          tenant: "A",
          invoiceId,
          route: "/v1/invoices/:workspaceId/:invoiceId/sends",
          body: { recipients: ["revised-during-send@example.test"] },
          auditEvents,
        }),
      ),
    );
    expect(result).toMatchObject({
      code: 409,
      response: { code: "invoice_link_withdrawn" },
    });
    expect(transported).toHaveLength(1);
    const token = transported.at(0)?.link.split("#").at(1);
    if (token === undefined) {
      return panic(
        "The successful transport must have carried the original token",
      );
    }
    const original = (await sendRows(invoiceId)).at(0);
    expect(original).toMatchObject({
      deliveryStatus: "failed",
      revokedByUserId: ids.userA1,
      revokedAt: withdrawalStamps.at(0),
      failedRecipients: [],
    });
    const invoice = await testDb.query.invoices.findFirst({
      where: { id: { eq: invoiceId } },
      columns: { status: true, sentAt: true, reference: true },
    });
    expect(invoice).toEqual({
      status: INVOICE_STATUS.FINALIZED,
      sentAt: null,
      reference: "REVISED-DURING-SEND",
    });
    expect(
      auditEvents.filter((event) => event.changes?.["action"]?.new === "send"),
    ).toEqual([]);
    expect((await post(server, "view", { token })).status).toBe(404);
    for (const file of ["pdf", "e_invoice"]) {
      expect((await post(server, "download", { token, file })).status).toBe(
        404,
      );
    }
    expect(
      await send(invoiceId, ["revised-new-link@example.test"]),
    ).toMatchObject({
      deliveryStatus: "delivered",
    });
    expect(
      (
        await post(server, "view", {
          token: tokenSentTo("revised-new-link@example.test"),
        })
      ).status,
    ).toBe(200);
    expect((await post(server, "view", { token })).status).toBe(404);
  });

  test.each([
    ["void", INVOICE_STATUS.VOID, "delivered"],
    ["revert_to_draft", INVOICE_STATUS.DRAFT, "delivered"],
    ["void", INVOICE_STATUS.VOID, "failed"],
    ["revert_to_draft", INVOICE_STATUS.DRAFT, "failed"],
  ] as const)(
    "completion after %s keeps the invoice %s and records the %s transport outcome without reopening its link",
    async (action, status, outcome) => {
      const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
      const auditEvents: AuditEvent[] = [];
      const transported: InvoiceLinkMessage[] = [];
      const revokedDuringTransport: Date[] = [];
      const racingSend = createSendInvoice({
        isDeliveryConfigured: () => true,
        admitEmail: async () =>
          Result.ok({
            release: async () => {},
            commit: async () => {},
          }),
        deliver: async (message) => {
          transported.push(message);
          const [reserved] = await sendRows(invoiceId);
          expect(reserved?.deliveryStatus).toBe("pending");
          expect(reserved?.revokedAt).toBeNull();
          expect(
            await transitionLinkedInvoice(invoiceId, { action, auditEvents }),
          ).toEqual({ id: invoiceId });
          const [revoked] = await sendRows(invoiceId);
          if (revoked?.revokedAt === null || revoked?.revokedAt === undefined) {
            return panic("Invoice transition did not revoke its pending send");
          }
          expect(revoked.deliveryStatus).toBe("pending");
          revokedDuringTransport.push(revoked.revokedAt);
          if (outcome === "failed") {
            throw new Error("Mailbox refused the invoice after its transition");
          }
          delivered.push(message);
        },
      });
      const recipient = `${action}-${outcome}@example.test`;
      const result = await racingSend.handler(
        asTestRaw<Parameters<typeof racingSend.handler>[0]>(
          memberContext({
            tenant: "A",
            invoiceId,
            route: "/v1/invoices/:workspaceId/:invoiceId/sends",
            body: { recipients: [recipient] },
            auditEvents,
          }),
        ),
      );
      const transportedMessage = transported.at(0);
      if (transportedMessage === undefined) {
        return panic(
          "Expected one transport attempt before checking its outcome",
        );
      }
      expect(result).toMatchObject({
        code: 409,
        response: { code: "invoice_link_withdrawn" },
      });
      if (outcome === "delivered") {
        expect(delivered).toContainEqual(transportedMessage);
      } else {
        expect(delivered).not.toContainEqual(transportedMessage);
      }
      expect(transported).toHaveLength(1);
      expect(revokedDuringTransport).toHaveLength(1);
      expect(await invoiceStatus(invoiceId)).toBe(status);
      const rows = await sendRows(invoiceId);
      expect(rows).toHaveLength(1);
      const row = rows.at(0);
      expect(row?.deliveryStatus).toBe("failed");
      expect(row?.failedRecipients).toEqual(
        outcome === "failed" ? [recipient] : [],
      );
      expect(row?.revokedAt).toEqual(revokedDuringTransport.at(0));
      expect(row?.revokedByUserId).toBe(ids.userA1);
      expect(
        auditEvents.filter(
          (event) =>
            event.resourceType === AUDIT_RESOURCE_TYPE.INVOICE &&
            event.changes?.["linkRevoked"]?.new === true,
        ),
      ).toMatchObject([{ metadata: { invoiceSendId: row?.id } }]);
      expect(
        auditEvents.filter(
          (event) =>
            event.resourceType === AUDIT_RESOURCE_TYPE.INVOICE &&
            event.changes?.["emailDelivery"] !== undefined,
        ),
      ).toMatchObject([
        {
          changes: { emailDelivery: { old: "pending", new: "failed" } },
          metadata: { invoiceSendId: row?.id },
        },
      ]);
      const token = transportedMessage.link.split("#").at(1);
      if (token === undefined) {
        return panic("The transport did not receive an invoice link");
      }
      expect(row?.tokenHash).toBe(hashInvoiceLinkToken(token));
      const opened = await post(server, "view", { token });
      expect(opened.status).toBe(404);
      expect(await opened.json()).toMatchObject({
        code: "invoice_link_unavailable",
      });
      for (const file of ["pdf", "e_invoice"]) {
        expect((await post(server, "download", { token, file })).status).toBe(
          404,
        );
      }
    },
  );

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
        deliveryStatus: "pending" as const,
      })),
    );
    await testDb
      .update(invoiceSends)
      .set({ deliveryStatus: "delivered" })
      .where(eq(invoiceSends.invoiceId, busy));
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

  test("send history pages newest first beyond one hundred sends and keeps active links revocable", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    const baseTime = Date.UTC(2026, 9, 1);
    const entries = Array.from({ length: 101 }, (_, position) => {
      const id = createSafeId<"invoiceSend">();
      return {
        id,
        organizationId: ids.orgA,
        invoiceId,
        sentByUserId: ids.userA1,
        recipients: [`history-${position}@example.test`],
        language: "cs" as const,
        replyTo: "billing@firm.example.test",
        tokenHash: sha256Hex(id),
        // Adjacent rows share a timestamp, so page boundaries also exercise id ordering.
        createdAt: new Date(
          baseTime +
            (position >= 99 ? position : Math.floor(position / 2)) * 1000,
        ),
        expiresAt: new Date(
          position >= 99 ? Date.now() + 86_400_000 : baseTime,
        ),
        deliveryStatus: "pending" as const,
      };
    });
    await testDb.insert(invoiceSends).values(entries);
    await testDb
      .update(invoiceSends)
      .set({ deliveryStatus: "delivered" })
      .where(eq(invoiceSends.invoiceId, invoiceId));
    const expected = entries.toSorted(
      (left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() ||
        compareCodeUnit(right.id, left.id),
    );
    const first = await listSendHistory(invoiceId, { limit: 20 });
    expect(first.limit).toBe(20);
    expect(first.items).toHaveLength(20);
    expect(first.items.slice(0, 2).map(({ linkStatus }) => linkStatus)).toEqual(
      ["active", "active"],
    );
    expect(first.nextCursor).not.toBeNull();
    const newest = first.items.at(0);
    if (newest === undefined) {
      return panic("Expected the newest active invoice link on the first page");
    }
    expect(await revoke(invoiceId, newest.id)).toMatchObject({ id: newest.id });
    expect((await listSendHistory(invoiceId)).items.at(0)).toMatchObject({
      id: newest.id,
      linkStatus: "revoked",
    });
    const collectedIds = first.items.map(({ id }) => id);
    const cursors = new Set<string>();
    let cursor = first.nextCursor;
    while (cursor !== null) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
      const page = await listSendHistory(invoiceId, { limit: 20, cursor });
      expect(page.items.length).toBeLessThanOrEqual(20);
      collectedIds.push(...page.items.map(({ id }) => id));
      cursor = page.nextCursor;
    }
    expect(collectedIds).toEqual(expected.map(({ id }) => id));
    expect(new Set(collectedIds).size).toBe(101);
    expect(collectedIds.at(-1)).toBe(expected.at(-1)?.id);
  });

  test("an unverified authorized member can list and revoke history but cannot send", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    const sent = await send(invoiceId, ["unverified-reader@example.test"]);
    if (!("id" in sent)) {
      return panic("Expected a live link before the member becomes unverified");
    }
    const token = tokenSentTo("unverified-reader@example.test");
    await testDb
      .update(authUser)
      .set({ emailVerified: false })
      .where(eq(authUser.id, ids.userA1));
    try {
      const listed = await listSendHistory(invoiceId);
      expect(listed.replyTo).toBeNull();
      expect(listed.items).toMatchObject([
        { id: sent.id, linkStatus: "active" },
      ]);
      expect(await revoke(invoiceId, sent.id)).toMatchObject({ id: sent.id });
      expect((await post(server, "view", { token })).status).toBe(404);
      const transportedBefore = delivered.length;
      expect(
        await send(invoiceId, ["unverified-refused@example.test"]),
      ).toMatchObject({ code: 404 });
      expect(delivered).toHaveLength(transportedBefore);
      expect(await sendRows(invoiceId)).toHaveLength(1);
    } finally {
      await testDb
        .update(authUser)
        .set({ emailVerified: true })
        .where(eq(authUser.id, ids.userA1));
    }
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
      items: [
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
  test("public token scopes have no matter authority while authenticated matter reads remain available", async () => {
    const { token } = await sentInvoice("narrow-public-scope@example.test");
    const base = tokenDb();
    const authenticated = await base.scoped({
      organizationId: ids.orgA,
      userId: ids.userA1,
      workspaceIds: [ids.wsA1],
    })(
      async (tx) =>
        await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, ids.wsA1)),
    );
    expect(authenticated).toEqual([{ id: ids.wsA1 }]);
    let checkedScopes = 0;
    const database = {
      tenantless: base.tenantless,
      scoped: (scope) => {
        expect(scope.userId).toBeNull();
        expect(scope.workspaceIds).toEqual([]);
        return async (read) =>
          await base.scoped(scope)(async (tx) => {
            expect(
              await tx
                .select({ id: workspaces.id })
                .from(workspaces)
                .where(eq(workspaces.id, ids.wsA1)),
            ).toEqual([]);
            checkedScopes += 1;
            return await read(tx);
          });
      },
    } satisfies TokenScopedDatabase;
    await using target = serveForTest(
      createHttpApp({
        routes: linkRoutes({ database, budget: budgetOf(1000) }),
        middleware: [errorBoundary],
      }),
    );
    expect((await post(target, "view", { token })).status).toBe(200);
    for (const file of ["pdf", "e_invoice"]) {
      expect((await post(target, "download", { token, file })).status).toBe(
        200,
      );
    }
    expect(checkedScopes).toBeGreaterThan(0);
  });

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
      const invoiceId = await seedInvoice({ status: INVOICE_STATUS.SENT });
      const expiresAt = new Date(
        Date.now() + (invalidation === "expired" ? 2000 : 86_400_000),
      );
      const { token } = await createStandaloneLink(invoiceId, { expiresAt });
      let completedWork = false;
      const invalidate = async () => {
        if (invalidation === "revoked") {
          await testDb
            .update(invoiceSends)
            .set({ revokedAt: new Date() })
            .where(eq(invoiceSends.invoiceId, invoiceId));
        } else {
          await waitForExternalState({
            description:
              "the invoice link passes its stored expiry while its response is prepared",
            read: async () => {
              const [clock] = await testDb
                .select({
                  expired:
                    sql`pg_catalog.clock_timestamp() >= ${expiresAt.toISOString()}::timestamptz`.mapWith(
                      Boolean,
                    ),
                })
                .from(sql`(VALUES (1)) AS clock(value)`);
              return clock?.expired === true;
            },
          });
        }
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
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.SENT });
    const { token } = await createStandaloneLink(invoiceId, {
      expiresAt: new Date(Date.now() - 1000),
    });
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

  test("the invoice link transition matrix exercises the entire canonical graph", () => {
    expect(
      invoiceGraphEdges.map(({ from, to }) => `${from[0]}:${to}`).toSorted(),
    ).toEqual(
      Object.entries(DATABASE_TRANSITIONS.invoices.edges)
        .flatMap(([from, targets]) => targets.map((to) => `${from}:${to}`))
        .toSorted(),
    );
  });

  test.each(invoiceGraphEdges)(
    "the canonical invoice engine applies link authority for %j",
    async (edge) => {
      const invoiceId = await seedInvoice({ status: edge.from[0] });
      await createStandaloneLink(invoiceId);
      await createStandaloneLink(invoiceId, {
        deliveryStatus: "pending",
      });
      const now = new Date();
      const recordAuditEvent = invoiceTransitionRecorder();
      const moved = await tokenDb().scoped({
        organizationId: ids.orgA,
        userId: ids.userA1,
        workspaceIds: [ids.wsA1],
      })(
        async (tx) =>
          await transitionStatus({
            tx,
            spec: DATABASE_TRANSITIONS.invoices,
            id: invoiceId,
            options: { ...edge, set: { updatedAt: now } },
            effectContext: {
              organizationId: ids.orgA,
              actorUserId: ids.userA1,
              now,
              recordAuditEvent,
            },
            recordTransitionAuditEvent: async (auditTx, row) =>
              await recordAuditEvent(auditTx, {
                action: AUDIT_ACTION.UPDATE,
                resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
                resourceId: row.id,
                changes: { status: { old: edge.from[0], new: row.status } },
              }),
          }),
      );
      expect(moved.type).toBe("transitioned");
      const shouldRevoke =
        edge.from[0] !== INVOICE_STATUS.DRAFT &&
        (edge.to === INVOICE_STATUS.DRAFT || edge.to === INVOICE_STATUS.VOID);
      const rows = await sendRows(invoiceId);
      for (const row of rows) {
        expect(row.revokedAt).toEqual(shouldRevoke ? now : null);
        expect(row.revokedByUserId).toEqual(shouldRevoke ? ids.userA1 : null);
      }
      const audits = await testDb
        .select({ metadata: auditLogs.metadata })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, invoiceId));
      expect(
        audits.filter(
          ({ metadata }) => metadata?.["invoiceSendId"] !== undefined,
        ),
      ).toHaveLength(shouldRevoke ? 2 : 0);
    },
  );

  test("a mixed-source invoice batch revokes only rows that actually leave issued states", async () => {
    const draftId = await seedInvoice({ status: INVOICE_STATUS.DRAFT });
    const finalizedId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    await createStandaloneLink(draftId);
    await createStandaloneLink(finalizedId);
    const now = new Date();
    const recordAuditEvent = invoiceTransitionRecorder();
    const moved = await tokenDb().scoped({
      organizationId: ids.orgA,
      userId: ids.userA1,
      workspaceIds: [ids.wsA1],
    })(
      async (tx) =>
        await transitionBatch({
          tx,
          spec: DATABASE_TRANSITIONS.invoices,
          ids: [draftId, finalizedId],
          options: {
            from: [INVOICE_STATUS.DRAFT, INVOICE_STATUS.FINALIZED],
            to: INVOICE_STATUS.DRAFT,
          },
          effectContext: {
            organizationId: ids.orgA,
            actorUserId: ids.userA1,
            now,
            recordAuditEvent,
          },
          recordTransitionAuditEvent: async (auditTx, rows) =>
            await recordAuditEvent(
              auditTx,
              rows.map((row) => ({
                action: AUDIT_ACTION.UPDATE,
                resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
                resourceId: row.id,
                changes: {
                  status: {
                    old:
                      row.id === draftId
                        ? INVOICE_STATUS.DRAFT
                        : INVOICE_STATUS.FINALIZED,
                    new: row.status,
                  },
                },
              })),
            ),
        }),
    );
    expect(moved).toHaveLength(2);
    expect((await sendRows(draftId)).at(0)?.revokedAt).toBeNull();
    expect((await sendRows(finalizedId)).at(0)?.revokedAt).toEqual(now);
  });

  test("reverting a finalized invoice permanently revokes its historical and pending links before edits and re-finalizing", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    // A historical delivered link may predate the current send owner, which
    // moves a newly delivered finalized invoice to sent.
    const original = await createStandaloneLink(invoiceId);
    const pending = await createStandaloneLink(invoiceId, {
      deliveryStatus: "pending",
    });
    expect((await post(server, "view", { token: original.token })).status).toBe(
      200,
    );

    const revocationAudits: AuditEvent[] = [];
    expect(
      await transitionLinkedInvoice(invoiceId, {
        action: "revert_to_draft",
        auditEvents: revocationAudits,
      }),
    ).toEqual({ id: invoiceId });
    const revoked = await sendRows(invoiceId);
    expect(revoked).toHaveLength(2);
    for (const row of revoked) {
      expect(row.revokedAt).toBeInstanceOf(Date);
      expect(row.revokedByUserId).toBe(ids.userA1);
    }
    expect(
      revocationAudits
        .filter(
          (event) =>
            event.resourceType === AUDIT_RESOURCE_TYPE.INVOICE &&
            event.changes?.["linkRevoked"]?.new === true,
        )
        .map((event) => event.metadata?.["invoiceSendId"])
        .toSorted(),
    ).toEqual(revoked.map(({ id }) => id).toSorted());
    expect(
      await updateInvoice.handler(
        asTestRaw<Parameters<typeof updateInvoice.handler>[0]>(
          memberContext({
            tenant: "A",
            invoiceId,
            route: "/v1/invoices/:workspaceId/:invoiceId",
            body: {
              reference: "EDITED-REF",
              notes: "Reissued payment details",
            },
          }),
        ),
      ),
    ).toEqual({ id: invoiceId });
    expect(
      await transitionLinkedInvoice(invoiceId, { action: "finalize" }),
    ).toEqual({ id: invoiceId });

    expect((await post(server, "view", { token: original.token })).status).toBe(
      404,
    );
    expect(
      (await post(server, "download", { token: original.token, file: "pdf" }))
        .status,
    ).toBe(404);
    expect(
      (
        await post(server, "download", {
          token: original.token,
          file: "e_invoice",
        })
      ).status,
    ).toBe(404);
    expect((await post(server, "view", { token: pending.token })).status).toBe(
      404,
    );
    expect(await send(invoiceId, ["reissued@example.test"])).toMatchObject({
      deliveryStatus: "delivered",
    });
    const opened = await post(server, "view", {
      token: tokenSentTo("reissued@example.test"),
    });
    expect(opened.status).toBe(200);
    expect(JSON.stringify(await opened.json())).toContain("EDITED-REF");
  });

  test("the real sent-to-void transition revokes every send and preserves other invoices' links", async () => {
    const closed = await sentInvoice("void-transition@example.test");
    expect(
      await send(closed.invoiceId, ["void-transition-again@example.test"]),
    ).toMatchObject({ deliveryStatus: "delivered" });
    const sibling = await sentInvoice("void-sibling@example.test");
    const revocationAudits: AuditEvent[] = [];
    expect(
      await transitionLinkedInvoice(closed.invoiceId, {
        action: "void",
        auditEvents: revocationAudits,
      }),
    ).toEqual({ id: closed.invoiceId });
    const revoked = await sendRows(closed.invoiceId);
    expect(revoked).toHaveLength(2);
    for (const row of revoked) {
      expect(row.revokedAt).toBeInstanceOf(Date);
    }
    expect(
      revocationAudits.filter(
        (event) =>
          event.resourceType === AUDIT_RESOURCE_TYPE.INVOICE &&
          event.changes?.["linkRevoked"]?.new === true,
      ),
    ).toHaveLength(2);
    expect((await post(server, "view", { token: closed.token })).status).toBe(
      404,
    );
    expect(
      (
        await post(server, "view", {
          token: tokenSentTo("void-transition-again@example.test"),
        })
      ).status,
    ).toBe(404);
    expect((await post(server, "view", { token: sibling.token })).status).toBe(
      200,
    );
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
    await testDb.insert(featureEnrolments).values({
      organizationId: ids.orgA,
      userId: senderId,
      featureId: "time-billing",
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
          .select(INVOICE_LINK_DOCUMENT_PROJECTION)
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

describe("public invoice document descriptions", () => {
  test("legacy attached time prints the same descriptions as the authenticated PDF", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.SENT });
    await testDb
      .update(invoices)
      .set({ netAmount: null })
      .where(eq(invoices.id, invoiceId));
    const descriptions = [
      { invoiceNarrative: null, narrative: "Legacy invoice work" },
      { invoiceNarrative: "", narrative: "Empty invoice narrative fallback" },
      { invoiceNarrative: " \t\r\n", narrative: "Whitespace fallback" },
      {
        invoiceNarrative: "\u00a0\u2007\ufeff",
        narrative: "Unicode whitespace fallback",
      },
      {
        invoiceNarrative:
          "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",
        narrative: "Every document whitespace fallback",
      },
      {
        invoiceNarrative: "Client-facing invoice work",
        narrative: "Internal work detail",
      },
      {
        invoiceNarrative: "  Preserved invoice spacing  ",
        narrative: "Internal work detail",
      },
      { invoiceNarrative: null, narrative: " \t\u2028\u2029" },
      {
        invoiceNarrative: null,
        narrative: `${"x".repeat(INVOICE_LINE_INPUT_LIMITS.descriptionMaxChars - 1)}\u{1f4c4}`,
      },
    ];
    await testDb.insert(timeEntries).values(
      descriptions.map((description, index) => ({
        id: createSafeId<"timeEntry">(),
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        invoiceId,
        dateWorked: `2026-10-${String(index + 1).padStart(2, "0")}`,
        timezoneId: "Europe/Prague",
        durationMinutes: 60,
        billedMinutes: 60,
        rateAtEntry: cents(10_000),
        currency: "CZK",
        ...description,
        status: "approved" as const,
      })),
    );
    const { token } = await createStandaloneLink(invoiceId);
    const database = tokenDb();
    const scope = await resolveInvoiceLink(database, token);
    if (scope === null) {
      return panic("Expected a live legacy invoice link");
    }
    const publicScope = database.scoped({
      organizationId: ids.orgA,
      userId: null,
      workspaceIds: [],
    });
    const linked = await publicScope((tx) =>
      loadLinkedInvoiceData(tx, { ...scope, scopedDb: publicScope }),
    );
    const authenticated = await database.scoped({
      organizationId: ids.orgA,
      userId: ids.userA1,
      workspaceIds: [ids.wsA1],
    })((tx) =>
      loadInvoiceDocument(tx, {
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        invoiceId,
      }),
    );
    if (linked === null || authenticated === null) {
      return panic("Expected both authorized legacy invoice documents");
    }
    const publicLines = invoiceDocumentRenderOptions(linked.document).invoice
      .lines;
    const authenticatedLines =
      invoiceDocumentRenderOptions(authenticated).invoice.lines;
    expect(authenticatedLines.map(({ description }) => description)).toContain(
      "Legacy invoice work",
    );
    expect(
      authenticatedLines.map(({ description }) => description),
    ).not.toContain("Internal work detail");
    expect(publicLines).toEqual(authenticatedLines);
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
    const expired = await createStandaloneLink(expiredInvoice, {
      expiresAt: new Date(Date.now() - 1000),
    });
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
