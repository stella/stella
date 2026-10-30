import type { Brand } from "valibot";

import type {
  LISTING_OBSERVATION_REASON,
  ListingObservationReason,
} from "@/api/lib/legal-search/listing-observation-reasons";

/** An adoption candidate cannot produce a canonical decision identity. */
export type RepairAlias = string & Brand<"RepairAlias">;

export type ListingObservationIdentity = {
  source: "sk-us" | "pl-courts";
  fingerprint: string;
} & Brand<"ListingObservationIdentity">;

export type NonCollisionListingObservationReason = Exclude<
  ListingObservationReason,
  typeof LISTING_OBSERVATION_REASON.QUARANTINE_COLLISION
>;

export type UnidentifiedListingObservation = {
  readonly identity: ListingObservationIdentity;
  readonly reason: NonCollisionListingObservationReason;
  readonly payload: unknown;
};

/** A payload revision is evidence, never a replacement canonical identity. */
export type QuarantineCollisionObservation = {
  readonly identity: {
    source: string;
    fingerprint: string;
  } & Brand<"QuarantineCollisionObservationIdentity">;
  readonly reason: typeof LISTING_OBSERVATION_REASON.QUARANTINE_COLLISION;
  readonly payload: {
    readonly quarantineId: string;
    readonly revision: string;
    readonly record: unknown;
  };
};

export type ListingObservation =
  UnidentifiedListingObservation | QuarantineCollisionObservation;
