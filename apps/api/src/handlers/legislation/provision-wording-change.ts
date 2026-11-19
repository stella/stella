import { panic } from "better-result";

import { normalizeUnicode } from "@stll/text-normalize";

import type { ProvisionReading } from "@/api/handlers/legislation/provision-text";

/**
 * How one consolidation's wording of a provision relates to the wording in
 * the consolidation of the act just before it:
 *
 * - `changed`: that consolidation carries the provision in other words.
 * - `unchanged`: it carries the same words; the act was consolidated again
 *   for a change elsewhere.
 * - `added`: it does not carry the provision, so this one brought it in.
 * - `earliest`: there is no older consolidation on record, so nothing says
 *   whether this wording is new.
 * - `unknown`: the older consolidation could not be read, so nothing is
 *   claimed either way.
 */
export const PROVISION_WORDING_CHANGES = [
  "changed",
  "unchanged",
  "added",
  "earliest",
  "unknown",
] as const;

export type ProvisionWordingChange = (typeof PROVISION_WORDING_CHANGES)[number];

/** One consolidation of the act, as a walk over its versions reads it. */
export type VersionProvisionReading =
  | { type: "found"; reading: ProvisionReading }
  /** The consolidation is readable and carries no such anchor. */
  | { type: "absent" }
  /** The consolidation's structure could not be read at all. */
  | { type: "unavailable" };

// Every Unicode space, including the no-break spaces typeset after Czech and
// Slovak one-letter prepositions, and line breaks between blocks.
const WHITESPACE_RUN = /\s+/gu;

/**
 * The provision's wording as it is compared across consolidations: canonical
 * Unicode composition, every run of whitespace one space, no edge spaces.
 * Consolidations of one act are typeset independently, so line breaks and
 * the kind of space between words vary where the wording does not. Any
 * other character is kept, so a changed letter, digit or punctuation mark
 * always reads as a change. Never used for display: the text a reader sees
 * is the publisher's own.
 */
export const normalizeProvisionWording = (text: string): string =>
  normalizeUnicode(text, "NFC").replaceAll(WHITESPACE_RUN, " ").trim();

/**
 * The comparison key of a reading: its own text and the governing wording
 * around a subdivision, since a lead-in that changed changes what the
 * subdivision says even when its own words did not.
 */
const wordingKey = (reading: ProvisionReading): string =>
  JSON.stringify([
    normalizeProvisionWording(reading.text),
    reading.governing.map((wording) => [
      wording.position,
      normalizeProvisionWording(wording.text),
    ]),
    reading.governingTruncated,
  ]);

/** Whether two readings say the same thing; see `normalizeProvisionWording`. */
export const sameProvisionWording = (
  newer: ProvisionReading,
  older: ProvisionReading,
): boolean => wordingKey(newer) === wordingKey(older);

/**
 * How a found wording relates to the consolidation just before it. `older` is
 * undefined only when no older consolidation of the act exists.
 */
export const provisionWordingChange = (
  reading: ProvisionReading,
  older: VersionProvisionReading | undefined,
): ProvisionWordingChange => {
  if (older === undefined) {
    return "earliest";
  }
  switch (older.type) {
    case "absent":
      return "added";
    case "unavailable":
      return "unknown";
    case "found":
      return sameProvisionWording(reading, older.reading)
        ? "unchanged"
        : "changed";
    default: {
      return panic("Unhandled provision reading", older satisfies never);
    }
  }
};
