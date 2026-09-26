import type {
  UsAcceptedCourtRow,
  UsCourtDirectoryRow,
  UsCourtRejectionReason,
} from "./us-court-vocabulary";
import type { US_REJECTED_COURT_IDS } from "./us-courts.generated";
import {
  US_COURT_DIRECTORY as GENERATED_DIRECTORY,
  US_COURT_IDS,
} from "./us-courts.generated";

/**
 * The United States court directory: every court of the source registry, one
 * entry per court id, accepted or rejected. The entries are generated
 * (`us-courts.generated.ts`, by `scripts/generate-us-courts.ts`); this module
 * owns their shape (`us-court-vocabulary.ts`) and derives every id type and
 * lookup from them, so no list of courts is written by hand anywhere else.
 *
 * Acceptance and write enrollment are separate. An accepted court is one the
 * directory can name: it has a canonical name, a system, a region, a tier and
 * a partition. Only the courts in `US_WRITABLE_COURT_IDS` may have decisions
 * written, because the jurisdiction's index still tags every court value it
 * holds, and that set is what the tag's value count is bounded by.
 */
export * from "./us-court-vocabulary";
export {
  US_COURT_DIRECTORY_SOURCES,
  US_COURT_IDS,
  US_REJECTED_COURT_IDS,
} from "./us-courts.generated";

/** The id of an accepted court. */
export type UsCourtId = (typeof US_COURT_IDS)[number];

/** Every id the source registry holds. */
export type UsCourtDirectoryId =
  | UsCourtId
  | (typeof US_REJECTED_COURT_IDS)[number];

export type UsCourt = UsAcceptedCourtRow;

export type UsCourtDirectoryEntry = UsCourtDirectoryRow;

/** Every source court, in id order. */
export const US_COURT_DIRECTORY: readonly UsCourtDirectoryEntry[] =
  GENERATED_DIRECTORY;

const isAccepted = (entry: UsCourtDirectoryEntry): entry is UsCourt =>
  entry.status === "accepted";

/** The accepted courts, in id order. */
export const US_COURTS: readonly UsCourt[] =
  US_COURT_DIRECTORY.filter(isAccepted);

/** The canonical names, one per accepted court. */
export const US_COURT_NAMES: readonly string[] = US_COURTS.map(
  ({ canonicalName }) => canonicalName,
);

const ENTRY_BY_ID: ReadonlyMap<string, UsCourtDirectoryEntry> = new Map(
  US_COURT_DIRECTORY.map((entry) => [entry.id, entry]),
);

const ACCEPTED_IDS: ReadonlySet<string> = new Set<string>(US_COURT_IDS);

/** Whether `courtId` is exactly the id of an accepted court. */
const isUsCourtId = (courtId: string): courtId is UsCourtId =>
  ACCEPTED_IDS.has(courtId);

/** The accepted court stored under a canonical name, exactly as spelled. */
export const US_COURT_BY_CANONICAL_NAME: ReadonlyMap<string, UsCourt> = new Map(
  US_COURTS.map((court) => [court.canonicalName, court]),
);

/**
 * The accepted courts whose decisions may be written today. Every other
 * accepted court is named by the directory but not yet admitted to the index.
 */
export const US_WRITABLE_COURT_IDS: ReadonlySet<UsCourtId> = new Set<UsCourtId>(
  ["scotus"],
);

export type UsCourtResolution =
  | { readonly type: "accepted"; readonly court: UsCourt }
  | {
      readonly type: "rejected";
      readonly courtId: string;
      readonly reason: UsCourtRejectionReason | "unknown";
    };

/**
 * The accepted court a source's court id names, or a rejection.
 *
 * Exact on purpose: no case folding, trimming or alias. A spelling the
 * directory does not carry is a court it cannot name, and a rejected court is
 * outside the jurisdiction. Acceptance is not write enrollment; see
 * `US_WRITABLE_COURT_IDS`.
 */
export const resolveUsCourt = (courtId: string): UsCourtResolution => {
  const entry = ENTRY_BY_ID.get(courtId);
  if (entry === undefined) {
    return { type: "rejected", courtId, reason: "unknown" };
  }
  return isAccepted(entry)
    ? { type: "accepted", court: entry }
    : { type: "rejected", courtId, reason: entry.reason };
};

export type UsWritableCourtResolution =
  | { readonly type: "writable"; readonly court: UsCourt }
  | {
      readonly type: "rejected";
      readonly courtId: string;
      readonly reason: UsCourtRejectionReason | "unknown" | "not-writable";
    };

/**
 * The court a decision may be written under, or a rejection: the write
 * boundary. An accepted court outside `US_WRITABLE_COURT_IDS` is rejected
 * here as `not-writable`, so a writer that resolves through this function
 * cannot put a name into the index that its court-tag bound does not count.
 */
export const resolveWritableUsCourt = (
  courtId: string,
): UsWritableCourtResolution => {
  const resolution = resolveUsCourt(courtId);
  if (resolution.type === "rejected") {
    return resolution;
  }
  return isUsCourtId(courtId) && US_WRITABLE_COURT_IDS.has(courtId)
    ? { type: "writable", court: resolution.court }
    : { type: "rejected", courtId, reason: "not-writable" };
};
