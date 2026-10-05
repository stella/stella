import { PDF } from "@libpdf/core";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { INVOICE_LINE_SOURCE } from "@stll/api-contract";

import { user as authUser } from "@/api/db/auth-schema";
import {
  invoiceLines,
  invoices,
  INVOICE_STATUS,
  featureEnrolments,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import type exportInvoicePdf from "@/api/handlers/invoices/pdf/export";
import { createInvoicePdfExport } from "@/api/handlers/invoices/pdf/export";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { S3_OBJECT_WRITE_CERTAINTY } from "@/api/lib/s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
const invoiceId = createSafeId<"invoice">();
beforeAll(async () => {
  fixture = await getRlsFixture();

  await fixture.testDb
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [fixture.ids.userA1, fixture.ids.userB1]));
  await fixture.testDb
    .insert(featureEnrolments)
    .values([
      {
        organizationId: fixture.ids.orgA,
        userId: fixture.ids.userA1,
        featureId: "time-billing",
      },
      {
        organizationId: fixture.ids.orgB,
        userId: fixture.ids.userB1,
        featureId: "time-billing",
      },
    ])
    .onConflictDoNothing();
  await fixture.testDb.insert(invoices).values({
    id: invoiceId,
    organizationId: fixture.ids.orgA,
    workspaceId: fixture.ids.wsA1,
    invoiceDate: "2026-09-30",
    status: INVOICE_STATUS.DRAFT,
    currency: "CZK",
    netAmount: cents(500_000),
    vatAmount: cents(105_000),
    totalAmount: cents(605_000),
  });
  await fixture.testDb.insert(invoiceLines).values({
    organizationId: fixture.ids.orgA,
    workspaceId: fixture.ids.wsA1,
    invoiceId,
    position: 0,
    description: "Contract review",
    quantity: "2.5",
    unit: "h",
    unitPrice: cents(200_000),
    vatRateBps: 2100,
    vatTreatment: "domestic_vat",
    netAmount: cents(500_000),
    vatAmount: cents(105_000),
    grossAmount: cents(605_000),
    source: INVOICE_LINE_SOURCE.MANUAL,
  });
});
afterAll(async () => {
  await fixture.testDb
    .delete(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId));
  await fixture.testDb.delete(invoices).where(eq(invoices.id, invoiceId));
  await releaseRlsFixture();
});

const context = (
  scope: "own" | "neighbour" | "other",
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
  return asTestRaw<Parameters<typeof exportInvoicePdf.handler>[0]>({
    getActiveWorkspaceIds: async () => [workspaceId],
    getAccessibleWorkspaces: async () => [
      { id: workspaceId, status: "active" },
    ],
    getWorkspaceAccess: async () => ({ id: workspaceId, status: "active" }),
    params: { workspaceId, invoiceId },
    query: {},
    body: {},
    createAuditRecorder: () => recordAuditEvent,
    recordAuditEvent,
    memberRole: sessionMemberRole("owner"),
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    promptCachingEnabled: false,
    request: new Request("https://example.test/invoice/pdf", {
      method: "POST",
    }),
    route: "/test/invoice/pdf",
    safeDb: createSafeDb(testDb, [workspaceId], organizationId, userId),
    scopedDb: createScopedDb(testDb, [workspaceId], organizationId, userId),
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
    workspaceId,
  });
};

describe("invoice document export", () => {
  test("returns an expiring scoped artifact and records its download", async () => {
    const events: AuditEvent[] = [];
    const writes: Parameters<
      NonNullable<Parameters<typeof createInvoicePdfExport>[0]>
    >[0][] = [];
    const handler = createInvoicePdfExport(async (object) => {
      writes.push(object);
      return S3_OBJECT_WRITE_CERTAINTY.CONFIRMED;
    });
    const response = await handler.handler(context("own", events));
    expect(response).toMatchObject({ fileName: "invoice-draft.pdf" });
    expect("downloadUrl" in response).toBe(true);
    if (!("downloadUrl" in response)) {
      return;
    }
    const url = new URL(response.downloadUrl);
    expect(url.pathname).toContain(
      `exports/${fixture.ids.orgA}/${fixture.ids.wsA1}/invoices/${invoiceId}/`,
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("response-content-disposition")).toContain(
      "invoice-draft.pdf",
    );
    expect(url.searchParams.get("response-cache-control")).toContain(
      "no-store",
    );
    expect(Date.parse(response.expiresAt) - Date.now()).toBeGreaterThan(
      290_000,
    );
    expect(writes).toHaveLength(1);
    const written = writes.at(0);
    expect(written?.contentType).toBe("application/pdf");
    expect(written?.key).toContain(
      `exports/${fixture.ids.orgA}/${fixture.ids.wsA1}/`,
    );
    if (!(written?.data instanceof Uint8Array)) {
      throw new Error("the export stored no PDF bytes");
    }
    expect(new TextDecoder().decode(written.data)).toStartWith("%PDF-");
    const text = (await PDF.load(written.data))
      .extractText()
      .map((page) => page.text)
      .join("\n");
    expect(text).toContain("Contract review");
    expect(text).toContain("Quantity: 2.5 h");
    expect(text).toContain("Unit price:");
    expect(events).toHaveLength(1);
    expect(events.at(0)).toMatchObject({
      action: "download",
      resourceType: "invoice",
      resourceId: invoiceId,
      workspaceId: fixture.ids.wsA1,
    });
  });
  test("refuses delivery without a download audit when storage fails", async () => {
    const events: AuditEvent[] = [];
    const handler = createInvoicePdfExport(async () => {
      throw new HandlerError({ status: 502, message: "Storage unavailable" });
    });
    const response = await handler.handler(context("own", events));
    expect(response).toMatchObject({ code: 502 });
    expect(response).not.toHaveProperty("downloadUrl");
    expect(events).toHaveLength(0);
  });
  test.each(["neighbour", "other"] as const)(
    "returns no document or audit event for the %s scope",
    async (scope) => {
      const events: AuditEvent[] = [];
      let writes = 0;
      const handler = createInvoicePdfExport(async () => {
        writes += 1;
        return S3_OBJECT_WRITE_CERTAINTY.CONFIRMED;
      });
      const response = await handler.handler(context(scope, events));
      expect(writes).toBe(0);
      expect(response).toMatchObject({ code: 404 });
      expect(events).toHaveLength(0);
    },
  );
});
