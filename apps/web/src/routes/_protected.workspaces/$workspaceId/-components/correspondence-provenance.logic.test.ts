import { describe, expect, test } from "bun:test";
import { createTranslator } from "use-intl/core";

import {
  CORRESPONDENCE_AUTH_RESULTS,
  type CorrespondenceProvenance,
  type ParsedCorrespondence,
} from "@stll/api-contract/correspondence";

import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";

import { correspondenceProvenancePresentation } from "./correspondence-provenance.logic";

const authenticatedSender = {
  address: "member@firm.example",
  alignedIdentifier: "firm.example",
  spf: "pass",
  dkim: "pass",
  dmarc: "pass",
} as const;

const forgedInline = {
  intake: "forwarded_inline",
  authenticatedSender,
  originalSignature: { status: "unverified" },
  from: { address: "judge@court.example", name: "Asserted judge" },
} as const satisfies CorrespondenceProvenance &
  Pick<ParsedCorrespondence, "from">;

describe("correspondence delivery and original provenance", () => {
  test("an authenticated forged inline original authenticates only the forwarder", () => {
    expect(forgedInline.from.address).not.toBe(authenticatedSender.address);
    const presentation = correspondenceProvenancePresentation(forgedInline);
    expect(presentation).toEqual({
      deliveryLabel: "correspondence.forwardedByAuthenticated",
      deliverySender: "member@firm.example",
      originalSenderLabel: "correspondence.originalSenderUnverified",
      signatureDomain: null,
    });
    const t = createTranslator({ locale: "en", messages: en });
    expect(
      t.markup(presentation.deliveryLabel, {
        sender: presentation.deliverySender,
        address: (chunks) => chunks,
      }),
    ).toBe("Forwarded by member@firm.example · authenticated");
    expect(t(presentation.originalSenderLabel)).toBe(
      "Original sender (as stated, not verified)",
    );
  });

  test("Arabic preserves the outer address in an isolated rich-text slot", () => {
    const t = createTranslator({ locale: "ar", messages: ar });
    const presentation = correspondenceProvenancePresentation(forgedInline);
    expect(
      t.markup(presentation.deliveryLabel, {
        sender: presentation.deliverySender,
        address: (chunks) => `<bdi dir="ltr">${chunks}</bdi>`,
      }),
    ).toBe(
      'تمت إعادة التوجيه بواسطة <bdi dir="ltr">member@firm.example</bdi> · تمت المصادقة',
    );
    expect(t(presentation.originalSenderLabel)).toBe(
      "المرسل الأصلي (كما ورد، غير متحقق منه)",
    );
  });

  test("delivery verdicts cannot verify either kind of extracted original", () => {
    for (const dmarc of CORRESPONDENCE_AUTH_RESULTS) {
      for (const intake of [
        "forwarded_inline",
        "forwarded_attachment",
      ] as const) {
        const presentation = correspondenceProvenancePresentation({
          intake,
          authenticatedSender: { ...authenticatedSender, dmarc },
          originalSignature: { status: "unverified" },
        });
        expect(presentation.originalSenderLabel).toBe(
          "correspondence.originalSenderUnverified",
        );
        expect(presentation.signatureDomain).toBeNull();
        expect(presentation.deliveryLabel).toBe(
          dmarc === "pass"
            ? "correspondence.forwardedByAuthenticated"
            : "correspondence.forwardedBy",
        );
      }
    }
  });

  test("a verified signing domain does not authenticate an unrelated original From", () => {
    const signedUnrelated = {
      intake: "forwarded_attachment",
      authenticatedSender,
      originalSignature: { status: "verified", domain: "sender.example" },
      from: { address: "judge@court.example", name: "Asserted judge" },
    } as const satisfies CorrespondenceProvenance &
      Pick<ParsedCorrespondence, "from">;
    expect(signedUnrelated.from.address).not.toContain("sender.example");
    const presentation = correspondenceProvenancePresentation(signedUnrelated);
    expect(presentation.originalSenderLabel).toBe(
      "correspondence.originalSenderUnverified",
    );
    expect(presentation.signatureDomain).toBe("sender.example");
    expect(presentation.deliverySender).toBe("member@firm.example");
    const t = createTranslator({ locale: "en", messages: en });
    expect(
      t.markup("correspondence.originalSignatureVerified", {
        domain: presentation.signatureDomain ?? "",
        identifier: (chunks) => chunks,
      }),
    ).toBe("Original signature verified (d=sender.example)");
  });

  test("direct deliveries have no asserted original or original signature", () => {
    expect(
      correspondenceProvenancePresentation({
        intake: "direct",
        authenticatedSender,
        originalSignature: null,
      }),
    ).toEqual({
      deliveryLabel: "correspondence.deliveredByAuthenticated",
      deliverySender: "member@firm.example",
      originalSenderLabel: "emailViewer.from",
      signatureDomain: null,
    });
  });
});
