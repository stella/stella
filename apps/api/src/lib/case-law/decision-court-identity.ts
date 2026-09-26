/**
 * How a decision's court is identified at the ingestion boundary.
 *
 * Most jurisdictions identify a court by the name the publisher prints. A
 * jurisdiction backed by a court directory (`COURT_DIRECTORY_JURISDICTIONS`)
 * identifies it by the directory's exact id instead: names collide and
 * change, an id does not, and the index derives the court's partition from
 * the id. Its decisions store both, and the name must be the directory's
 * canonical name for the id.
 */
import { panic, Result, TaggedError } from "better-result";

import {
  resolveWritableUsCourt,
  type UsWritableCourtResolution,
} from "@stll/api-contract/us-courts";

import {
  COURT_DIRECTORY_JURISDICTIONS,
  type CourtDirectoryJurisdiction,
} from "@/api/lib/case-law/decision-court-id-sql";

/** The directory that admits a jurisdiction's court ids for writing. */
const COURT_DIRECTORY_RESOLVER = {
  USA: resolveWritableUsCourt,
} as const satisfies Record<
  CourtDirectoryJurisdiction,
  (courtId: string) => UsWritableCourtResolution
>;

/**
 * The courts a USA row stored before court ids existed may be given an id
 * for: the only court the earlier write contract admitted, by its exact
 * canonical name. A row naming anything else is never assigned one.
 */
const LEGACY_TRUSTED_USA_COURT_IDS = ["scotus"] as const;

/** Each trusted legacy court with the exact name its rows were stored under. */
export const legacyTrustedUsaCourts = (): readonly {
  courtId: string;
  name: string;
}[] =>
  LEGACY_TRUSTED_USA_COURT_IDS.map((courtId) => {
    const resolution = resolveWritableUsCourt(courtId);
    return resolution.type === "writable"
      ? { courtId, name: resolution.court.canonicalName }
      : panic(`Trusted legacy court is not writable: ${courtId}`);
  });

const isCourtDirectoryJurisdiction = (
  country: string,
): country is CourtDirectoryJurisdiction =>
  COURT_DIRECTORY_JURISDICTIONS.some((code) => code === country);

type DecisionCourtIdentityRejection =
  | "missing"
  | "unexpected"
  | "name-mismatch"
  | Extract<UsWritableCourtResolution, { type: "rejected" }>["reason"];

/** A decision whose court identity its jurisdiction does not admit. */
export class DecisionCourtIdentityError extends TaggedError(
  "DecisionCourtIdentityError",
)<{
  message: string;
  country: string;
  courtId: string | null;
  reason: DecisionCourtIdentityRejection;
}> {}

type DecisionCourtIdentityInput = {
  country: string;
  court: string;
  courtId?: string | undefined;
};

/**
 * The court id a decision is stored with: null where its jurisdiction
 * identifies courts by name, or a writable directory court whose canonical
 * name is exactly the decision's court. Exact on purpose: no case folding and
 * no lookup by name, since a name is not an identity.
 */
export const resolveDecisionCourtId = ({
  country,
  court,
  courtId,
}: DecisionCourtIdentityInput): Result<
  string | null,
  DecisionCourtIdentityError
> => {
  const reject = (reason: DecisionCourtIdentityRejection) =>
    Result.err(
      new DecisionCourtIdentityError({
        message: `Decision court identity rejected for ${country}: ${reason}`,
        country,
        courtId: courtId ?? null,
        reason,
      }),
    );
  if (!isCourtDirectoryJurisdiction(country)) {
    return courtId === undefined ? Result.ok(null) : reject("unexpected");
  }
  if (courtId === undefined) {
    return reject("missing");
  }
  const resolution = COURT_DIRECTORY_RESOLVER[country](courtId);
  if (resolution.type === "rejected") {
    return reject(resolution.reason);
  }
  return resolution.court.canonicalName === court
    ? Result.ok(courtId)
    : reject("name-mismatch");
};
