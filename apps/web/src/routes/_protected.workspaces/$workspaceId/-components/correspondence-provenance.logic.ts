import { panic } from "better-result";

import type {
  CorrespondenceDeliveryProvenance,
  CorrespondenceProvenance,
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
  CorrespondenceDeliveryProvenance["intake"],
  Record<"pass" | "other", TranslationKey>
>;

const ORIGINAL_SENDER_LABEL_KEYS = {
  direct: "emailViewer.from",
  forwarded_inline: "correspondence.originalSenderUnverified",
  forwarded_attachment: "correspondence.originalSenderUnverified",
} as const satisfies Record<
  CorrespondenceDeliveryProvenance["intake"],
  TranslationKey
>;

const ASSERTED_HEADERS_LABEL_KEYS = {
  direct: null,
  forwarded_inline: "correspondence.assertedOriginal",
  forwarded_attachment: "correspondence.assertedOriginal",
} as const satisfies Record<
  CorrespondenceDeliveryProvenance["intake"],
  TranslationKey | null
>;

/**
 * `origin` names who brought the message in; `assertedHeadersLabel` heads
 * headers the record cannot verify, when there are any.
 */
export const correspondenceProvenancePresentation = (
  provenance: CorrespondenceProvenance,
) => {
  const signatureDomain =
    provenance.originalSignature?.status === "verified"
      ? provenance.originalSignature.domain
      : null;
  switch (provenance.source) {
    case "delivery":
      return {
        origin: {
          type: "delivery",
          label:
            DELIVERY_LABEL_KEYS[provenance.intake][
              provenance.authenticatedSender.dmarc === "pass" ? "pass" : "other"
            ],
          sender: provenance.authenticatedSender.address,
        },
        originalSenderLabel: ORIGINAL_SENDER_LABEL_KEYS[provenance.intake],
        assertedHeadersLabel: ASSERTED_HEADERS_LABEL_KEYS[provenance.intake],
        signatureDomain,
      } as const;
    case "upload":
      // An uploaded file's headers are its own assertions; only a DKIM
      // signature over the file can be verified.
      return {
        origin: { type: "upload", sourceEntityId: provenance.sourceEntityId },
        originalSenderLabel: "correspondence.originalSenderUnverified",
        assertedHeadersLabel: "correspondence.statedInFile",
        signatureDomain,
      } as const;
    default:
      provenance satisfies never;
      return panic("Unhandled correspondence source");
  }
};
