import { panic } from "better-result";

import type {
  CorrespondenceChannelContent,
  CorrespondenceDirection,
  CorrespondenceProvenance,
} from "@stll/api-contract/correspondence";

import type { correspondence } from "@/api/db/schema";
import {
  deriveDataBoxDirectionBasis,
  DIRECTION_BY_BASIS,
} from "@/api/lib/email/correspondence/data-box/direction";

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

type StoredCorrespondenceChannel = Pick<
  typeof correspondence.$inferSelect,
  "channel" | "dataBox" | "direction"
>;

type CorrespondenceChannelProjection = CorrespondenceChannelContent & {
  direction: CorrespondenceDirection;
};

/** Stored data-box envelopes contain only the file's assertions. */
export const readCorrespondenceChannel = (
  { channel, dataBox, direction }: StoredCorrespondenceChannel,
  organizationBoxIds: readonly string[],
): CorrespondenceChannelProjection => {
  switch (channel) {
    case "email":
      if (dataBox !== null || direction === null) {
        return panic("Email correspondence has invalid channel metadata");
      }
      return { channel, dataBox, direction };
    case "data_box": {
      if (
        dataBox === null ||
        direction !== null ||
        "directionBasis" in dataBox
      ) {
        return panic("Data-box correspondence has invalid stored metadata");
      }
      const directionBasis = deriveDataBoxDirectionBasis({
        senderBoxId: dataBox.sender.boxId,
        recipientBoxId: dataBox.recipient.boxId,
        organizationBoxIds,
      });
      return {
        channel,
        dataBox: { ...dataBox, directionBasis },
        direction: DIRECTION_BY_BASIS[directionBasis],
      };
    }
    default:
      channel satisfies never;
      return panic("Unhandled correspondence channel");
  }
};
