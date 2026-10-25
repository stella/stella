import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { INVOICE_LINE_SOURCE } from "@stll/api-contract";

import { user as authUser } from "@/api/db/auth-schema";
import {
  featureEnrolments,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  sellerProfiles,
  workspaceMembers,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import type exportInvoices from "@/api/handlers/invoices/export";
import { createInvoicesExport } from "@/api/handlers/invoices/export";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { S3_OBJECT_WRITE_CERTAINTY } from "@/api/lib/s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
const sellerId = createSafeId<"sellerProfile">();
const issuedId = createSafeId<"invoice">();
const draftId = createSafeId<"invoice">();

beforeAll(async () => {
  fixture = await getRlsFixture();
  const { testDb, ids } = fixture;
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
  await testDb.insert(sellerProfiles).values({
    id: sellerId,
    organizationId: ids.orgA,
    legalName: "Novák & Partners s.r.o.",
    registrationId: "12345678",
    vatId: "CZ12345678",
    city: "Praha",
    country: "CZ",
    accountNumber: "19-2000145399/0800",
    defaultCurrency: "CZK",
  });
  const invoice = {
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    invoiceDate: "2026-09-30",
    taxableSupplyDate: "2026-09-30",
    dueDate: "2026-10-14",
    currency: "CZK",
    sellerProfileId: sellerId,
    buyerName: "Zelená louka a.s.",
    buyerRegistrationId: "87654321",
    buyerCountry: "CZ",
    netAmount: cents(500_000),
    vatAmount: cents(105_000),
    totalAmount: cents(605_000),
  };
  await testDb.insert(invoices).values([
    {
      ...invoice,
      id: issuedId,
      invoiceNumber: "20260016",
      status: INVOICE_STATUS.FINALIZED,
      finalizedAt: new Date("2026-09-30T10:00:00Z"),
    },
    { ...invoice, id: draftId, status: INVOICE_STATUS.DRAFT },
  ]);
  await testDb.insert(invoiceLines).values(
    [issuedId, draftId].map((invoiceId) => ({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      invoiceId,
      position: 0,
      description: "Contract review",
      quantity: "2.5",
      unit: "h",
      unitPrice: cents(200_000),
      vatRateBps: 2100,
      vatTreatment: "domestic_vat" as const,
      netAmount: cents(500_000),
      vatAmount: cents(105_000),
      grossAmount: cents(605_000),
      source: INVOICE_LINE_SOURCE.MANUAL,
    })),
  );
});

afterAll(async () => {
  const { testDb } = fixture;
  await testDb
    .delete(invoiceLines)
    .where(inArray(invoiceLines.invoiceId, [issuedId, draftId]));
  await testDb
    .delete(invoices)
    .where(inArray(invoices.id, [issuedId, draftId]));
  await testDb.delete(sellerProfiles).where(eq(sellerProfiles.id, sellerId));
  await releaseRlsFixture();
});

type ExportBody = Parameters<typeof exportInvoices.handler>[0]["body"];

const context = (
  scope: "own" | "neighbour" | "other",
  body: ExportBody,
  auditEvents: AuditEvent[],
) => {
  const { testDb, ids } = fixture;
  const scopes = {
    own: {
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
      userId: ids.userA1,
    },
    neighbour: {
      workspaceId: ids.wsA2,
      organizationId: ids.orgA,
      userId: ids.userA1,
    },
    other: {
      workspaceId: ids.wsB1,
      organizationId: ids.orgB,
      userId: ids.userB1,
    },
  };
  const { workspaceId, organizationId, userId } = scopes[scope];
  const recordAuditEvent = async (
    _tx: unknown,
    events: AuditEvent | AuditEvent[],
  ) => {
    auditEvents.push(...(Array.isArray(events) ? events : [events]));
  };
  return asTestRaw<Parameters<typeof exportInvoices.handler>[0]>({
    getActiveWorkspaceIds: async () => [workspaceId],
    getAccessibleWorkspaces: async () => [
      { id: workspaceId, status: "active" },
    ],
    getWorkspaceAccess: async () => ({ id: workspaceId, status: "active" }),
    params: { workspaceId },
    query: {},
    body,
    createAuditRecorder: () => recordAuditEvent,
    recordAuditEvent,
    memberRole: sessionMemberRole("owner"),
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    promptCachingEnabled: false,
    request: new Request("https://example.test/invoices/export", {
      method: "POST",
      headers: { "Accept-Language": "cs" },
    }),
    route: "/test/invoices/export",
    safeDb: createSafeDb(testDb, [workspaceId], organizationId, userId),
    scopedDb: createScopedDb(testDb, [workspaceId], organizationId, userId),
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
    workspaceId,
  });
};

const capturingExport = () => {
  const writes: Parameters<
    NonNullable<Parameters<typeof createInvoicesExport>[0]>
  >[0][] = [];
  const handler = createInvoicesExport(async (object) => {
    writes.push(object);
    return S3_OBJECT_WRITE_CERTAINTY.CONFIRMED;
  });
  return { handler, writes };
};

const writtenText = (data: unknown): string => {
  if (!(data instanceof Uint8Array)) {
    throw new Error("the export stored no bytes");
  }
  return new TextDecoder().decode(data);
};

describe("invoice export", () => {
  test.each([
    "xlsx",
    "xlsx_lines",
    "pohoda",
    "money_s3",
    "flexibee",
    "isdoc",
    "ubl",
    "ksef_fa3",
    "eso9",
    "ledes_1998b",
  ] as const)(
    "refuses %s when home-currency VAT would be omitted",
    async (format) => {
      await fixture.testDb
        .update(invoices)
        .set({
          vatExchangeRate: "25",
          vatExchangeRateSource: "CNB",
          vatExchangeRateDate: "2026-09-29",
          vatExchangeRateTaxPoint: "2026-09-30",
        })
        .where(eq(invoices.id, issuedId));
      try {
        const events: AuditEvent[] = [];
        const { handler, writes } = capturingExport();
        const response = await handler.handler(
          context("own", { format, invoiceIds: [issuedId] }, events),
        );
        expect(response).toMatchObject({
          code: 409,
          response: {
            hint: "This export cannot yet carry the home-currency VAT; use the PDF.",
          },
        });
        expect(writes).toHaveLength(0);
        expect(events).toHaveLength(0);
      } finally {
        await fixture.testDb
          .update(invoices)
          .set({
            vatExchangeRate: null,
            vatExchangeRateSource: null,
            vatExchangeRateDate: null,
            vatExchangeRateTaxPoint: null,
          })
          .where(eq(invoices.id, issuedId));
      }
    },
  );

  test("exports the matter's issued invoices and skips drafts", async () => {
    const events: AuditEvent[] = [];
    const { handler, writes } = capturingExport();
    const response = await handler.handler(
      context("own", { format: "pohoda" }, events),
    );
    expect(response).toMatchObject({
      fileName: expect.stringMatching(/^invoices-.*-pohoda\.xml$/u),
    });
    expect(writes).toHaveLength(1);
    const xml = writtenText(writes.at(0)?.data);
    expect(xml).toContain(
      "<typ:numberRequested>20260016</typ:numberRequested>",
    );
    expect(xml).toContain('ico="12345678"');
    expect(xml.match(/<inv:invoice /gu)).toHaveLength(1);
    expect(events.at(0)).toMatchObject({
      action: "download",
      resourceType: "workspace",
      resourceId: fixture.ids.wsA1,
    });
  });

  test("exports one selected invoice under its own number", async () => {
    const events: AuditEvent[] = [];
    const { handler, writes } = capturingExport();
    const response = await handler.handler(
      context("own", { format: "ledes_1998b", invoiceIds: [issuedId] }, events),
    );
    expect(response).toMatchObject({
      fileName: "invoice-20260016-ledes-1998b.txt",
    });
    const ledes = writtenText(writes.at(0)?.data).split("\r\n");
    expect(ledes[0]).toBe("LEDES1998B[]");
    expect(ledes[2]).toContain("|20260016|87654321|");
    expect(events.at(0)).toMatchObject({
      resourceType: "invoice",
      resourceId: issuedId,
    });
  });

  test("exports stored identifiers trimmed", async () => {
    await fixture.testDb
      .update(sellerProfiles)
      .set({ registrationId: " 12345678 " })
      .where(eq(sellerProfiles.id, sellerId));
    try {
      const { handler, writes } = capturingExport();
      await handler.handler(
        context("own", { format: "pohoda", invoiceIds: [issuedId] }, []),
      );
      expect(writtenText(writes.at(0)?.data)).toContain('ico="12345678"');
    } finally {
      await fixture.testDb
        .update(sellerProfiles)
        .set({ registrationId: "12345678" })
        .where(eq(sellerProfiles.id, sellerId));
    }
  });

  test("refuses a draft in the selection", async () => {
    const events: AuditEvent[] = [];
    const { handler, writes } = capturingExport();
    const response = await handler.handler(
      context(
        "own",
        { format: "xlsx", invoiceIds: [issuedId, draftId] },
        events,
      ),
    );
    expect(response).toMatchObject({ code: 409 });
    expect(writes).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test("refuses delivery when matter access is removed after rendering", async () => {
    const events: AuditEvent[] = [];
    const writes: string[] = [];
    const { testDb, ids } = fixture;
    const handler = createInvoicesExport(async ({ key }) => {
      writes.push(key);
      await testDb
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.id, ids.memberA1wsA1));
      return S3_OBJECT_WRITE_CERTAINTY.CONFIRMED;
    });

    try {
      const response = await handler.handler(
        context("own", { format: "xlsx" }, events),
      );
      expect(response).toMatchObject({ code: 404 });
      expect(response).not.toHaveProperty("downloadUrl");
      expect(writes).toHaveLength(1);
      expect(events).toHaveLength(0);
    } finally {
      await testDb
        .insert(workspaceMembers)
        .values({
          id: ids.memberA1wsA1,
          workspaceId: ids.wsA1,
          userId: ids.userA1,
        })
        .onConflictDoNothing();
    }
  });

  test.each(["neighbour", "other"] as const)(
    "exports nothing from the %s scope",
    async (scope) => {
      const events: AuditEvent[] = [];
      const { handler, writes } = capturingExport();
      const response = await handler.handler(
        context(scope, { format: "xlsx", invoiceIds: [issuedId] }, events),
      );
      expect(response).toMatchObject({ code: expect.any(Number) });
      expect(response).not.toHaveProperty("downloadUrl");
      expect(writes).toHaveLength(0);
      expect(events).toHaveLength(0);
    },
  );
});
