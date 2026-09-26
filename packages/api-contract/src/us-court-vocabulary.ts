/**
 * The closed vocabularies a United States court directory entry is written
 * in, and the court-partition derivation it carries. Kept apart from the
 * directory itself (`us-courts.ts`) so the generator that writes the
 * directory can read them without loading the data it is about to replace.
 */
import { panic } from "better-result";

/** The court system an accepted court belongs to. */
export const US_COURT_SYSTEMS = [
  "federal",
  "state",
  "territory",
  "tribal",
  "military",
] as const;

export type UsCourtSystem = (typeof US_COURT_SYSTEMS)[number];

/** A court's place in its system's hierarchy. */
export const US_COURT_TIERS = [
  "supreme",
  "appellate",
  "trial",
  "special",
] as const;

export type UsCourtTier = (typeof US_COURT_TIERS)[number];

/**
 * What kind of body an entry is: a court, a nonjudicial tribunal, board or
 * commission, or an attorney general's opinions. A description of the
 * source, not a statement about precedential weight.
 */
export const US_COURT_CLASSIFICATIONS = [
  "court",
  "tribunal",
  "attorney-general",
] as const;

export type UsCourtClassification = (typeof US_COURT_CLASSIFICATIONS)[number];

/** The fifty states and the District of Columbia, by postal code. */
export const US_STATE_REGIONS = {
  AK: "Alaska",
  AL: "Alabama",
  AR: "Arkansas",
  AZ: "Arizona",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DC: "District of Columbia",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  IA: "Iowa",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  MA: "Massachusetts",
  MD: "Maryland",
  ME: "Maine",
  MI: "Michigan",
  MN: "Minnesota",
  MO: "Missouri",
  MS: "Mississippi",
  MT: "Montana",
  NC: "North Carolina",
  ND: "North Dakota",
  NE: "Nebraska",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NV: "Nevada",
  NY: "New York",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VA: "Virginia",
  VT: "Vermont",
  WA: "Washington",
  WI: "Wisconsin",
  WV: "West Virginia",
  WY: "Wyoming",
} as const;

type UsStateRegion = keyof typeof US_STATE_REGIONS;

/** The inhabited territories, by postal code. */
export const US_TERRITORY_REGIONS = {
  AS: "American Samoa",
  GU: "Guam",
  MP: "Northern Mariana Islands",
  PR: "Puerto Rico",
  VI: "Virgin Islands",
} as const;

type UsTerritoryRegion = keyof typeof US_TERRITORY_REGIONS;

/**
 * Former territories a directory court sat in, each named explicitly rather
 * than folded into the state that later covered the same ground.
 */
export const US_HISTORICAL_TERRITORY_REGIONS = {
  "canal-zone": "Panama Canal Zone",
  "dakota-territory": "Dakota Territory",
  "washington-territory": "Washington Territory",
} as const;

type UsHistoricalTerritoryRegion = keyof typeof US_HISTORICAL_TERRITORY_REGIONS;

/**
 * Regions that are a court's reach rather than a place: the whole country,
 * several states, or none of them (a court sitting abroad).
 */
export const US_SCOPE_REGIONS = [
  "national",
  "multistate",
  "not-applicable",
] as const;

type UsScopeRegion = (typeof US_SCOPE_REGIONS)[number];

export type UsCourtRegion =
  | UsStateRegion
  | UsTerritoryRegion
  | UsHistoricalTerritoryRegion
  | UsScopeRegion;

/**
 * Court partitions: every accepted court carries one, derived from its id
 * alone as `p` plus the zero-padded value of
 * `firstByte(SHA-256(UTF-8(prefix + id))) % count`. Nothing about the court
 * but its id feeds the hash, so adding a court never moves another one.
 * Changing the prefix, the count or the formatting moves nearly every court.
 */
export const US_COURT_PARTITION_KEY_PREFIX = "USA:";

export const US_COURT_PARTITION_COUNT = 16;

export const US_COURT_PARTITIONS = [
  "p00",
  "p01",
  "p02",
  "p03",
  "p04",
  "p05",
  "p06",
  "p07",
  "p08",
  "p09",
  "p10",
  "p11",
  "p12",
  "p13",
  "p14",
  "p15",
] as const;

export type UsCourtPartition = (typeof US_COURT_PARTITIONS)[number];

/** The partition label of a bucket index in `[0, US_COURT_PARTITION_COUNT)`. */
export const usCourtPartitionLabel = (bucket: number): UsCourtPartition =>
  US_COURT_PARTITIONS[bucket] ?? panic(`no court partition ${String(bucket)}`);

/** Why a source court is not part of the jurisdiction. */
export type UsCourtRejectionReason = "testing" | "outside-jurisdiction";

/** A source court the jurisdiction accepts. */
export type UsAcceptedCourtRow = {
  readonly status: "accepted";
  /** The source registry's id, exactly as it spells it. */
  readonly id: string;
  /** The source's name, untouched. */
  readonly sourceName: string;
  /**
   * The name a decision is stored, tagged and ranked under: the source name
   * NFC-normalized and trimmed, or a reviewed name where two courts share a
   * source name. Unique across the directory regardless of case.
   */
  readonly canonicalName: string;
  /** The source's jurisdiction code, even where an override replaced it. */
  readonly rawJurisdiction: string;
  readonly classification: UsCourtClassification;
  readonly system: UsCourtSystem;
  readonly region: UsCourtRegion;
  readonly tier: UsCourtTier;
  /**
   * The source's dates for the court itself. They describe the directory, not
   * which decision dates a court may carry: the source dates `scotus` from
   * 1789 while it files decisions under it from 1759.
   */
  readonly startDate: string | null;
  readonly endDate: string | null;
  /** The source's own flag; not an ingestion gate. */
  readonly sourceInUse: boolean;
  readonly parentId: string | null;
  readonly courtPartition: UsCourtPartition;
};

/** A source court outside the jurisdiction, kept so every id is accounted for. */
export type UsRejectedCourtRow = {
  readonly status: "rejected";
  readonly id: string;
  readonly sourceName: string;
  readonly rawJurisdiction: string;
  readonly reason: UsCourtRejectionReason;
};

export type UsCourtDirectoryRow = UsAcceptedCourtRow | UsRejectedCourtRow;
