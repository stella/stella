import { slugify, stripDiacriticsForSlug } from "@stll/text-normalize";

import { STATUTE_SLUG_SQL_PATTERN } from "@/api/db/schema";

export const STATUTE_SLUG_MAX_LENGTH = 256;

// The column CHECK's own pattern, so a segment the resolver accepts and a
// segment the column accepts cannot drift apart.
const STATUTE_SLUG_REGEX = new RegExp(STATUTE_SLUG_SQL_PATTERN, "u");

/**
 * ELIs end in `/<collection>/<year>/<number>` (`/eli/cz/sb/2012/89`), the
 * same tail the act-number lookup matches on (see `list.ts`). That triple is
 * the citation a lawyer reads the act by, and it identifies the Work within
 * a jurisdiction, so it leads the slug and makes it unique per country
 * without consulting the slug namespace.
 */
const ELI_CITATION_REGEX = /\/([a-z0-9]{1,32})\/(\d{4})\/(\d{1,6})$/u;

/**
 * The name part of an official title. Czech titles open with the citation
 * (`89/2012 Sb., občanský zákoník`), Slovak titles carry the name alone.
 * The SQL twin is `legislationTitleName` in the schema; both drop the same
 * prefix so a slug and a title search agree on what the act is called.
 */
const TITLE_CITATION_PREFIX_REGEX = /^[0-9]+\/[0-9]{4} [^,]*, /u;

type CreateStatuteSlugOptions = {
  eli: string;
  title: string;
};

const slugifyStatuteSegment = (value: string, maxLength: number): string =>
  slugify(stripDiacriticsForSlug(value), {
    charset: "ascii",
    separator: "-",
    maxLength,
    fallback: "",
  });

/**
 * The public slug of a statute Work: its citation, then its short name
 * (`89-2012-sb-obcansky-zakonik`).
 *
 * Null when the ELI carries no citation tail. Such a document keeps a null
 * slug and stays reachable by id, exactly as a case-law decision without a
 * slug does; minting a name-only slug would put an act in the global
 * namespace under a segment the resolver cannot make unique.
 *
 * Pure in its inputs and stable across consolidations: every Expression of a
 * Work shares the ELI and, in practice, the title, so all of them derive the
 * same slug and the version routes hang off one segment.
 */
export const createStatuteSlug = ({
  eli,
  title,
}: CreateStatuteSlugOptions): string | null => {
  const match = ELI_CITATION_REGEX.exec(eli.trim().toLowerCase());
  const collection = match?.[1];
  const year = match?.[2];
  const number = match?.[3];
  if (collection === undefined || year === undefined || number === undefined) {
    return null;
  }

  const citation = `${number}-${year}-${collection}`;
  const name = slugifyStatuteSegment(
    title.replace(TITLE_CITATION_PREFIX_REGEX, ""),
    // Leave room for the citation and the joining hyphen, so the citation
    // prefix is never the part that gets clipped.
    STATUTE_SLUG_MAX_LENGTH - citation.length - 1,
  );

  return name === "" ? citation : `${citation}-${name}`;
};

/** Whether a route param is a slug this corpus could have minted. */
export const isStatuteSlug = (value: string): boolean =>
  value.length <= STATUTE_SLUG_MAX_LENGTH && STATUTE_SLUG_REGEX.test(value);
