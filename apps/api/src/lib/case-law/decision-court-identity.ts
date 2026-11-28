// parser-output-unchanged: listing court identity uses the existing stored-field converter; stored court resolution is unchanged.
/**
 * How a decision's court is identified at the ingestion boundary.
 *
 * Names collide and change, an id does not. A jurisdiction backed by a court
 * directory (`COURT_DIRECTORY_JURISDICTIONS`) identifies a court by the
 * directory's exact id, which its source states, and the index derives the
 * court's partition from the id. A jurisdiction whose publishers print only a
 * court's name (`PRINTED_COURT_JURISDICTIONS`) has the name read onto its own
 * directory's id here, at the one place every adapter's decisions pass, so no
 * spelling a publisher prints can store a second court. Either way the
 * decision stores both, and the name is the directory's canonical name for
 * the id. Every other jurisdiction identifies a court by the printed name.
 */
import { panic, Result, TaggedError } from "better-result";

import {
  isPrintedCourtJurisdiction,
  readPrintedCourt,
} from "@stll/api-contract/court-identity";
import {
  resolveUsCourt,
  type UsCourtResolution,
} from "@stll/api-contract/us-courts";
import { toPlainText } from "@stll/case-law-ingestion-core/plain-text";
import { declareFingerprintFields } from "@stll/errors";

import {
  type CourtDirectoryJurisdiction,
  isCourtDirectoryJurisdiction,
} from "@/api/lib/case-law/decision-court-id-sql";

/**
 * The directory that admits a jurisdiction's court ids for writing: every
 * court it accepts, and no other.
 */
const COURT_DIRECTORY_RESOLVER = {
  USA: resolveUsCourt,
} as const satisfies Record<
  CourtDirectoryJurisdiction,
  (courtId: string) => UsCourtResolution
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
    const resolution = resolveUsCourt(courtId);
    return resolution.type === "accepted"
      ? { courtId, name: resolution.court.canonicalName }
      : panic(`Trusted legacy court is not accepted: ${courtId}`);
  });

type DecisionCourtIdentityRejection =
  | "missing"
  | "unexpected"
  | "name-mismatch"
  /** A printed name no directory court answers to. */
  | "unknown-name"
  /** A printed name several directory courts answer to. */
  | "ambiguous-name"
  | Extract<UsCourtResolution, { type: "rejected" }>["reason"];

/** A decision whose court identity its jurisdiction does not admit. */
export class DecisionCourtIdentityError extends TaggedError(
  "DecisionCourtIdentityError",
)<{
  message: string;
  country: string;
  courtId: string | null;
  /** The court name the rejected decision carried, as written. */
  court: string;
  reason: DecisionCourtIdentityRejection;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

/** An attaching record cannot create a host until its court is recognized. */
export class DecisionCourtUnrecognizedError extends TaggedError(
  "court_unrecognized",
)<{
  message: string;
  cause: DecisionCourtIdentityError;
}> {}

type DecisionCourtIdentityInput = {
  country: string;
  court: string;
  courtId?: string | undefined;
};

/** The court a decision is stored under: its name and, where it has one, id. */
export type DecisionCourt = { court: string; courtId: string | null };

/**
 * The court a decision is stored under.
 *
 * A directory jurisdiction's adapter states the id, which must be an
 * accepted directory court whose canonical name is exactly the decision's
 * court: no case folding and no lookup by name, since its source has an id.
 *
 * A printed-name jurisdiction's adapter states the name its publisher
 * prints, and never an id: the name is read onto the directory court it
 * answers to, and the decision is stored under that court's id and official
 * name. The adapter keeps the printed name in the decision's metadata. A name
 * no directory court answers to, or several do, is rejected: a spelling the
 * directory cannot place is not a new court.
 */
export const resolveDecisionCourt = ({
  country,
  court,
  courtId,
}: DecisionCourtIdentityInput): Result<
  DecisionCourt,
  DecisionCourtIdentityError
> => {
  const reject = (reason: DecisionCourtIdentityRejection) =>
    Result.err(
      new DecisionCourtIdentityError({
        message: `Decision court identity rejected for ${country}: ${reason}`,
        country,
        courtId: courtId ?? null,
        court,
        reason,
      }),
    );
  if (isPrintedCourtJurisdiction(country)) {
    if (courtId !== undefined) {
      return reject("unexpected");
    }
    const reading = readPrintedCourt(country, court);
    switch (reading.type) {
      case "court":
        return Result.ok({
          court: reading.court.name,
          courtId: reading.court.id,
        });
      case "unknown":
        return reject("unknown-name");
      case "ambiguous":
        return reject("ambiguous-name");
      default:
        reading satisfies never;
        return panic(`Unhandled printed court: ${JSON.stringify(reading)}`);
    }
  }
  if (!isCourtDirectoryJurisdiction(country)) {
    return courtId === undefined
      ? Result.ok({ court, courtId: null })
      : reject("unexpected");
  }
  if (courtId === undefined) {
    return reject("missing");
  }
  const resolution = COURT_DIRECTORY_RESOLVER[country](courtId);
  if (resolution.type === "rejected") {
    return reject(resolution.reason);
  }
  return resolution.court.canonicalName === court
    ? Result.ok({ court, courtId })
    : reject("name-mismatch");
};

/** The court id a decision is stored with (`resolveDecisionCourt`). */
export const resolveDecisionCourtId = (
  input: DecisionCourtIdentityInput,
): Result<string | null, DecisionCourtIdentityError> =>
  resolveDecisionCourt(input).map(({ courtId }) => courtId);

/** Exact court partition shared by listing and stored-decision identity. */
export type ListingCourtIdentity =
  | { type: "court-id"; courtId: string }
  | { type: "court-name"; name: string }
  | { type: "unknown-court" };

type ListingCourtIdentityOptions = {
  court: string;
  courtId?: string | null | undefined;
  /**
   * The decision's jurisdiction. A printed-name jurisdiction's court is
   * keyed by its canonical name, which its id stands for one to one, so the
   * keys of rows stored before it had an id stay the keys it is found by.
   */
  country?: string | undefined;
};

/** Uses the same plain-text conversion as stored decision assembly. */
export const listingCourtIdentity = ({
  court,
  courtId,
  country,
}: ListingCourtIdentityOptions): ListingCourtIdentity => {
  if (
    courtId !== undefined &&
    courtId !== null &&
    (country === undefined || !isPrintedCourtJurisdiction(country))
  ) {
    return { type: "court-id", courtId };
  }
  const canonicalCourt = toPlainText(court).unwrapOr("");
  return canonicalCourt.length === 0
    ? { type: "unknown-court" }
    : { type: "court-name", name: canonicalCourt };
};
