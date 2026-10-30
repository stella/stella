import { describe, expect, test } from "bun:test";

import { invoiceSends } from "@/api/db/schema";
import type { InvoiceSendDeliveryStatus } from "@/api/db/schema";
import { projectInvoiceSend } from "@/api/handlers/invoices/sends/projection";
import { toSafeId } from "@/api/lib/branded-types";

const NOW = new Date("2026-10-29T12:00:00.000Z");
const REVOKED_AT = new Date("2026-10-29T11:00:00.000Z");
const LIVE_UNTIL = new Date("2026-10-30T12:00:00.000Z");

const LIVE_LINK_STATUS = {
  pending: "pending",
  delivered: "active",
  partial: "active",
  failed: "failed",
} as const satisfies Record<InvoiceSendDeliveryStatus, string>;

const cases = invoiceSends.deliveryStatus.enumValues.flatMap((deliveryStatus) =>
  [null, REVOKED_AT].flatMap((revokedAt) =>
    [NOW, LIVE_UNTIL].map((expiresAt) => ({
      deliveryStatus,
      revokedAt,
      expiresAt,
    })),
  ),
);

describe("invoice send history link states", () => {
  for (const { deliveryStatus, revokedAt, expiresAt } of cases) {
    const revoked = revokedAt !== null;
    const expired = expiresAt <= NOW;
    test(`${deliveryStatus}, ${revoked ? "revoked" : "unrevoked"}, ${expired ? "expired" : "unexpired"}`, () => {
      const row = {
        id: toSafeId<"invoiceSend">("019a2e4b-0000-7000-8000-000000000001"),
        recipients: ["client@example.test", "billing@example.test"],
        failedRecipients: {
          failed: ["client@example.test", "billing@example.test"],
          partial: ["billing@example.test"],
          delivered: [],
          pending: [],
        }[deliveryStatus],
        message: null,
        replyTo: "sender@example.test",
        language: "cs",
        deliveryStatus,
        expiresAt,
        revokedAt,
        firstViewedAt: null,
        createdAt: new Date("2026-10-29T10:00:00.000Z"),
        sentBy: null,
      } satisfies Parameters<typeof projectInvoiceSend>[0];
      const expected = () => {
        if (deliveryStatus === "failed") {
          return "failed";
        }
        if (revoked) {
          return "revoked";
        }
        if (expired) {
          return "expired";
        }
        return LIVE_LINK_STATUS[deliveryStatus];
      };
      const projected = projectInvoiceSend(row, NOW);
      expect(projected.linkStatus).toBe(expected());
      if (deliveryStatus === "pending" && !revoked && !expired) {
        expect(projected.linkStatus).not.toBe("active");
      }
    });
  }
});
