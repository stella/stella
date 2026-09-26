import type {
  CorrespondenceProvenance,
  CorrespondenceOriginalSignature,
} from "@stll/api-contract/correspondence";

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
  verified: "correspondence.originalSender",
  unverified: "correspondence.originalSenderUnverified",
} as const satisfies Record<
  "direct" | CorrespondenceOriginalSignature["status"],
  TranslationKey
>;

export const correspondenceProvenancePresentation = (
  provenance: CorrespondenceProvenance,
) =>
  ({
    deliveryLabel:
      DELIVERY_LABEL_KEYS[provenance.intake][
        provenance.authenticatedSender.dmarc === "pass" ? "pass" : "other"
      ],
    deliverySender: provenance.authenticatedSender.address,
    originalSenderLabel:
      ORIGINAL_SENDER_LABEL_KEYS[
        provenance.originalSignature?.status ?? "direct"
      ],
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
