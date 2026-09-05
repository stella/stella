/**
 * Decisions recorded twice: as the manifestation the publisher serves on
 * its own, and as the portal page embedding the same converter output
 * among the site's navigation, contact and footer blocks.
 *
 * Declared here rather than inside the recorder so the recorder and the
 * test that compares the two read one list. A pair only the recorder
 * knew would be written to disk and never compared; a pair only the test
 * knew would compare against a fixture nothing produces. The stems come
 * from here too, so neither side can spell a filename the other does not.
 *
 * Every entry must also be in the recorder's parser corpus for the same
 * language: that pass records the manifestation half of the pair.
 */

export type PortalPair = {
  celex: string;
  /** Language code as the adapter names it, upper case. */
  language: string;
};

export const PORTAL_CORPUS = [
  { celex: "62022CJ0128", language: "EN" },
] as const satisfies readonly PortalPair[];

/** Fixture stem of the manifestation half of a pair. */
export const manifestationStem = ({ celex, language }: PortalPair): string =>
  `${celex}.${language.toLowerCase()}`;

/** Fixture stem of the portal half of a pair. */
export const portalStem = (pair: PortalPair): string =>
  `${manifestationStem(pair)}.page`;

/** Suffix marking a portal recording among the fixture stems. */
export const PORTAL_STEM_SUFFIX = ".page";

/** Suffix marking a shell recording among the fixture stems. */
export const SHELL_STEM_SUFFIX = ".portal-shell";

/**
 * A page the portal serves where a decision would be.
 *
 * The Court has not published this decision in this language, and the
 * portal answers that with its own shell under a success status: cookie
 * banner, navigation, the europa.eu contact block, a footer, and none of
 * the converter's vocabulary. Every assertion the decision recordings
 * carry is false of it, so it is named here and excluded from that
 * corpus by name rather than by what it happens to lack.
 *
 * Recorded rather than written. A hand-built approximation would hold
 * only the furniture whoever wrote it thought of, and what this fixture
 * is for is the shape the publisher actually sends. It pairs with no
 * manifestation and has no Formex sibling, so it is captured with
 * `scripts/capture-parser-fixture.ts --gzip` rather than by the corpus
 * recorder.
 */
export const SHELL_STEM = `62013TO0488.ga${SHELL_STEM_SUFFIX}`;

/**
 * The container the publisher's portal wraps an embedded decision in.
 *
 * One declaration for both readers: the recorder uses it to tell a
 * served document from the challenge page the portal answers automated
 * requests with, and the test uses it to tell the two halves of a pair
 * apart. Two copies of this string could drift into agreeing about
 * nothing.
 */
export const PORTAL_DOCUMENT_CONTAINER = 'id="document1"';