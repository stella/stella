import { panic } from "better-result";

import type { CorrespondenceProvenance } from "@stll/api-contract/correspondence";

import type { correspondence } from "@/api/db/schema";

type StoredCorrespondenceProvenance = Pick<
  typeof correspondence.$inferSelect,
  | "source"
  | "sourceEntityId"
  | "intake"
  | "authenticatedSenderAddress"
  | "originalSignature"
  | "spf"
  | "dkim"
  | "dmarc"
  | "alignedIdentifier"
>;

const readDeliveryProvenance = ({
  intake,
  authenticatedSenderAddress,
  originalSignature,
  spf,
  dkim,
  dmarc,
  alignedIdentifier,
}: StoredCorrespondenceProvenance): CorrespondenceProvenance => {
  if (
    authenticatedSenderAddress === null ||
    spf === null ||
    dkim === null ||
    dmarc === null
  ) {
    return panic("Delivered correspondence has no delivery authentication");
  }
  const authenticatedSender = {
    address: authenticatedSenderAddress,
    spf,
    dkim,
    dmarc,
    alignedIdentifier,
  };
  switch (intake) {
    case "direct":
      if (originalSignature !== null) {
        return panic("Direct correspondence has an original signature");
      }
      return {
        source: "delivery",
        intake,
        authenticatedSender,
        originalSignature: null,
      };
    case "forwarded_inline":
      if (originalSignature?.status !== "unverified") {
        return panic("Inline correspondence has invalid signature provenance");
      }
      return {
        source: "delivery",
        intake,
        authenticatedSender,
        originalSignature,
      };
    case "forwarded_attachment":
      if (originalSignature === null) {
        return panic("Attached correspondence has no signature provenance");
      }
      return {
        source: "delivery",
        intake,
        authenticatedSender,
        originalSignature,
      };
    case null:
      return panic("Delivered correspondence has no intake");
    default:
      intake satisfies never;
      return panic("Unhandled correspondence intake");
  }
};

export const readCorrespondenceProvenance = (
  stored: StoredCorrespondenceProvenance,
): CorrespondenceProvenance => {
  switch (stored.source) {
    case "delivery":
      return readDeliveryProvenance(stored);
    case "upload":
      if (stored.sourceEntityId === null || stored.originalSignature === null) {
        return panic("Uploaded correspondence has no source file provenance");
      }
      return {
        source: "upload",
        sourceEntityId: stored.sourceEntityId,
        originalSignature: stored.originalSignature,
      };
    default:
      stored.source satisfies never;
      return panic("Unhandled correspondence source");
  }
};
