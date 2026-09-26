/**
 * The courts the `USA` jurisdiction holds decisions for: a closed directory,
 * one entry per court, keyed by a stable id.
 *
 * The directory is the enrollment. A USA decision is written only when its
 * source names a court whose id resolves here, and it is stored under that
 * court's canonical name, so the corpus index's court tag carries exactly one
 * spelling per enrolled court and the jurisdiction's court domain is the size
 * of this list. A court is enrolled by adding its entry, never by accepting a
 * spelling at the ingestion boundary.
 */

/** The court systems an enrolled court belongs to. */
export const US_COURT_SYSTEMS = ["federal"] as const;

export type UsCourtSystem = (typeof US_COURT_SYSTEMS)[number];

/** The tiers of the court hierarchy an enrolled court sits at. */
export const US_COURT_TIERS = ["supreme"] as const;

export type UsCourtTier = (typeof US_COURT_TIERS)[number];

type UsCourtEntry = {
  /** Stable id, as the source's court registry spells it. */
  readonly id: string;
  /** The name a decision is stored and shown under. */
  readonly name: string;
  readonly system: UsCourtSystem;
  readonly tier: UsCourtTier;
};

export const US_COURTS = [
  {
    id: "scotus",
    name: "Supreme Court of the United States",
    system: "federal",
    tier: "supreme",
  },
] as const satisfies readonly UsCourtEntry[];

export type UsCourt = (typeof US_COURTS)[number];

export type UsCourtId = UsCourt["id"];

/** The canonical names, one per enrolled court. */
export const US_COURT_NAMES: readonly string[] = US_COURTS.map(
  ({ name }) => name,
);

export type UsCourtResolution =
  | { readonly type: "enrolled"; readonly court: UsCourt }
  | { readonly type: "rejected"; readonly courtId: string };

/**
 * The enrolled court a source's court id names, or a rejection for any other
 * court.
 *
 * Exact on purpose: no case folding, trimming or alias. A spelling the
 * directory does not carry is a court nobody enrolled, and admitting it would
 * put a second tag value into the index for a court the directory cannot
 * name.
 */
export const resolveUsCourt = (courtId: string): UsCourtResolution => {
  const court = US_COURTS.find((candidate) => candidate.id === courtId);
  return court === undefined
    ? { type: "rejected", courtId }
    : { type: "enrolled", court };
};
