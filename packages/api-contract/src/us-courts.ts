import { panic } from "better-result";

import {
  isUsCourtRegion,
  US_ACCEPTED_COURT_FIELDS,
  US_COURT_CLASSIFICATIONS,
  US_COURT_DIRECTORY_FIELD_SEPARATOR,
  US_COURT_PARTITIONS,
  US_COURT_REJECTION_REASONS,
  US_COURT_SYSTEMS,
  US_COURT_TIERS,
  US_REJECTED_COURT_FIELDS,
} from "./us-court-vocabulary";
import type {
  UsAcceptedCourtRow,
  UsCourtDirectoryRow,
  UsCourtRegion,
  UsCourtRejectionReason,
  UsRejectedCourtRow,
} from "./us-court-vocabulary";
import { US_COURT_DIRECTORY_TEXT } from "./us-courts.generated";

/**
 * The United States court directory: every court of the source registry, one
 * entry per court id, accepted or rejected. The entries are generated
 * (`us-courts.generated.ts`, by `scripts/generate-us-courts.ts`) as text and
 * read into rows once, here, checked field by field against the vocabulary
 * (`us-court-vocabulary.ts`). This module derives every id list and lookup
 * from them, so no list of courts is written by hand anywhere else.
 *
 * An accepted court is one the directory can name: it has a canonical name, a
 * system, a region, a tier and a partition. Its decisions may be written: the
 * jurisdiction's index files each under the court's partition, whose count is
 * fixed however many courts write, and every rank reads the court's tier by
 * its id. A rejected or unknown id is never written.
 */
export * from "./us-court-vocabulary";
export { US_COURT_DIRECTORY_SOURCES } from "./us-courts.generated";

export type UsCourt = UsAcceptedCourtRow;

export type UsCourtDirectoryEntry = UsCourtDirectoryRow;

// -- Reading the generated text ---------------------------------------------

/** One line's fields by name; `line` is 1-based, for the panic message. */
const fieldsOf = (
  names: readonly string[],
  values: readonly string[],
  line: number,
): ReadonlyMap<string, string> =>
  values.length === names.length
    ? new Map(names.map((name, index) => [name, values[index] ?? ""]))
    : panic(
        `us-courts: line ${String(line)} has ${String(values.length)} fields, not ${String(names.length)}`,
      );

const text = (fields: ReadonlyMap<string, string>, name: string): string =>
  fields.get(name) ?? panic(`us-courts: no field ${name}`);

const nullableText = (
  fields: ReadonlyMap<string, string>,
  name: string,
): string | null => {
  const value = text(fields, name);
  return value === "" ? null : value;
};

const flag = (fields: ReadonlyMap<string, string>, name: string): boolean => {
  const value = text(fields, name);
  if (value !== "true" && value !== "false") {
    return panic(`us-courts: ${name} is ${JSON.stringify(value)}`);
  }
  return value === "true";
};

const oneOf = <T extends string>(
  allowed: readonly T[],
  fields: ReadonlyMap<string, string>,
  name: string,
): T => {
  const value = text(fields, name);
  return (
    allowed.find((candidate) => candidate === value) ??
    panic(
      `us-courts: ${name} ${JSON.stringify(value)} is not in the vocabulary`,
    )
  );
};

const region = (fields: ReadonlyMap<string, string>): UsCourtRegion => {
  const value = text(fields, "region");
  return isUsCourtRegion(value)
    ? value
    : panic(`us-courts: region ${JSON.stringify(value)} is not a region`);
};

const acceptedRow = (
  values: readonly string[],
  line: number,
): UsAcceptedCourtRow => {
  const fields = fieldsOf(US_ACCEPTED_COURT_FIELDS, values, line);
  return {
    status: "accepted",
    id: text(fields, "id"),
    sourceName: text(fields, "sourceName"),
    canonicalName: text(fields, "canonicalName"),
    shortCode: text(fields, "shortCode"),
    rawJurisdiction: text(fields, "rawJurisdiction"),
    classification: oneOf(US_COURT_CLASSIFICATIONS, fields, "classification"),
    system: oneOf(US_COURT_SYSTEMS, fields, "system"),
    region: region(fields),
    tier: oneOf(US_COURT_TIERS, fields, "tier"),
    startDate: nullableText(fields, "startDate"),
    endDate: nullableText(fields, "endDate"),
    sourceInUse: flag(fields, "sourceInUse"),
    parentId: nullableText(fields, "parentId"),
    courtPartition: oneOf(US_COURT_PARTITIONS, fields, "courtPartition"),
  };
};

const rejectedRow = (
  values: readonly string[],
  line: number,
): UsRejectedCourtRow => {
  const fields = fieldsOf(US_REJECTED_COURT_FIELDS, values, line);
  const reason: UsCourtRejectionReason = oneOf(
    US_COURT_REJECTION_REASONS,
    fields,
    "reason",
  );
  return {
    status: "rejected",
    id: text(fields, "id"),
    sourceName: text(fields, "sourceName"),
    rawJurisdiction: text(fields, "rawJurisdiction"),
    reason,
  };
};

const directoryRow = (source: string, index: number): UsCourtDirectoryRow => {
  const values = source.split(US_COURT_DIRECTORY_FIELD_SEPARATOR);
  const [status = ""] = values;
  switch (status) {
    case "accepted":
      return acceptedRow(values, index + 1);
    case "rejected":
      return rejectedRow(values, index + 1);
    default:
      return panic(
        `us-courts: line ${String(index + 1)} has status ${JSON.stringify(status)}`,
      );
  }
};

/** Every source court, in id order. */
export const US_COURT_DIRECTORY: readonly UsCourtDirectoryEntry[] =
  US_COURT_DIRECTORY_TEXT.split("\n").map(directoryRow);

const isAccepted = (entry: UsCourtDirectoryEntry): entry is UsCourt =>
  entry.status === "accepted";

/** The accepted courts, in id order. */
export const US_COURTS: readonly UsCourt[] =
  US_COURT_DIRECTORY.filter(isAccepted);

/** The ids of the accepted courts, in id order. */
export const US_COURT_IDS: readonly string[] = US_COURTS.map(({ id }) => id);

/** The ids of the rejected source courts, in id order. */
export const US_REJECTED_COURT_IDS: readonly string[] =
  US_COURT_DIRECTORY.filter((entry) => !isAccepted(entry)).map(({ id }) => id);

/** The canonical names, one per accepted court. */
export const US_COURT_NAMES: readonly string[] = US_COURTS.map(
  ({ canonicalName }) => canonicalName,
);

const ENTRY_BY_ID: ReadonlyMap<string, UsCourtDirectoryEntry> = new Map(
  US_COURT_DIRECTORY.map((entry) => [entry.id, entry]),
);

/** The accepted court stored under a canonical name, exactly as spelled. */
export const US_COURT_BY_CANONICAL_NAME: ReadonlyMap<string, UsCourt> = new Map(
  US_COURTS.map((court) => [court.canonicalName, court]),
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
 * outside the jurisdiction. The write boundary admits exactly the accepted
 * courts, each under its canonical name.
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
