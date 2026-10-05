import { describe, expect, test } from "bun:test";
import { createTranslator } from "use-intl/core";

import {
  CORRESPONDENCE_AUTH_RESULTS,
  type CorrespondenceProvenance,
  type ParsedCorrespondence,
} from "@stll/api-contract/correspondence";

import type { LocaleMessages } from "@/i18n/i18n-store";
import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";

import { correspondenceProvenancePresentation } from "./correspondence-provenance.logic";

// Every catalog shares the source catalog's shape.
const arabicMessages: LocaleMessages = ar;

const authenticatedSender = {
  address: "member@firm.example",
  alignedIdentifier: "firm.example",
  spf: "pass",
  dkim: "pass",
  dmarc: "pass",
} as const;

const forgedInline = {
  source: "delivery",
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
      origin: {
        type: "delivery",
        label: "correspondence.forwardedByAuthenticated",
        sender: "member@firm.example",
      },
      originalSenderLabel: "correspondence.originalSenderUnverified",
      assertedHeadersLabel: "correspondence.assertedOriginal",
      signatureDomain: null,
    });
    if (presentation.origin.type !== "delivery") {
      throw new Error("expected a delivery origin");
    }
    const t = createTranslator({ locale: "en", messages: en });
    expect(
      t.markup(presentation.origin.label, {
        sender: presentation.origin.sender,
        address: (chunks) => chunks,
      }),
    ).toBe("Forwarded by member@firm.example · authenticated");
    expect(t(presentation.originalSenderLabel)).toBe(
      "Original sender (as stated, not verified)",
    );
  });

  test("Arabic preserves the outer address in an isolated rich-text slot", () => {
    const t = createTranslator({ locale: "ar", messages: arabicMessages });
    const presentation = correspondenceProvenancePresentation(forgedInline);
    if (presentation.origin.type !== "delivery") {
      throw new Error("expected a delivery origin");
    }
    expect(
      t.markup(presentation.origin.label, {
        sender: presentation.origin.sender,
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
          source: "delivery",
          intake,
          authenticatedSender: { ...authenticatedSender, dmarc },
          originalSignature: { status: "unverified" },
        });
        expect(presentation.originalSenderLabel).toBe(
          "correspondence.originalSenderUnverified",
        );
        expect(presentation.signatureDomain).toBeNull();
        expect(presentation.origin).toEqual({
          type: "delivery",
          label:
            dmarc === "pass"
              ? "correspondence.forwardedByAuthenticated"
              : "correspondence.forwardedBy",
          sender: authenticatedSender.address,
        });
      }
    }
  });

  test("a verified signing domain does not authenticate an unrelated original From", () => {
    const signedUnrelated = {
      source: "delivery",
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
    expect(presentation.origin).toMatchObject({
      sender: "member@firm.example",
    });
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
        source: "delivery",
        intake: "direct",
        authenticatedSender,
        originalSignature: null,
      }),
    ).toEqual({
      origin: {
        type: "delivery",
        label: "correspondence.deliveredByAuthenticated",
        sender: "member@firm.example",
      },
      originalSenderLabel: "emailViewer.from",
      assertedHeadersLabel: null,
      signatureDomain: null,
    });
  });
});

describe("uploaded correspondence provenance", () => {
  const sourceEntityId = toSafeId<"entity">("entity-1");

  test("an uploaded file's headers are stated by the file, not verified", () => {
    expect(
      correspondenceProvenancePresentation({
        source: "upload",
        sourceEntityId,
        originalSignature: { status: "unverified" },
      }),
    ).toEqual({
      origin: { type: "upload", sourceEntityId },
      originalSenderLabel: "correspondence.originalSenderUnverified",
      assertedHeadersLabel: "correspondence.statedInFile",
      signatureDomain: null,
    });
    const t = createTranslator({ locale: "en", messages: en });
    expect(t("correspondence.statedInFile")).toBe(
      "Headers (as stated in the file)",
    );
    expect(t("correspondence.uploadedBy", { name: "Jane" })).toBe(
      "Uploaded by Jane",
    );
  });

  test("a verified file signature names only its signing domain", () => {
    const presentation = correspondenceProvenancePresentation({
      source: "upload",
      sourceEntityId,
      originalSignature: { status: "verified", domain: "sender.example" },
    });
    expect(presentation.signatureDomain).toBe("sender.example");
    expect(presentation.originalSenderLabel).toBe(
      "correspondence.originalSenderUnverified",
    );
  });
});
