import { describe, expect, test } from "bun:test";

import {
  evaluateInboundAcceptance,
  type SenderMembership,
} from "@/api/lib/inbound-mail/acceptance";
import {
  generateInboundAddressToken,
  parseInboundAddressToken,
} from "@/api/lib/inbound-mail/address";
import type { MailAuthentication } from "@/api/lib/inbound-mail/authentication";

const auth = {
  source: "provider",
  evidence: "identifiers",
  fromDomain: "example.com",
  spf: { result: "pass", domain: "example.com", alignment: "relaxed" },
  dkim: [],
  dmarc: "pass",
} satisfies MailAuthentication;

describe("inbound acceptance", () => {
  test.each([
    { type: "user", userId: "member-id", filedAt: "2026-09-26T12:00:00Z" },
    {
      type: "shared_mailbox",
      allowedSenderId: "mailbox-id",
      address: "office@example.com",
      approvedBy: "admin-id",
      filedAt: "2026-09-26T12:00:00Z",
    },
  ] as const)("retains the authorized filer provenance: %j", (filer) => {
    const membership = { status: "allowed", filer } satisfies SenderMembership;
    expect(
      evaluateInboundAcceptance({
        outerSender: "member@example.com",
        authentication: auth,
        membership,
        scan: "pass",
      }),
    ).toEqual({ status: "accept", filer });
  });

  test("membership, authentication, and scan approval are all necessary", () => {
    for (const memberAllowed of [true, false]) {
      for (const authenticated of [true, false]) {
        for (const scan of ["pass", "fail", "unavailable"] as const) {
          const membership: SenderMembership = memberAllowed
            ? {
                status: "allowed",
                filer: {
                  type: "user",
                  userId: "member-id",
                  filedAt: "2026-09-26T12:00:00Z",
                },
              }
            : { status: "denied" };
          const result = evaluateInboundAcceptance({
            outerSender: "member@example.com",
            authentication: { ...auth, dmarc: authenticated ? "pass" : "none" },
            membership,
            scan,
          });
          expect(result.status === "accept").toBe(
            memberAllowed && authenticated && scan === "pass",
          );
        }
      }
    }
  });

  test("a third party reply-all is dropped despite valid domain authentication", () => {
    expect(
      evaluateInboundAcceptance({
        outerSender: "counterparty@example.com",
        authentication: auth,
        membership: { status: "denied" },
        scan: "pass",
      }),
    ).toEqual({ status: "drop", reason: "sender-not-authorized" });
  });

  test("generated tokens roundtrip only through exact inbound envelope addresses", () => {
    const tokens = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      const token = generateInboundAddressToken();
      tokens.add(token);
      expect(token).toMatch(/^[a-f0-9]{64}$/u);
      const result = parseInboundAddressToken(
        `${token}@MAIL.EXAMPLE.COM`,
        "mail.example.com",
      );
      expect(result.isOk() && result.value).toBe(token);
      for (const address of [
        `${token}+tag@mail.example.com`,
        `${token}@mail.example.com.evil.test`,
        `Name <${token}@mail.example.com>`,
        `${token}@mail.example.com\n`,
        `../${token}@mail.example.com`,
        `${token}@other.test`,
      ]) {
        expect(
          parseInboundAddressToken(address, "mail.example.com").isErr(),
        ).toBe(true);
      }
    }
    expect(tokens.size).toBe(100);
  });
});
