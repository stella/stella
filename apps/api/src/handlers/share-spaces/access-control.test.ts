import { describe, expect, test } from "bun:test";

import requestShareOtp from "@/api/handlers/share-spaces/request-otp";
import {
  isShareInvitationSecret,
  normalizeRecipientEmail,
} from "@/api/lib/share-space-access";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

describe("Share Space recipient access boundary", () => {
  test("accepts only canonical 256-bit base64url invitation secrets", () => {
    expect(isShareInvitationSecret("a".repeat(43))).toBe(true);
    expect(isShareInvitationSecret("a".repeat(42))).toBe(false);
    expect(isShareInvitationSecret("a".repeat(44))).toBe(false);
    expect(isShareInvitationSecret(`${"a".repeat(42)}+`)).toBe(false);
    expect(isShareInvitationSecret({ secret: "a".repeat(43) })).toBe(false);
  });

  test("normalizes allowlisted recipient addresses without accepting oversized input", () => {
    expect(normalizeRecipientEmail(" Recipient@Example.COM ")).toBe(
      "recipient@example.com",
    );
    expect(normalizeRecipientEmail(" ")).toBeNull();
    expect(normalizeRecipientEmail("a".repeat(321))).toBeNull();
    expect(normalizeRecipientEmail(null)).toBeNull();
  });

  test("malformed probes receive the same non-enumerating accepted response", async () => {
    const context = asTestRaw<Parameters<typeof requestShareOtp.handler>[0]>({
      body: { invitationSecret: "not-a-secret", email: "not-an-email" },
      request: new Request(
        "https://example.test/v1/share-spaces/access/request-otp",
        {
          method: "POST",
        },
      ),
    });

    const response = await Promise.resolve(requestShareOtp.handler(context));
    expect(response).toEqual({
      accepted: true,
    });
  });
});
