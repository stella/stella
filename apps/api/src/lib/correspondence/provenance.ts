import { panic } from "better-result";

import type { CorrespondenceProvenance } from "@stll/api-contract/correspondence";

import type { correspondence } from "@/api/db/schema";

type StoredCorrespondenceProvenance = Pick<
  typeof correspondence.$inferSelect,
  | "intake"
  | "authenticatedSenderAddress"
  | "originalSignature"
  | "spf"
  | "dkim"
  | "dmarc"
  | "alignedIdentifier"
>;

export const readCorrespondenceProvenance = ({
  intake,
  authenticatedSenderAddress,
  originalSignature,
  spf,
  dkim,
  dmarc,
  alignedIdentifier,
}: StoredCorrespondenceProvenance): CorrespondenceProvenance => {
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
      return { intake, authenticatedSender, originalSignature: null };
    case "forwarded_inline":
      if (originalSignature?.status !== "unverified") {
        return panic("Inline correspondence has invalid signature provenance");
      }
      return { intake, authenticatedSender, originalSignature };
    case "forwarded_attachment":
      if (originalSignature === null) {
        return panic("Attached correspondence has no signature provenance");
      }
      return { intake, authenticatedSender, originalSignature };
    default:
      intake satisfies never;
      return panic("Unhandled correspondence intake");
  }
};
