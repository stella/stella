/**
 * A data-box message's direction, derived from the organization's own boxes:
 * sent from one of them is outgoing, sent to one is incoming. A message
 * whose boxes are neither (or both) the organization's stays incoming with an
 * unknown basis. The rule runs on each read against the current box inventory.
 */
import type { CorrespondenceDirection } from "@stll/api-contract/correspondence";
import type { DataBoxDirectionBasis } from "@stll/api-contract/data-box";

export const DIRECTION_BY_BASIS = {
  organization_sender: "out",
  organization_recipient: "in",
  unknown: "in",
} as const satisfies Record<DataBoxDirectionBasis, CorrespondenceDirection>;

type DeriveDataBoxDirectionOptions = {
  senderBoxId: string;
  recipientBoxId: string;
  organizationBoxIds: readonly string[];
};

export const deriveDataBoxDirectionBasis = ({
  senderBoxId,
  recipientBoxId,
  organizationBoxIds,
}: DeriveDataBoxDirectionOptions): DataBoxDirectionBasis => {
  const fromOrganization = organizationBoxIds.includes(senderBoxId);
  const toOrganization = organizationBoxIds.includes(recipientBoxId);
  if (fromOrganization === toOrganization) {
    return "unknown";
  }
  return fromOrganization ? "organization_sender" : "organization_recipient";
};
