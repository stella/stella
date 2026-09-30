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
  caseNumber: readonly string[];
  celex: readonly string[];
  ecli: readonly string[];
  /** Corporate-body code of the court (`CJ`, `GCEU`). */
  author: readonly string[];
  /** The decision's ordinal within its Reports fascicle. */
  sequence: readonly string[];
  /** Its page coordinates in the Reports of Cases. */
  pages: Readonly<Record<string, readonly string[]>>;
};

const PAGE_TAGS = ["PAGE.FIRST.ECR", "PAGE.LAST.ECR", "PAGE.SEQ", "PAGE.TOTAL"];

type BibliographyReader = {
  /** Text of each matching direct child, in document order. */
  readonly values: (tag: string) => readonly string[];
  /** The block's own child element names, in document order. */
  readonly tags: readonly string[];
};

const readBibliography = (
  xml: string | readonly string[],
): BibliographyReader => {
  const children = (typeof xml === "string" ? [xml] : xml).flatMap(
    (document) => {
      const $ = cheerio.load(document, { xml: true });
      return $(":root")
        .children()
        .toArray()
        .filter((element) =>
          element.tagName.toUpperCase().startsWith(BIBLIOGRAPHY_PREFIX),
        )
        .flatMap((block) =>
          $(block)
            .children()
            .toArray()
            .map((element) => ({
              tag: element.tagName.toUpperCase(),
              text: $(element).text().trim(),
            })),
        );
    },
  );
  return {
    values: (tag) =>
      children
        .filter((child) => child.tag === tag)
        .map(({ text }) => text)
        .filter((text) => text.length > 0),
    tags: children.map(({ tag }) => tag),
  };
};

export const parseFormexBibliography = (
  xml: string | readonly string[],
): EcjFormexBibliography => {
  const reader = readBibliography(xml);
  const pages: Record<string, readonly string[]> = {};
  for (const tag of PAGE_TAGS) {
    const values = reader.values(tag);
    if (values.length > 0) {
      pages[tag] = values;
    }
  }
  return {
    caseNumber: reader.values("REF.CASE"),
    celex: reader.values("NO.CELEX"),
    ecli: reader.values("NO.ECLI"),
    author: reader.values("AUTHOR"),
    sequence: reader.values("NO.SEQ"),
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
export const listEcjFormexFields = (
  xml: string | readonly string[],
): readonly string[] => {
  const { tags } = readBibliography(xml);
  return tags.length === 0
    ? []
    : [...tags.map((tag) => `formex.BIB/${tag}`), FORMEX_BODY_FIELD];
};
