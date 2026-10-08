import { toSafeId } from "@stll/api-contract/safe-id";
import { cents } from "@stll/money";

type DockedChatPageFixtureOptions = {
  workspaceId: string;
  /** The world fixture's uploaded document id; also names these HTTP-only records. */
  resourceId: string;
};

export const dockedChatPagePayloads = ({
  workspaceId,
  resourceId,
}: DockedChatPageFixtureOptions) => {
  const timestamp = "2026-01-15T10:00:00.000Z";
  const invoice = {
    id: toSafeId<"invoice">(resourceId),
    workspaceId: toSafeId<"workspace">(workspaceId),
    organizationId: toSafeId<"organization">(resourceId),
    status: "draft" as const,
    documentType: "invoice" as const,
    currency: "EUR" as const,
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
    billingMode: "hourly" as const,
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
  };
  const report = {
    status: "completed" as const,
    error: null,
    resultEntityId: toSafeId<"entity">(resourceId),
    resultFieldId: null,
    downloadUrl: null,
  };
  const correspondence = {
    record: {
      id: toSafeId<"correspondence">(resourceId),
      source: "delivery" as const,
      intake: "direct" as const,
      authenticatedSender: {
        address: "sender@example.test",
        spf: "pass" as const,
        dkim: "pass" as const,
        dmarc: "pass" as const,
        alignedIdentifier: "example.test",
      },
      originalSignature: null,
      direction: "in" as const,
      channel: "email" as const,
      subject: "Docked chat correspondence fixture",
      from: { name: "Fixture sender", address: "sender@example.test" },
      to: [{ name: "Fixture recipient", address: "recipient@example.test" }],
      cc: [],
      receivedAt: timestamp,
      sentAt: timestamp,
      handlingState: "new" as const,
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
  };
  const registryLookup = {
    type: "lookup" as const,
    registry: "companies-house" as const,
    hit: null,
  };
  return { invoice, report, correspondence, registryLookup };
};
