/**
 * A data-box message's direction, derived from the organization's own boxes:
 * sent from one of them is outgoing, sent to one is incoming. A message
 * whose boxes are neither (or both) the organization's stays incoming with an
 * unknown basis. The same rule runs at filing and when the boxes change.
 */
import { and, eq, sql } from "drizzle-orm";

import type { CorrespondenceDirection } from "@stll/api-contract/correspondence";
import type { DataBoxDirectionBasis } from "@stll/api-contract/data-box";

import type { Transaction } from "@/api/db/root";
import { correspondence } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

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

type RecomputeDataBoxDirectionsOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  organizationBoxIds: readonly string[];
};

/**
 * Re-derives the direction of the organization's filed data-box messages from
 * their stored envelopes, in the matters the transaction may reach. Only rows
 * whose basis changes are written, so a repeat call changes nothing. Returns
 * the number of records whose direction basis changed.
 */
export const recomputeDataBoxDirections = async ({
  tx,
  organizationId,
  organizationBoxIds,
}: RecomputeDataBoxDirectionsOptions): Promise<number> => {
  // audit: skip - the caller records the organization settings change and the recomputed count in the same transaction.
  const boxIds = sql`${JSON.stringify(organizationBoxIds)}::text::jsonb`;
  const fromOrganization = sql`jsonb_exists(${boxIds}, ${correspondence.dataBox} -> 'sender' ->> 'boxId')`;
  const toOrganization = sql`jsonb_exists(${boxIds}, ${correspondence.dataBox} -> 'recipient' ->> 'boxId')`;
  const basis = sql<DataBoxDirectionBasis>`(CASE
    WHEN ${fromOrganization} AND NOT ${toOrganization} THEN 'organization_sender'
    WHEN ${toOrganization} AND NOT ${fromOrganization} THEN 'organization_recipient'
    ELSE 'unknown'
  END)`;
  const updated = await tx
    .update(correspondence)
    .set({
      direction: sql`(CASE WHEN ${basis} = 'organization_sender' THEN 'out' ELSE 'in' END)`,
      dataBox: sql`jsonb_set(${correspondence.dataBox}, '{directionBasis}', to_jsonb(${basis}))`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(correspondence.organizationId, organizationId),
        eq(correspondence.channel, "data_box"),
        sql`${correspondence.dataBox} ->> 'directionBasis' IS DISTINCT FROM ${basis}`,
      ),
    )
    .returning({ id: correspondence.id });
  return updated.length;
};
