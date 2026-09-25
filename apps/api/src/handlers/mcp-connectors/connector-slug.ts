/**
 * Picking a connector slug that no visible connector already uses.
 *
 * The candidates are the base slug, then `base-2` through `base-50`. They are
 * probed together in one read, and the first one no row holds wins, which is
 * the slug a probe of each candidate in turn would have landed on.
 */

const CONNECTOR_SLUG_ATTEMPTS = 50;

/** The slugs to try, in the order they are preferred. */
export const connectorSlugCandidates = (base: string): string[] =>
  Array.from({ length: CONNECTOR_SLUG_ATTEMPTS }, (_unused, attempt) =>
    attempt === 0 ? base : `${base}-${attempt + 1}`,
  );

/**
 * The first candidate not in `taken`. When every candidate is taken, a random
 * suffix stands in for a counter. It comes from the tail of a UUIDv7, which is
 * random; the head is the timestamp and repeats for calls close together.
 */
export const firstFreeConnectorSlug = ({
  base,
  candidates,
  taken,
}: {
  base: string;
  candidates: readonly string[];
  taken: ReadonlySet<string>;
}): string =>
  candidates.find((candidate) => !taken.has(candidate)) ??
  `${base}-${Bun.randomUUIDv7().slice(-12)}`;
