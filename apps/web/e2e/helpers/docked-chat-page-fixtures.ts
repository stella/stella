import type { Page } from "@playwright/test";

import type { CorrespondenceDetailResponse } from "@stll/api-contract/correspondence";
import { toSafeId } from "@stll/api-contract/safe-id";
import { cents } from "@stll/money";

import type { WebRoutes } from "../../src/generated/api-routes.gen";
import { E2E_API_ORIGIN } from "./api";

type RegistryLookup =
  WebRoutes["v1"]["contacts"]["business-registries"]["get"]["response"][200];

type InvoiceDetail =
  WebRoutes["v1"]["invoices"][":workspaceId"][":invoiceId"]["get"]["response"][200];
type ReportRecovery =
  WebRoutes["v1"]["workspaces"][":workspaceId"]["reports"][":exportId"]["get"]["response"][200];

type DockedChatPageFixtureOptions = {
  workspaceId: string;
  /** The world fixture's uploaded document id; also names these HTTP-only records. */
  resourceId: string;
};

/** Rich route-content reads keep the real shell and dock mounted without domain writes. */
export const installDockedChatPageFixtures = async (
  page: Page,
  { workspaceId, resourceId }: DockedChatPageFixtureOptions,
) => {
  const timestamp = "2026-01-15T10:00:00.000Z";
  const invoice = {
    id: toSafeId<"invoice">(resourceId),
    workspaceId: toSafeId<"workspace">(workspaceId),
    organizationId: toSafeId<"organization">(resourceId),
    status: "draft",
    documentType: "invoice",
    currency: "EUR",
    invoiceNumber: null,
    invoiceDate: "2026-01-15",
    dueDate: "2026-02-15",
    taxableSupplyDate: null,
    reference: null,
    originalInvoiceId: null,
    sellerProfileId: null,
    buyerName: "Geometry fixture buyer",
    buyerRegistrationId: null,
    buyerVatId: null,
    buyerAddressLine1: null,
    buyerAddressLine2: null,
    buyerCity: null,
    buyerPostalCode: null,
    buyerCountry: null,
    billingMode: "hourly",
    flatFeeAmount: null,
    notes: null,
    netAmount: cents(0),
    vatAmount: cents(0),
    totalAmount: cents(0),
    totals: {
      netAmountMinor: cents(0),
      vatAmountMinor: cents(0),
      grossAmountMinor: cents(0),
      vatBreakdown: [],
    },
    lines: [],
    timeEntries: [],
    expenses: [],
    paidAt: null,
    finalizedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  } satisfies InvoiceDetail;
  const report = {
    status: "completed",
    error: null,
    resultEntityId: toSafeId<"entity">(resourceId),
    resultFieldId: null,
    downloadUrl: null,
  } satisfies ReportRecovery;
  const correspondence = {
    record: {
      id: toSafeId<"correspondence">(resourceId),
      source: "delivery",
      intake: "direct",
      authenticatedSender: {
        address: "sender@example.test",
        spf: "pass",
        dkim: "pass",
        dmarc: "pass",
        alignedIdentifier: "example.test",
      },
      originalSignature: null,
      direction: "in",
      channel: "email",
      subject: "Docked chat correspondence fixture",
      from: { name: "Fixture sender", address: "sender@example.test" },
      to: [{ name: "Fixture recipient", address: "recipient@example.test" }],
      cc: [],
      receivedAt: timestamp,
      sentAt: timestamp,
      handlingState: "new",
      assigneeId: null,
      messageId: "<docked-chat-geometry@example.test>",
      inReplyTo: null,
      references: [],
      bodyText: "Correspondence content for docked chat geometry.",
      bodyHtml: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    filers: [],
    attachments: [],
  } satisfies CorrespondenceDetailResponse;
  const responses = new Map<string, unknown>([
    [`/v1/invoices/${workspaceId}/${resourceId}`, invoice],
    [`/v1/workspaces/${workspaceId}/reports/${resourceId}`, report],
    [
      `/v1/workspaces/${workspaceId}/correspondence/${resourceId}`,
      correspondence,
    ],
  ]);
  const registryLookup = {
    type: "lookup",
    registry: "companies-house",
    hit: null,
  } satisfies RegistryLookup;
  const apiOrigin = new URL(E2E_API_ORIGIN).origin;
  const isRegistryFixture = (url: URL) =>
    url.pathname === "/v1/contacts/business-registries" &&
    url.searchParams.get("registry") === "companies-house" &&
    url.searchParams.get("q") === "12345678";
  await page.route(
    (url) =>
      url.origin === apiOrigin &&
      (responses.has(url.pathname) || isRegistryFixture(url)),
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const requestUrl = new URL(route.request().url());
      const pathname = requestUrl.pathname;
      // A successful no-match lookup renders the real registry page without
      // credentials, an external request, or a fabricated registry record.
      const response = isRegistryFixture(requestUrl)
        ? registryLookup
        : responses.get(pathname);
      if (response === undefined) {
        throw new Error(`Missing docked-chat page fixture for ${pathname}`);
      }
      await route.fulfill({ status: 200, json: response });
    },
  );
};
