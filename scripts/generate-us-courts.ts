#!/usr/bin/env bun
/**
 * Regenerates `packages/api-contract/src/us-courts.generated.ts`, the United
 * States court directory, from the pinned inputs under
 * `packages/api-contract/data/us-courts/`:
 *
 * - `courtlistener-courts.tsv`: the court table of the CourtListener bulk
 *   export, projected to the columns the directory reads. Public Domain Mark.
 * - `courts-db-locations.tsv`: the `location` of every court in courts-db at
 *   one pinned commit. BSD-2-Clause; notice in `courts-db.LICENSE`.
 * - `overrides.json`: reviewed per-court decisions, each with its reason or
 *   its evidence. Every one is checked here against the inputs.
 *
 * Every source row becomes exactly one entry, accepted or rejected; none is
 * dropped. A court's system and tier come from its source jurisdiction code
 * through `CODE_DISPOSITIONS`, then per-court overrides. Its region comes
 * from a reviewed override, then an exact courts-db match, then its source
 * parent in the same system. A court left without a region its system allows,
 * an override whose evidence does not hold, an override that changes nothing,
 * a duplicate canonical name and an unknown jurisdiction code each fail
 * generation. There is no name heuristic and no fallback bucket.
 *
 * Modes:
 *   (default)          regenerate and compare with the committed files; exit 1 on drift
 *   --write            overwrite the committed files
 *   --refresh-inputs <courts-YYYY-MM-DD.csv.bz2>
 *                      re-derive both projections from the pinned upstream
 *                      files (the local export and courts-db over the
 *                      network), verify their digests, and write them
 *
 * A manual tool outside the build; `us-courts-generator.test.ts` holds the
 * committed directory to what the committed inputs generate.
 */

import { panic } from "better-result";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  US_COURT_CLASSIFICATIONS,
  US_COURT_PARTITION_COUNT,
  US_COURT_PARTITION_KEY_PREFIX,
  US_COURT_SYSTEMS,
  US_COURT_TIERS,
  US_HISTORICAL_TERRITORY_REGIONS,
  US_SCOPE_REGIONS,
  US_STATE_REGIONS,
  US_TERRITORY_REGIONS,
  usCourtPartitionLabel,
} from "../packages/api-contract/src/us-court-vocabulary";
import type {
  UsAcceptedCourtRow,
  UsCourtClassification,
  UsCourtDirectoryRow,
  UsCourtPartition,
  UsCourtRegion,
  UsCourtRejectionReason,
  UsCourtSystem,
  UsCourtTier,
  UsRejectedCourtRow,
} from "../packages/api-contract/src/us-court-vocabulary";

/** Bumped when the rendering or the resolution rules change. */
const GENERATOR_VERSION = 2;

const REPO_ROOT = path.join(import.meta.dir, "..");
const DATA_DIR = path.join(REPO_ROOT, "packages/api-contract/data/us-courts");
export const DIRECTORY_PATH = path.join(
  REPO_ROOT,
  "packages/api-contract/src/us-courts.generated.ts",
);
const COURTLISTENER_FILE = "courtlistener-courts.tsv";
const COURTS_DB_FILE = "courts-db-locations.tsv";
const OVERRIDES_FILE = "overrides.json";
const PROVENANCE_FILE = "provenance.json";
const COURTS_DB_NOTICE_FILE = "courts-db.LICENSE";
const FORMATTER_CONFIG = path.join(REPO_ROOT, ".oxfmtrc.json");

/** The CourtListener export the projection is taken from. */
const COURTLISTENER_EXPORT = {
  object: "bulk-data/courts-2026-06-30.csv.bz2",
  url: "https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/bulk-data/courts-2026-06-30.csv.bz2",
  snapshot: "2026-06-30",
  sha256: "d5a7a5aa902cb4cdb1b99eb3e6a160867a77ce4b2401682291081499537ea8be",
  decompressedSha256:
    "110a1578a24788b73a9d351992051b40cb8fcf1e95dee72dd5a42054f413e757",
  license: "Public Domain Mark 1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/",
} as const;

/** The courts-db revision the location projection is taken from. */
const COURTS_DB = {
  repository: "https://github.com/freelawproject/courts-db",
  commit: "97b60845aa2558b71f3b8dcc7bd67f30188d0a03",
  file: "courts_db/data/courts.json",
  sha256: "61a26db4e4c17d9b97613739da20f3cb27cf64a447df0449d9c12d49974a84bf",
  license: "BSD-2-Clause",
} as const;

const COURTS_DB_RAW = `https://raw.githubusercontent.com/freelawproject/courts-db/${COURTS_DB.commit}`;

/** The export columns the projection keeps, in projection order. */
const COURTLISTENER_COLUMNS = [
  "id",
  "jurisdiction",
  "full_name",
  "short_name",
  "in_use",
  "start_date",
  "end_date",
  "parent_court_id",
] as const;

type CourtListenerColumn = (typeof COURTLISTENER_COLUMNS)[number];

export type SourceCourt = Readonly<Record<CourtListenerColumn, string>>;

/** Code-unit order: independent of the machine's locale. */
const compareText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

// -- Dispositions ------------------------------------------------------------

type AcceptedDisposition = {
  readonly status: "accepted";
  /** Null where every court under the code needs a reviewed system. */
  readonly system: UsCourtSystem | null;
  readonly tier: UsCourtTier;
  readonly classification: UsCourtClassification;
};

type CodeDisposition =
  | AcceptedDisposition
  | { readonly status: "rejected"; readonly reason: UsCourtRejectionReason };

const accepted = (
  system: UsCourtSystem | null,
  tier: UsCourtTier,
  classification: UsCourtClassification = "court",
): AcceptedDisposition => ({
  status: "accepted",
  system,
  tier,
  classification,
});

/**
 * What each source jurisdiction code means here. A code absent from this
 * table fails generation unless every row carrying it has a reviewed code
 * override, so a code the source adds is a decision, not a default.
 */
export const CODE_DISPOSITIONS: Readonly<Record<string, CodeDisposition>> = {
  F: accepted("federal", "appellate"),
  FD: accepted("federal", "trial"),
  FB: accepted("federal", "trial"),
  FBP: accepted("federal", "appellate"),
  FS: accepted("federal", "special"),
  MA: accepted("military", "appellate"),
  S: accepted("state", "supreme"),
  SA: accepted("state", "appellate"),
  ST: accepted("state", "trial"),
  SS: accepted("state", "special"),
  SAG: accepted("state", "special", "attorney-general"),
  C: accepted(null, "special", "tribunal"),
  TS: accepted("territory", "supreme"),
  TA: accepted("territory", "appellate"),
  TT: accepted("territory", "trial"),
  TRS: accepted("tribal", "supreme"),
  TRA: accepted("tribal", "appellate"),
  TRT: accepted("tribal", "trial"),
  TRX: accepted("tribal", "special"),
  I: { status: "rejected", reason: "outside-jurisdiction" },
  T: { status: "rejected", reason: "testing" },
};

// -- Regions -----------------------------------------------------------------

const STATE_REGIONS = new Set<string>(Object.keys(US_STATE_REGIONS));
const TERRITORY_REGIONS = new Set<string>(Object.keys(US_TERRITORY_REGIONS));
const HISTORICAL_REGIONS = new Set<string>(
  Object.keys(US_HISTORICAL_TERRITORY_REGIONS),
);
const SCOPE_REGIONS = new Set<string>(US_SCOPE_REGIONS);

const isUsCourtRegion = (region: string): region is UsCourtRegion =>
  STATE_REGIONS.has(region) ||
  TERRITORY_REGIONS.has(region) ||
  HISTORICAL_REGIONS.has(region) ||
  SCOPE_REGIONS.has(region);

/** A place a court sits in, as opposed to a reach. */
const isPlace = (region: string): boolean => !SCOPE_REGIONS.has(region);

/**
 * The names a region goes by in a source court name, for checking an
 * override's evidence. A historical territory is matched only by a name that
 * says territory or zone, never by the bare state or country name.
 */
const REGION_NAMES: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  ...Object.entries(US_STATE_REGIONS).map(
    ([code, name]) => [code, [name]] as const,
  ),
  ...Object.entries(US_TERRITORY_REGIONS).map(
    ([code, name]) => [code, [name]] as const,
  ),
  ["canal-zone", ["Canal Zone"]],
  ["dakota-territory", ["Dakota Territory", "Territory of Dakota"]],
  ["washington-territory", ["Washington Territory"]],
]);

/**
 * courts-db `location` values and the region each names. Seats of national
 * courts are recorded there as a city or state, so a federal court's
 * location is its seat, not its reach; overrides correct those.
 */
const COURTS_DB_LOCATIONS: ReadonlyMap<string, string> = new Map([
  ...Object.entries(US_STATE_REGIONS).map(
    ([code, name]) => [name, code] as const,
  ),
  ...Object.entries(US_TERRITORY_REGIONS).map(
    ([code, name]) => [name, code] as const,
  ),
  ["Washington D.C.", "DC"],
  ["D.C.", "DC"],
  ["DC", "DC"],
  ["United States", "national"],
]);

type RegionSource = "override" | "derived";

/**
 * Whether a court of `system` may sit in `region`. A state or tribal court
 * reaching several states, and any court of a system without a fixed place,
 * is only ever a reviewed override.
 */
const regionAllowed = (
  system: UsCourtSystem,
  region: string,
  source: RegionSource,
): boolean => {
  switch (system) {
    case "state":
    case "tribal":
      return (
        STATE_REGIONS.has(region) ||
        (source === "override" && region === "multistate")
      );
    case "territory":
      return TERRITORY_REGIONS.has(region) || HISTORICAL_REGIONS.has(region);
    case "federal":
    case "military":
      return REGION_NAMES.has(region) || SCOPE_REGIONS.has(region);
    default: {
      system satisfies never;
      return panic(`Unhandled court system: ${String(system)}`);
    }
  }
};

const escapeRegExp = (value: string): string =>
  value.replace(/[$()*+.?[\\\]^{|}]/gu, "\\$&");

/**
 * The regions a phrase names, a longer name winning over a shorter one it
 * contains ("West Virginia" is not also Virginia, "Washington Territory" is
 * not also Washington).
 */
export const regionsNamedIn = (phrase: string): string[] => {
  const hits: { region: string; start: number; end: number }[] = [];
  for (const [region, names] of REGION_NAMES) {
    for (const name of names) {
      for (const match of phrase.matchAll(
        new RegExp(`(?<![A-Za-z])${escapeRegExp(name)}(?![A-Za-z])`, "giu"),
      )) {
        hits.push({
          region,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }
  }
  const kept = hits.filter(
    (hit) =>
      !hits.some(
        (other) =>
          other !== hit &&
          other.start <= hit.start &&
          other.end >= hit.end &&
          other.end - other.start > hit.end - hit.start,
      ),
  );
  return [...new Set(kept.map(({ region }) => region))].toSorted(compareText);
};

// -- Overrides ---------------------------------------------------------------

const idSchema = v.pipe(v.string(), v.minLength(1));
const reasonSchema = v.pipe(v.string(), v.minLength(1));

const regionSchema = v.picklist([...REGION_NAMES.keys(), ...US_SCOPE_REGIONS]);

const overridesSchema = v.strictObject({
  jurisdictionCodes: v.array(
    v.strictObject({ id: idSchema, code: idSchema, reason: reasonSchema }),
  ),
  systems: v.array(
    v.strictObject({
      id: idSchema,
      system: v.picklist(US_COURT_SYSTEMS),
      reason: reasonSchema,
    }),
  ),
  tiers: v.array(
    v.strictObject({
      id: idSchema,
      tier: v.picklist(US_COURT_TIERS),
      reason: reasonSchema,
    }),
  ),
  classifications: v.array(
    v.strictObject({
      id: idSchema,
      classification: v.picklist(US_COURT_CLASSIFICATIONS),
      reason: reasonSchema,
    }),
  ),
  regions: v.array(
    v.strictObject({
      id: idSchema,
      region: regionSchema,
      evidence: v.union([
        v.strictObject({ fullName: reasonSchema }),
        v.strictObject({ note: reasonSchema }),
      ]),
      /**
       * Present when the reviewed evidence supports the region without
       * settling it; the region stands until better source evidence exists.
       */
      certainty: v.optional(v.literal("reviewed-uncertain")),
    }),
  ),
  canonicalNames: v.array(
    v.strictObject({
      id: idSchema,
      canonicalName: reasonSchema,
      evidence: v.union([
        v.strictObject({ shortName: reasonSchema }),
        v.strictObject({ note: reasonSchema }),
      ]),
    }),
  ),
});

export type UsCourtOverrides = v.InferOutput<typeof overridesSchema>;

const parseOverrides = (json: string): UsCourtOverrides =>
  v.parse(overridesSchema, JSON.parse(json));

// -- Inputs ------------------------------------------------------------------

const parseTsv = (
  text: string,
  columns: readonly string[],
  file: string,
): Record<string, string>[] => {
  const [header, ...lines] = text.replace(/\n$/u, "").split("\n");
  if (header !== columns.join("\t")) {
    return panic(`${file}: header is not ${columns.join(",")}`);
  }
  return lines.map((line, index) => {
    const cells = line.split("\t");
    if (cells.length !== columns.length) {
      return panic(
        `${file}:${String(index + 2)}: expected ${String(columns.length)} cells`,
      );
    }
    return Object.fromEntries(
      columns.map((column, at) => [column, cells[at] ?? ""]),
    );
  });
};

const renderTsv = (
  rows: readonly Readonly<Record<string, string>>[],
  columns: readonly string[],
): string =>
  [
    columns.join("\t"),
    ...rows.map((row) =>
      columns
        .map((column) => {
          const value = row[column] ?? "";
          return /[\t\n\r]/u.test(value)
            ? panic(
                `a projected value holds a tab or line break: ${JSON.stringify(value)}`,
              )
            : value;
        })
        .join("\t"),
    ),
    "",
  ].join("\n");

const parseCourtListenerProjection = (text: string): SourceCourt[] =>
  parseTsv(text, COURTLISTENER_COLUMNS, COURTLISTENER_FILE).map(
    (row): SourceCourt => ({
      id: row["id"] ?? "",
      jurisdiction: row["jurisdiction"] ?? "",
      full_name: row["full_name"] ?? "",
      short_name: row["short_name"] ?? "",
      in_use: row["in_use"] ?? "",
      start_date: row["start_date"] ?? "",
      end_date: row["end_date"] ?? "",
      parent_court_id: row["parent_court_id"] ?? "",
    }),
  );

const parseCourtsDbProjection = (text: string): ReadonlyMap<string, string> =>
  new Map(
    parseTsv(text, ["id", "location"], COURTS_DB_FILE).map(
      (row) => [row["id"] ?? "", row["location"] ?? ""] as const,
    ),
  );

export type UsCourtInputs = {
  readonly courts: readonly SourceCourt[];
  /** courts-db id to its `location`. */
  readonly courtsDbLocations: ReadonlyMap<string, string>;
  readonly overrides: UsCourtOverrides;
};

// -- Directory ---------------------------------------------------------------

type AcceptedEntry = UsAcceptedCourtRow;

type RejectedEntry = UsRejectedCourtRow;

type DirectoryEntry = UsCourtDirectoryRow;

/** The partition a court id falls in; see `US_COURT_PARTITION_KEY_PREFIX`. */
const usCourtPartitionOf = (courtId: string): UsCourtPartition => {
  const digest = createHash("sha256")
    .update(`${US_COURT_PARTITION_KEY_PREFIX}${courtId}`, "utf-8")
    .digest();
  return usCourtPartitionLabel((digest[0] ?? 0) % US_COURT_PARTITION_COUNT);
};

/** Canonical names are bounded like the court column that stores them. */
const CANONICAL_NAME_MAX_LENGTH = 512;

const ISO_DATE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;

const parseDate = (
  value: string,
  problems: string[],
  label: string,
): string | null => {
  if (value === "") {
    return null;
  }
  const groups = ISO_DATE.exec(value)?.groups;
  const date =
    groups === undefined
      ? null
      : new Date(
          Date.UTC(
            Number(groups["year"]),
            Number(groups["month"]) - 1,
            Number(groups["day"]),
          ),
        );
  if (date === null || date.toISOString().slice(0, 10) !== value) {
    problems.push(`${label}: not a calendar date: ${JSON.stringify(value)}`);
    return null;
  }
  return value;
};

const byId = <T extends { readonly id: string }>(
  rows: readonly T[],
  table: string,
  known: ReadonlySet<string>,
  problems: string[],
): Map<string, T> => {
  const map = new Map<string, T>();
  for (const row of rows) {
    if (!known.has(row.id)) {
      problems.push(`${table}: ${row.id} is not a source court`);
    }
    if (map.has(row.id)) {
      problems.push(`${table}: ${row.id} appears twice`);
    }
    map.set(row.id, row);
  }
  return map;
};

type Classified = {
  readonly source: SourceCourt;
  readonly system: UsCourtSystem;
  readonly tier: UsCourtTier;
  readonly classification: UsCourtClassification;
};

type Row<K extends keyof UsCourtOverrides> = UsCourtOverrides[K][number];

type IndexedOverrides = {
  readonly codes: ReadonlyMap<string, Row<"jurisdictionCodes">>;
  readonly systems: ReadonlyMap<string, Row<"systems">>;
  readonly tiers: ReadonlyMap<string, Row<"tiers">>;
  readonly classifications: ReadonlyMap<string, Row<"classifications">>;
  readonly regions: ReadonlyMap<string, Row<"regions">>;
  readonly names: ReadonlyMap<string, Row<"canonicalNames">>;
};

/** Everything a build stage reads, and the list every stage reports to. */
type BuildContext = {
  readonly sources: ReadonlyMap<string, SourceCourt>;
  readonly courtsDbLocations: ReadonlyMap<string, string>;
  readonly overrides: IndexedOverrides;
  readonly problems: string[];
};

const indexSources = (
  courts: readonly SourceCourt[],
  problems: string[],
): Map<string, SourceCourt> => {
  const sources = new Map<string, SourceCourt>();
  for (const court of courts) {
    if (!/^[A-Za-z0-9]+$/u.test(court.id)) {
      problems.push(`${JSON.stringify(court.id)}: not an alphanumeric id`);
    }
    if (sources.has(court.id)) {
      problems.push(`${court.id}: appears twice in the source`);
    }
    sources.set(court.id, court);
  }
  return sources;
};

const indexOverrides = (
  overrides: UsCourtOverrides,
  known: ReadonlySet<string>,
  problems: string[],
): IndexedOverrides => ({
  codes: byId(
    overrides.jurisdictionCodes,
    "jurisdictionCodes",
    known,
    problems,
  ),
  systems: byId(overrides.systems, "systems", known, problems),
  tiers: byId(overrides.tiers, "tiers", known, problems),
  classifications: byId(
    overrides.classifications,
    "classifications",
    known,
    problems,
  ),
  regions: byId(overrides.regions, "regions", known, problems),
  names: byId(overrides.canonicalNames, "canonicalNames", known, problems),
});

/** An override that restates what the code already says is stale. */
const reportRestatements = (
  source: SourceCourt,
  disposition: AcceptedDisposition,
  { overrides, problems }: BuildContext,
): void => {
  const restated = [
    ["systems", overrides.systems.get(source.id)?.system, disposition.system],
    ["tiers", overrides.tiers.get(source.id)?.tier, disposition.tier],
    [
      "classifications",
      overrides.classifications.get(source.id)?.classification,
      disposition.classification,
    ],
  ] as const;
  for (const [table, override, byCode] of restated) {
    if (override === byCode) {
      problems.push(`${table}: ${source.id} is already ${byCode} by its code`);
    }
  }
};

/** A source court's disposition, system, tier and classification. */
const classify = (
  source: SourceCourt,
  context: BuildContext,
): Classified | RejectedEntry | undefined => {
  const { overrides, problems } = context;
  const codeOverride = overrides.codes.get(source.id);
  if (codeOverride?.code === source.jurisdiction) {
    problems.push(
      `jurisdictionCodes: ${source.id} already carries ${codeOverride.code}`,
    );
  }
  const code = codeOverride?.code ?? source.jurisdiction;
  const disposition = CODE_DISPOSITIONS[code];
  if (disposition === undefined) {
    problems.push(
      `${source.id}: jurisdiction code ${JSON.stringify(code)} has no disposition`,
    );
    return undefined;
  }
  if (disposition.status === "rejected") {
    return {
      status: "rejected",
      id: source.id,
      sourceName: source.full_name,
      rawJurisdiction: source.jurisdiction,
      reason: disposition.reason,
    };
  }
  reportRestatements(source, disposition, context);
  const system = overrides.systems.get(source.id)?.system ?? disposition.system;
  if (system === null) {
    problems.push(
      `${source.id}: code ${code} names no system and no override gives one`,
    );
    return undefined;
  }
  return {
    source,
    system,
    tier: overrides.tiers.get(source.id)?.tier ?? disposition.tier,
    classification:
      overrides.classifications.get(source.id)?.classification ??
      disposition.classification,
  };
};

/** Every parent exists, is accepted, and no parent chain loops. */
const checkParents = (
  classified: ReadonlyMap<string, Classified>,
  rejected: ReadonlyMap<string, RejectedEntry>,
  { sources, problems }: BuildContext,
): void => {
  for (const { source } of classified.values()) {
    const seen = new Set([source.id]);
    let parentId = source.parent_court_id;
    while (parentId !== "") {
      if (!sources.has(parentId)) {
        problems.push(`${source.id}: parent ${parentId} is not a source court`);
        break;
      }
      if (rejected.has(parentId)) {
        problems.push(`${source.id}: parent ${parentId} is rejected`);
        break;
      }
      if (seen.has(parentId)) {
        problems.push(`${source.id}: parent chain loops at ${parentId}`);
        break;
      }
      seen.add(parentId);
      parentId = sources.get(parentId)?.parent_court_id ?? "";
    }
  }
};

/** The region courts-db gives a court, when it is one its system allows. */
const courtsDbRegion = (
  court: Classified,
  { courtsDbLocations }: BuildContext,
): string | undefined => {
  const location = courtsDbLocations.get(court.source.id);
  const region =
    location === undefined ? undefined : COURTS_DB_LOCATIONS.get(location);
  return region !== undefined && regionAllowed(court.system, region, "derived")
    ? region
    : undefined;
};

/** A place, never a reach, inherited from a parent in the same system. */
const parentRegion = (
  court: Classified,
  classified: ReadonlyMap<string, Classified>,
  regions: ReadonlyMap<string, string>,
): string | undefined => {
  const parent = classified.get(court.source.parent_court_id);
  const region =
    parent === undefined ? undefined : regions.get(parent.source.id);
  return parent !== undefined &&
    parent.system === court.system &&
    region !== undefined &&
    isPlace(region) &&
    regionAllowed(court.system, region, "derived")
    ? region
    : undefined;
};

/** An override must be allowed, change something, and hold on its evidence. */
const checkRegionOverride = (
  court: Classified,
  override: Row<"regions">,
  withoutOverride: string | undefined,
  problems: string[],
): void => {
  const { id, full_name: fullName } = court.source;
  if (!regionAllowed(court.system, override.region, "override")) {
    problems.push(
      `regions: ${id} is a ${court.system} court and cannot sit in ${override.region}`,
    );
  }
  if (withoutOverride === override.region) {
    problems.push(
      `regions: ${id} resolves to ${override.region} without its override`,
    );
  }
  if (!("fullName" in override.evidence)) {
    return;
  }
  const phrase = override.evidence.fullName;
  const named = regionsNamedIn(phrase);
  if (!fullName.includes(phrase)) {
    problems.push(
      `regions: ${id} full name does not contain ${JSON.stringify(phrase)}`,
    );
  } else if (named.length !== 1 || named[0] !== override.region) {
    problems.push(
      `regions: ${JSON.stringify(phrase)} names ${named.join(",") || "no region"}, not ${override.region}, for ${id}`,
    );
  }
};

/** Regions: a reviewed override, then courts-db, then a same-system parent. */
const resolveRegions = (
  classified: ReadonlyMap<string, Classified>,
  context: BuildContext,
): Map<string, string> => {
  const { overrides, courtsDbLocations, problems } = context;
  const regions = new Map<string, string>();
  for (const court of classified.values()) {
    const { id } = court.source;
    const override = overrides.regions.get(id);
    const derived = courtsDbRegion(court, context);
    const location = courtsDbLocations.get(id);
    if (
      override === undefined &&
      location !== undefined &&
      derived === undefined
    ) {
      problems.push(
        `${id}: courts-db location ${JSON.stringify(location)} is not a region of a ${court.system} court; review it in regions`,
      );
    }
    const region = override?.region ?? derived;
    if (region !== undefined) {
      regions.set(id, region);
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const court of classified.values()) {
      const region = regions.has(court.source.id)
        ? undefined
        : parentRegion(court, classified, regions);
      if (region !== undefined) {
        regions.set(court.source.id, region);
        changed = true;
      }
    }
  }
  for (const court of classified.values()) {
    const override = overrides.regions.get(court.source.id);
    if (!regions.has(court.source.id)) {
      problems.push(
        `${court.source.id}: no region for a ${court.system} court (${court.source.full_name})`,
      );
    } else if (override !== undefined) {
      const withoutOverride =
        courtsDbRegion(court, context) ??
        parentRegion(court, classified, regions);
      checkRegionOverride(court, override, withoutOverride, problems);
    }
  }
  return regions;
};

const normalizedName = (name: string): string => name.normalize("NFC").trim();

/** An override distinguishes a shared source name, on evidence that holds. */
const checkNameOverride = (
  source: SourceCourt,
  override: Row<"canonicalNames">,
  sharedBy: number,
  problems: string[],
): void => {
  if (sharedBy < 2) {
    problems.push(
      `canonicalNames: ${source.id} shares its name with no other court`,
    );
  }
  if (
    "shortName" in override.evidence &&
    !source.short_name.includes(override.evidence.shortName)
  ) {
    problems.push(
      `canonicalNames: ${source.id} short name does not contain ${JSON.stringify(override.evidence.shortName)}`,
    );
  }
};

/**
 * Canonical names: the source name, NFC and trimmed, unless a reviewed
 * override distinguishes a court whose source name another court shares.
 * Unique regardless of case, since the rank patterns match either case.
 */
const resolveCanonicalNames = (
  classified: ReadonlyMap<string, Classified>,
  { overrides, problems }: BuildContext,
): Map<string, string> => {
  const sharedBy = new Map<string, number>();
  for (const { source } of classified.values()) {
    const key = normalizedName(source.full_name);
    sharedBy.set(key, (sharedBy.get(key) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  for (const { source } of classified.values()) {
    const normalized = normalizedName(source.full_name);
    const override = overrides.names.get(source.id);
    if (override !== undefined) {
      checkNameOverride(
        source,
        override,
        sharedBy.get(normalized) ?? 0,
        problems,
      );
    }
    const name = override?.canonicalName ?? normalized;
    if (name !== normalizedName(name)) {
      problems.push(`canonicalNames: ${source.id} is not NFC and trimmed`);
    }
    names.set(source.id, name);
  }
  const holders = new Map<string, string[]>();
  for (const [id, name] of names) {
    if (name.length === 0 || name.length > CANONICAL_NAME_MAX_LENGTH) {
      problems.push(
        `${id}: canonical name length ${String(name.length)} is outside 1..${String(CANONICAL_NAME_MAX_LENGTH)}`,
      );
    }
    const key = name.toLowerCase();
    holders.set(key, [...(holders.get(key) ?? []), id]);
  }
  for (const ids of holders.values()) {
    if (ids.length > 1) {
      problems.push(
        `${ids.join(", ")}: share the canonical name ${JSON.stringify(names.get(ids[0] ?? ""))}`,
      );
    }
  }
  return names;
};

const acceptedEntry = (
  { source, system, tier, classification }: Classified,
  region: string,
  canonicalName: string,
  problems: string[],
): AcceptedEntry => {
  const startDate = parseDate(
    source.start_date,
    problems,
    `${source.id} start_date`,
  );
  const endDate = parseDate(source.end_date, problems, `${source.id} end_date`);
  if (startDate !== null && endDate !== null && startDate > endDate) {
    problems.push(`${source.id}: starts ${startDate} after it ends ${endDate}`);
  }
  if (source.in_use !== "t" && source.in_use !== "f") {
    problems.push(`${source.id}: in_use is ${JSON.stringify(source.in_use)}`);
  }
  return {
    status: "accepted",
    id: source.id,
    sourceName: source.full_name,
    canonicalName,
    rawJurisdiction: source.jurisdiction,
    classification,
    system,
    // Every region the resolver keeps passed `regionAllowed`.
    region: isUsCourtRegion(region)
      ? region
      : panic(`${source.id}: region ${JSON.stringify(region)} is not a region`),
    tier,
    startDate,
    endDate,
    sourceInUse: source.in_use === "t",
    parentId: source.parent_court_id === "" ? null : source.parent_court_id,
    courtPartition: usCourtPartitionOf(source.id),
  };
};

/** Overrides may not describe a court that is rejected. */
const checkOverridesAccepted = (
  rejected: ReadonlyMap<string, RejectedEntry>,
  { overrides, problems }: BuildContext,
): void => {
  const tables = [
    overrides.systems,
    overrides.tiers,
    overrides.classifications,
    overrides.regions,
    overrides.names,
  ];
  for (const table of tables) {
    for (const id of table.keys()) {
      if (rejected.has(id)) {
        problems.push(
          `overrides: ${id} is rejected, so nothing about it is resolved`,
        );
      }
    }
  }
};

/**
 * Builds the directory from its inputs, or throws one error listing every
 * problem found, so a regeneration surfaces all of them at once.
 */
export const buildUsCourtDirectory = ({
  courts,
  courtsDbLocations,
  overrides,
}: UsCourtInputs): DirectoryEntry[] => {
  const problems: string[] = [];
  const sources = indexSources(courts, problems);
  const context: BuildContext = {
    sources,
    courtsDbLocations,
    overrides: indexOverrides(overrides, new Set(sources.keys()), problems),
    problems,
  };

  const classified = new Map<string, Classified>();
  const rejected = new Map<string, RejectedEntry>();
  for (const source of sources.values()) {
    const result = classify(source, context);
    if (result === undefined) {
      continue;
    }
    if ("status" in result) {
      rejected.set(result.id, result);
    } else {
      classified.set(source.id, result);
    }
  }
  checkOverridesAccepted(rejected, context);
  checkParents(classified, rejected, context);
  const regions = resolveRegions(classified, context);
  const names = resolveCanonicalNames(classified, context);

  const entries: DirectoryEntry[] = [...rejected.values()];
  for (const court of classified.values()) {
    const region = regions.get(court.source.id);
    const name = names.get(court.source.id);
    if (region !== undefined && name !== undefined) {
      entries.push(acceptedEntry(court, region, name, problems));
    }
  }
  if (problems.length > 0) {
    return panic(
      `The court directory does not generate:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
  }
  return entries.toSorted((left, right) => compareText(left.id, right.id));
};

// -- Rendering ---------------------------------------------------------------

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

const literal = (value: string | boolean | null): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

/** One string property of a formatted object literal, wrapped as oxfmt wraps it. */
const property = (key: string, value: string): string => {
  const line = `  ${key}: ${literal(value)},`;
  return line.length <= 80 ? line : `  ${key}:\n    ${literal(value)},`;
};

const renderEntry = (entry: DirectoryEntry): string => {
  const fields: [string, string | boolean | null][] =
    entry.status === "accepted"
      ? [
          ["status", entry.status],
          ["id", entry.id],
          ["sourceName", entry.sourceName],
          ["canonicalName", entry.canonicalName],
          ["rawJurisdiction", entry.rawJurisdiction],
          ["classification", entry.classification],
          ["system", entry.system],
          ["region", entry.region],
          ["tier", entry.tier],
          ["startDate", entry.startDate],
          ["endDate", entry.endDate],
          ["sourceInUse", entry.sourceInUse],
          ["parentId", entry.parentId],
          ["courtPartition", entry.courtPartition],
        ]
      : [
          ["status", entry.status],
          ["id", entry.id],
          ["sourceName", entry.sourceName],
          ["rawJurisdiction", entry.rawJurisdiction],
          ["reason", entry.reason],
        ];
  return `  row({ ${fields.map(([key, value]) => `${key}: ${literal(value)}`).join(", ")} }),`;
};

type InputFiles = {
  readonly courtListener: string;
  readonly courtsDb: string;
  readonly overrides: string;
};

const renderProvenance = (files: InputFiles): string =>
  `${JSON.stringify(
    {
      generator: "scripts/generate-us-courts.ts",
      generatorVersion: GENERATOR_VERSION,
      courtListener: {
        ...COURTLISTENER_EXPORT,
        projection: {
          file: COURTLISTENER_FILE,
          columns: COURTLISTENER_COLUMNS,
          sha256: sha256(files.courtListener),
        },
      },
      courtsDb: {
        ...COURTS_DB,
        notice: COURTS_DB_NOTICE_FILE,
        projection: {
          file: COURTS_DB_FILE,
          columns: ["id", "location"],
          sha256: sha256(files.courtsDb),
        },
      },
      overrides: { file: OVERRIDES_FILE, sha256: sha256(files.overrides) },
    },
    null,
    2,
  )}\n`;

/** A list of string literals, packed onto lines the width oxfmt keeps. */
const packed = (values: readonly string[]): string[] => {
  const lines: string[] = [];
  let line = "";
  for (const value of values) {
    const item = `${literal(value)},`;
    if (line !== "" && line.length + 1 + item.length > 80) {
      lines.push(line);
      line = "";
    }
    line = line === "" ? `  ${item}` : `${line} ${item}`;
  }
  return line === "" ? lines : [...lines, line];
};

export const renderDirectory = (
  entries: readonly DirectoryEntry[],
  files: InputFiles,
): string =>
  [
    "// Generated by scripts/generate-us-courts.ts from the pinned inputs in",
    "// packages/api-contract/data/us-courts (see provenance.json there).",
    "// Do not edit by hand. Derived in part from courts-db; see",
    "// ../data/us-courts/courts-db.LICENSE.",
    "",
    'import type { UsCourtDirectoryRow } from "./us-court-vocabulary";',
    "",
    "export const US_COURT_DIRECTORY_SOURCES = {",
    `  generatorVersion: ${String(GENERATOR_VERSION)},`,
    property("courtListenerExport", COURTLISTENER_EXPORT.object),
    property("courtListenerSha256", COURTLISTENER_EXPORT.sha256),
    property("courtsDbCommit", COURTS_DB.commit),
    property("courtsDbSha256", COURTS_DB.sha256),
    property("courtListenerProjectionSha256", sha256(files.courtListener)),
    property("courtsDbProjectionSha256", sha256(files.courtsDb)),
    property("overridesSha256", sha256(files.overrides)),
    "} as const;",
    "",
    "/** The ids of the accepted courts, in id order. */",
    "// oxfmt-ignore",
    "export const US_COURT_IDS: readonly string[] = [",
    ...packed(
      entries.filter(({ status }) => status === "accepted").map(({ id }) => id),
    ),
    "];",
    "",
    "/** The ids of the rejected source courts, in id order. */",
    "// oxfmt-ignore",
    "export const US_REJECTED_COURT_IDS: readonly string[] = [",
    ...packed(
      entries.filter(({ status }) => status === "rejected").map(({ id }) => id),
    ),
    "];",
    "",
    "/**",
    " * One row, checked against the row type on its own: the list is then typed",
    " * as rows rather than as the union of every row's literal type, which is",
    " * too large for the type checker to compare against.",
    " */",
    "const row = (entry: UsCourtDirectoryRow): UsCourtDirectoryRow => entry;",
    "",
    "/** Every source court, accepted or rejected, in id order. */",
    "// oxfmt-ignore",
    "export const US_COURT_DIRECTORY: readonly UsCourtDirectoryRow[] = [",
    ...entries.map(renderEntry),
    "];",
    "",
  ].join("\n");

// -- Files -------------------------------------------------------------------

export const readInputFiles = async (): Promise<InputFiles> => {
  const [courtListener, courtsDb, overrides] = await Promise.all(
    [COURTLISTENER_FILE, COURTS_DB_FILE, OVERRIDES_FILE].map(
      async (file) => await readFile(path.join(DATA_DIR, file), "utf-8"),
    ),
  );
  return {
    courtListener: courtListener ?? "",
    courtsDb: courtsDb ?? "",
    overrides: overrides ?? "",
  };
};

export const inputsFromFiles = (files: InputFiles): UsCourtInputs => ({
  courts: parseCourtListenerProjection(files.courtListener),
  courtsDbLocations: parseCourtsDbProjection(files.courtsDb),
  overrides: parseOverrides(files.overrides),
});

/** `source` as the repository formatter lays it out. */
const formatted = async (
  source: string,
  extension: string,
): Promise<string> => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "us-courts-"));
  try {
    const file = path.join(workDir, `output.${extension}`);
    await writeFile(file, source, "utf-8");
    const result = Bun.spawnSync(
      [process.execPath, "--bun", "oxfmt", "-c", FORMATTER_CONFIG, file],
      { cwd: REPO_ROOT, stderr: "inherit", stdout: "ignore" },
    );
    if (result.exitCode !== 0) {
      return panic(`oxfmt failed on the generated ${extension} file`);
    }
    return await readFile(file, "utf-8");
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
};

const fetchBytes = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url);
  if (!response.ok) {
    return panic(`GET ${url} answered ${String(response.status)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
};

/**
 * The export's CSV quoting: PostgreSQL CSV with a backslash escape, so a
 * quote inside a quoted field is `\"`.
 */
const parseExportCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? "";
    const next = text[at + 1] ?? "";
    if (quoted) {
      if (char === "\\" && (next === '"' || next === "\\")) {
        field += next;
        at += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};

const refreshInputs = async (exportPath: string): Promise<void> => {
  const compressed = new Uint8Array(await readFile(exportPath));
  if (sha256(compressed) !== COURTLISTENER_EXPORT.sha256) {
    return panic(`${exportPath} is not ${COURTLISTENER_EXPORT.object}`);
  }
  const decompressed = Bun.spawnSync(["bunzip2", "-c", exportPath], {
    stderr: "inherit",
  });
  if (decompressed.exitCode !== 0) {
    return panic("bunzip2 failed on the export");
  }
  if (sha256(decompressed.stdout) !== COURTLISTENER_EXPORT.decompressedSha256) {
    return panic("the decompressed export does not match its pinned digest");
  }
  const [header, ...records] = parseExportCsv(
    decompressed.stdout.toString("utf-8"),
  );
  const columnIndex = new Map((header ?? []).map((name, at) => [name, at]));
  const courts = records.map((record) => {
    if (record.length !== columnIndex.size) {
      return panic(`an export record has ${String(record.length)} fields`);
    }
    return Object.fromEntries(
      COURTLISTENER_COLUMNS.map((column) => [
        column,
        record[
          columnIndex.get(column) ?? panic(`the export has no ${column} column`)
        ] ?? "",
      ]),
    );
  });

  const [courtsJson, license] = await Promise.all([
    fetchBytes(`${COURTS_DB_RAW}/${COURTS_DB.file}`),
    fetchBytes(`${COURTS_DB_RAW}/LICENSE`),
  ]);
  if (sha256(courtsJson) !== COURTS_DB.sha256) {
    return panic(
      `${COURTS_DB.file} at ${COURTS_DB.commit} does not match its pinned digest`,
    );
  }
  const courtsDb = v.parse(
    v.array(
      v.looseObject({ id: v.string(), location: v.optional(v.string()) }),
    ),
    JSON.parse(new TextDecoder().decode(courtsJson)),
  );
  const locations = courtsDb
    .filter(({ location }) => location !== undefined && location !== "")
    .map(({ id, location }) => ({ id, location: location ?? "" }));

  const byIdOrder = (left: { id?: string }, right: { id?: string }): number =>
    compareText(left.id ?? "", right.id ?? "");
  await Promise.all([
    writeFile(
      path.join(DATA_DIR, COURTLISTENER_FILE),
      renderTsv(courts.toSorted(byIdOrder), COURTLISTENER_COLUMNS),
      "utf-8",
    ),
    writeFile(
      path.join(DATA_DIR, COURTS_DB_FILE),
      renderTsv(locations.toSorted(byIdOrder), ["id", "location"]),
      "utf-8",
    ),
    writeFile(
      path.join(DATA_DIR, COURTS_DB_NOTICE_FILE),
      [
        "courts-db-locations.tsv, and the court directory generated from it in",
        "packages/api-contract/src/us-courts.generated.ts, are derived in part from",
        `courts-db (${COURTS_DB.repository}), commit`,
        `${COURTS_DB.commit}, which is distributed under the following license:`,
        "",
        new TextDecoder().decode(license).trimEnd(),
        "",
      ].join("\n"),
      "utf-8",
    ),
  ]);
};

const main = async (): Promise<number> => {
  const refreshAt = process.argv.indexOf("--refresh-inputs");
  if (refreshAt !== -1) {
    const exportPath =
      process.argv[refreshAt + 1] ??
      panic("--refresh-inputs takes the export path");
    await refreshInputs(exportPath);
    console.log("refreshed the projections; run with --write to regenerate");
    return 0;
  }

  const files = await readInputFiles();
  const directory = renderDirectory(
    buildUsCourtDirectory(inputsFromFiles(files)),
    files,
  );
  // The directory is compared without the formatter (its test does the
  // same), so the renderer has to produce the formatted text itself.
  if ((await formatted(directory, "ts")) !== directory) {
    return panic("oxfmt changes the generated directory; fix the renderer");
  }
  const artifacts = [
    { path: DIRECTORY_PATH, contents: directory },
    {
      path: path.join(DATA_DIR, PROVENANCE_FILE),
      contents: await formatted(renderProvenance(files), "json"),
    },
  ];

  if (process.argv.includes("--write")) {
    await Promise.all(
      artifacts.map(
        async ({ contents, path: file }) =>
          await writeFile(file, contents, "utf-8"),
      ),
    );
    console.log(`wrote ${String(artifacts.length)} files`);
    return 0;
  }

  const drifted: string[] = [];
  for (const { contents, path: file } of artifacts) {
    const committed = await readFile(file, "utf-8").catch(() => null);
    if (committed !== contents) {
      drifted.push(path.relative(REPO_ROOT, file));
    }
  }
  for (const file of drifted) {
    console.error(`drifted: ${file}`);
  }
  if (drifted.length > 0) {
    console.error("Run with --write.");
    return 1;
  }
  console.log(`${String(artifacts.length)} files match their inputs`);
  return 0;
};

if (import.meta.main) {
  process.exit(await main());
}
