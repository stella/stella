/**
 * Read the bibliographic block of the Publications Office's Formex encoding
 * of a CJEU decision.
 *
 * Separate from `eu-ecj-formex.ts`, which reads the same files as a test
 * oracle for the XHTML parse and is deliberately kept out of the ingestion
 * path. This reads the block the decision is *catalogued* by, which a stored
 * row keeps, and it touches none of the document's own structure.
 *
 * Two facts here are stated nowhere else in a language-independent form: the
 * docket as the publisher spells it, and the court that gave the decision.
 * The branch notice renders both into the language it was negotiated for, and
 * one work answers twenty-four notices.
 *
 * The block is named after the document kind (`BIB.JUDGMENT`, `BIB.OPINION`,
 * `BIB.ORDER`), so it is found by its prefix rather than by a list of kinds a
 * new one would silently fall out of.
 */

import * as cheerio from "cheerio";

const BIBLIOGRAPHY_PREFIX = "BIB.";

export type EcjFormexBibliography = {
  /** The docket as the publisher spells it, e.g. `C-128/22`. */
  caseNumber: string | undefined;
  celex: string | undefined;
  ecli: string | undefined;
  /** Corporate-body code of the court (`CJ`, `GCEU`). */
  author: string | undefined;
  /** The decision's ordinal within its Reports fascicle. */
  sequence: string | undefined;
  /** Its page coordinates in the Reports of Cases. */
  pages: Readonly<Record<string, string>>;
};

const PAGE_TAGS = ["PAGE.FIRST.ECR", "PAGE.LAST.ECR", "PAGE.SEQ", "PAGE.TOTAL"];

type BibliographyReader = {
  /** Text of a direct child of the bibliographic block, if it states one. */
  readonly value: (tag: string) => string | undefined;
  /** The block's own child element names, in document order. */
  readonly tags: readonly string[];
};

const readBibliography = (xml: string): BibliographyReader => {
  const $ = cheerio.load(xml, { xml: true });
  const children = $(":root")
    .children()
    .toArray()
    .filter((element) =>
      element.tagName.toUpperCase().startsWith(BIBLIOGRAPHY_PREFIX),
    )
    .flatMap((block) => $(block).children().toArray());
  return {
    value: (tag) => {
      const element = children.find(
        (candidate) => candidate.tagName.toUpperCase() === tag,
      );
      const text = element === undefined ? "" : $(element).text().trim();
      return text.length > 0 ? text : undefined;
    },
    tags: children.map((element) => element.tagName.toUpperCase()),
  };
};

export const parseFormexBibliography = (xml: string): EcjFormexBibliography => {
  const reader = readBibliography(xml);
  const pages: Record<string, string> = {};
  for (const tag of PAGE_TAGS) {
    const value = reader.value(tag);
    if (value !== undefined) {
      pages[tag] = value;
    }
  }
  return {
    caseNumber: reader.value("REF.CASE"),
    celex: reader.value("NO.CELEX"),
    ecli: reader.value("NO.ECLI"),
    author: reader.value("AUTHOR"),
    sequence: reader.value("NO.SEQ"),
    pages,
  };
};

/**
 * The decision's own text, named as one field rather than walked.
 *
 * It is the same document the XHTML part carries, and enumerating its markup
 * would inventory a typesetting vocabulary instead of the publisher's record
 * of the decision.
 */
const FORMEX_BODY_FIELD = "formex.body";

/** Every field name the stored Formex part states. */
export const listEcjFormexFields = (xml: string): readonly string[] => {
  const { tags } = readBibliography(xml);
  return tags.length === 0
    ? []
    : [...tags.map((tag) => `formex.BIB/${tag}`), FORMEX_BODY_FIELD];
};
