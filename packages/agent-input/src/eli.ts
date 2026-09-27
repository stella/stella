/**
 * European Legislation Identifiers on the agent wire.
 *
 * An ELI names one act as `/eli/{jurisdiction}/{collection}/{year}/{number}`
 * under its publisher's origin. A model copies it out of wherever it last saw
 * one: a search result (canonical), a citation it rebuilt itself (no origin,
 * uppercase `CZ/SB`), a browser bar (`e-sbirka.cz/...` with a trailing slash),
 * or its own memory of the act, where year and number trade places. The work
 * each of those names is not in doubt, so each is read.
 *
 * What is not read: a year/number pair that is two years (`2000/1999` names a
 * different act in each order), and a path that goes past the work into a
 * version date or a provision, which is a different question the tool answers
 * through its own properties.
 */

import type { Normalized } from "./normalized";
import { askForFix, readValueAs } from "./normalized";

export type EliOptions = {
  /** ELI jurisdiction segment (lowercase, `"cz"`) to the publisher origin
   *  (`"https://www.e-sbirka.cz"`) that canonical identifiers carry. */
  hosts: Readonly<Record<string, string>>;
  /** The caller's gazette-citation reader, for an input that is not an ELI at
   *  all (`89/2012 Sb.`): the ELI that citation names, or undefined. */
  readCitation?: ((text: string) => string | undefined) | undefined;
  /** The corrective call when the input is not an ELI. */
  hint?: string | undefined;
};

const ELI_EXPECTED = "an ELI";
const ELI_HINT = "Pass the eli a search result returned.";

/** An origin with a scheme, or a bare host a model pasted without one; a bare
 *  host needs a dot so `cz/sb/...` is never taken for one. */
const ORIGIN_RE =
  /^(?:(?<scheme>https?):\/\/(?<host>[^/\s]+)|(?<bareHost>[a-z0-9-]+(?:\.[a-z0-9-]+)+))(?=\/|$)/iu;
const TRAILING_SLASHES_RE = /\/+$/u;
const JURISDICTION_RE = /^[a-z]{2,3}$/u;
const COLLECTION_RE = /^[a-z0-9-]+$/u;
const DIGITS_RE = /^\d+$/u;
const FOUR_DIGITS_RE = /^\d{4}$/u;
/** A version date past the work: `2024-01-01` or `20240101`. */
const DATE_SEGMENT_RE = /^\d{4}-?\d{2}-?\d{2}$/u;

const EARLIEST_YEAR = 1800;
const LATEST_YEAR = 2100;

const isYear = (segment: string): boolean => {
  if (!FOUR_DIGITS_RE.test(segment)) {
    return false;
  }
  const year = Number(segment);
  return year >= EARLIEST_YEAR && year <= LATEST_YEAR;
};

type ParsedEli = {
  /** The origin the input carried, normalised, or null. */
  origin: string | null;
  jurisdiction: string;
  collection: string;
  first: string;
  second: string;
  extra: readonly string[];
};

/** The parts of an ELI in any of its spellings, or null when the input is not
 *  shaped like one at all. */
const parseEli = (trimmed: string): ParsedEli | null => {
  const originMatch = ORIGIN_RE.exec(trimmed);
  const groups = originMatch?.groups;
  const host = groups?.["host"] ?? groups?.["bareHost"];
  const scheme = groups?.["scheme"]?.toLowerCase() ?? "https";
  const origin =
    host === undefined ? null : `${scheme}://${host.toLowerCase()}`;
  const path = trimmed.slice(originMatch?.[0].length ?? 0);
  const segments = path.split("/").filter((segment) => segment !== "");
  const [head, ...afterHead] = segments;
  const hasEliSegment = head?.toLowerCase() === "eli";
  // A URL whose path does not start at `eli/` is some other page on the host.
  if (origin !== null && !hasEliSegment) {
    return null;
  }
  const [jurisdiction, collection, first, second, ...extra] = hasEliSegment
    ? afterHead
    : segments;
  if (
    jurisdiction === undefined ||
    collection === undefined ||
    first === undefined ||
    second === undefined
  ) {
    return null;
  }
  const lowerJurisdiction = jurisdiction.toLowerCase();
  const lowerCollection = collection.toLowerCase();
  const shaped =
    JURISDICTION_RE.test(lowerJurisdiction) &&
    COLLECTION_RE.test(lowerCollection) &&
    DIGITS_RE.test(first) &&
    DIGITS_RE.test(second);
  return shaped
    ? {
        origin,
        jurisdiction: lowerJurisdiction,
        collection: lowerCollection,
        first,
        second,
        extra,
      }
    : null;
};

const eliOf = (
  origin: string,
  { jurisdiction, collection }: ParsedEli,
  year: string,
  number: string,
): string => `${origin}/eli/${jurisdiction}/${collection}/${year}/${number}`;

/**
 * Read an ELI an agent spelled its own way, as the canonical work identifier
 * under its publisher's origin. An input that is not an ELI goes through the
 * caller's citation reader before it asks.
 */
export const normalizeEli = (
  input: unknown,
  options: EliOptions,
): Normalized<string> => {
  const notAnEli = () =>
    askForFix({
      input,
      expected: ELI_EXPECTED,
      hint: options.hint ?? ELI_HINT,
    });
  if (typeof input !== "string") {
    return notAnEli();
  }
  const trimmed = input.trim();
  const parsed = parseEli(trimmed);

  if (parsed === null) {
    const cited = options.readCitation?.(trimmed);
    if (cited === undefined) {
      return notAnEli();
    }
    // The citation reader's ELI is read like any other, without the citation
    // reader, so a reader that returns its input cannot loop.
    const read = normalizeEli(cited, { ...options, readCitation: undefined });
    return read.ok ? readValueAs(input, read.value) : read;
  }

  const origin =
    options.hosts[parsed.jurisdiction]?.replace(TRAILING_SLASHES_RE, "") ??
    parsed.origin;
  if (origin === null) {
    return askForFix({
      input,
      expected: ELI_EXPECTED,
      hint: `No publisher is known for the jurisdiction "${parsed.jurisdiction}". ${
        options.hint ?? ELI_HINT
      }`,
    });
  }

  const firstIsYear = isYear(parsed.first);
  const secondIsYear = isYear(parsed.second);
  if (firstIsYear && secondIsYear) {
    const asWritten = eliOf(origin, parsed, parsed.first, parsed.second);
    // Exactly the canonical identifier is the publisher's own order, which is
    // what a search result hands back; only a spelling the model rebuilt is in
    // doubt.
    if (input === asWritten) {
      return readValueAs(input, asWritten);
    }
    const swapped = eliOf(origin, parsed, parsed.second, parsed.first);
    return askForFix({
      input,
      expected: ELI_EXPECTED,
      hint:
        `Both ${parsed.first} and ${parsed.second} read as a year, so this ` +
        `names "${asWritten}" or "${swapped}". Pass the one you mean.`,
    });
  }
  // Neither segment reads as a year: nothing says the order is wrong, so the
  // publisher's order is kept and only the spelling around it is canonical.
  // Whether such a work exists is the corpus's `not_found` to answer.
  const work =
    firstIsYear || !secondIsYear
      ? eliOf(origin, parsed, parsed.first, parsed.second)
      : eliOf(origin, parsed, parsed.second, parsed.first);

  if (parsed.extra.length > 0) {
    const dated = parsed.extra.some((segment) => DATE_SEGMENT_RE.test(segment));
    return askForFix({
      input,
      expected: "the ELI of a work",
      hint: dated
        ? `Pass the work ELI "${work}" as eli; a date goes in as_of.`
        : `Pass the work ELI "${work}" as eli.`,
    });
  }
  return readValueAs(input, work);
};
