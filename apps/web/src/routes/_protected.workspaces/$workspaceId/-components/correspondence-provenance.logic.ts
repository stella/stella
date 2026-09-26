import type { CorrespondenceProvenance } from "@stll/api-contract/correspondence";

import type { TranslationKey } from "@/i18n/types";

const DELIVERY_LABEL_KEYS = {
  direct: {
    pass: "correspondence.deliveredByAuthenticated",
    other: "correspondence.deliveredBy",
  },
  forwarded_inline: {
    pass: "correspondence.forwardedByAuthenticated",
    other: "correspondence.forwardedBy",
  },
  forwarded_attachment: {
    pass: "correspondence.forwardedByAuthenticated",
    other: "correspondence.forwardedBy",
  },
} as const satisfies Record<
  CorrespondenceProvenance["intake"],
  Record<"pass" | "other", TranslationKey>
>;

const ORIGINAL_SENDER_LABEL_KEYS = {
  direct: "emailViewer.from",
  forwarded_inline: "correspondence.originalSenderUnverified",
  forwarded_attachment: "correspondence.originalSenderUnverified",
} as const satisfies Record<CorrespondenceProvenance["intake"], TranslationKey>;

export const correspondenceProvenancePresentation = (
  provenance: CorrespondenceProvenance,
) =>
  ({
    deliveryLabel:
      DELIVERY_LABEL_KEYS[provenance.intake][
        provenance.authenticatedSender.dmarc === "pass" ? "pass" : "other"
      ],
    deliverySender: provenance.authenticatedSender.address,
    originalSenderLabel: ORIGINAL_SENDER_LABEL_KEYS[provenance.intake],
    signatureDomain:
      provenance.originalSignature?.status === "verified"
        ? provenance.originalSignature.domain
        : null,
  }) satisfies {
    deliveryLabel: TranslationKey;
    deliverySender: string;
    originalSenderLabel: TranslationKey;
    signatureDomain: string | null;
  };
