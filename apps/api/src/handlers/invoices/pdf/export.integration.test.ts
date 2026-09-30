import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { invoices, INVOICE_STATUS } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import exportInvoicePdf from "@/api/handlers/invoices/pdf/export";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
const invoiceId = createSafeId<"invoice">();
beforeAll(async () => {
  fixture = await getRlsFixture();
  await fixture.testDb.insert(invoices).values({
    id: invoiceId,
    organizationId: fixture.ids.orgA,
    workspaceId: fixture.ids.wsA1,
    invoiceDate: "2026-09-30",
    status: INVOICE_STATUS.DRAFT,
    currency: "CZK",
    totalAmount: cents(0),
  });
});
afterAll(async () => {
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
    memberRole: { role: "owner" },
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    promptCachingEnabled: false,
    request: new Request("https://example.test/invoice/pdf"),
    route: "/test/invoice/pdf",
    safeDb: createSafeDb(testDb, [workspaceId], organizationId, userId),
    scopedDb: createScopedDb(testDb, [workspaceId], organizationId, userId),
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
    workspaceId,
  });
};

describe("invoice document export", () => {
  test("returns a private draft attachment and records its download", async () => {
    const events: AuditEvent[] = [];
    const response = await exportInvoicePdf.handler(context("own", events));
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) {
      return;
    }
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain(
      "invoice-draft.pdf",
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toStartWith("%PDF-");
    expect(events).toHaveLength(1);
    expect(events.at(0)).toMatchObject({
      action: "download",
      resourceType: "invoice",
      resourceId: invoiceId,
    });
  });
  test.each(["neighbour", "other"] as const)(
    "returns no document or audit event for the %s scope",
    async (scope) => {
      const events: AuditEvent[] = [];
      const response = await exportInvoicePdf.handler(context(scope, events));
      expect(response).toMatchObject({ code: 404 });
      expect(events).toHaveLength(0);
    },
  );
});
