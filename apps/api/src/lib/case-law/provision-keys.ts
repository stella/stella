/**
 * The provision keys a case-law index carries and a provision search asks for.
 *
 * One function family serves the writer (the projection of a decision's
 * recorded provision links) and the reader (a provision filter), so the two
 * can only disagree if this file does.
 *
 * A key is `<work identifier>|<anchor prefix>`. A link to
 * `262/2006 Sb.` at `par_316-odst_2-pism_a` contributes one key per anchor
 * prefix, cut on the anchor's own separator:
 *
 *   262/2006 Sb.|par_316
 *   262/2006 Sb.|par_316-odst_2
 *   262/2006 Sb.|par_316-odst_2-pism_a
 *
 * A decision that cites `§ 316 odst. 2 písm. a` therefore answers a filter at
 * any of the three depths with one exact term, and a filter at `§ 31` cannot
 * reach `§ 316`: the match is on a whole key, never on a string prefix.
 *
 * The anchor scheme is the Czech profile's (`par_`, `cl_`, `odst_`, `pism_`,
 * `bod_`, joined by `-`), which is what the provision links store.
 */

import { CZ_PROFILE } from "@stll/legal-atlas/cz-provision-citation-profile";
import type { SectionUnit } from "@stll/legal-atlas/provision-citation-profile";

/** Between the work identifier and the anchor prefix. */
const PROVISION_KEY_SEPARATOR = "|";

/** Between the levels of a stored anchor. */
const ANCHOR_SEPARATOR = CZ_PROFILE.anchor.join;

/**
 * The most bytes the `provision_keys` array of one passage may take as the
 * projection sends it (JSON-encoded, inside the NDJSON line).
 *
 * The keys ride on every passage of the decision, so this is a per-passage
 * request budget, and it is far below the single-document ceiling a request is
 * split against (`provision-keys.test.ts` states the ratio against
 * `CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES`). Real work identifiers
 * and anchors take about a tenth of it.
 */
export const PROVISION_KEYS_MAX_SERIALIZED_BYTES = 64 * 1024;

/**
 * The most bytes one key may take JSON-encoded, quotes and escapes included; a
 * longer one is never written. Measured on the encoding, not on the text, so
 * an escaped character cannot take a key past what the budget assumes.
 */
export const PROVISION_KEY_MAX_BYTES = 255;

/**
 * Most keys one decision writes on each passage, derived so the worst case
 * provably fits the budget: an array of `n` keys of the longest admitted size
 * is `1 + n * (PROVISION_KEY_MAX_BYTES + 1)` bytes (brackets, quotes inside
 * the key size, one comma per key), so the cap is the largest `n` for which
 * that stays within `PROVISION_KEYS_MAX_SERIALIZED_BYTES`.
 */
export const PROVISION_KEYS_MAX_COUNT = Math.floor(
  (PROVISION_KEYS_MAX_SERIALIZED_BYTES - 1) / (PROVISION_KEY_MAX_BYTES + 1),
);

/**
 * Most link rows read for one decision. Past it the decision's links are
 * treated as capped exactly as a key set past `PROVISION_KEYS_MAX_COUNT` is.
 */
export const PROVISION_LINK_READ_MAX_ROWS = 2048;

/** What the stored provision links of one decision contribute. */
export type ProvisionKeyLink = {
  workIdentifier: string;
  anchor: string;
};

/**
 * The keys a decision writes, and what the bound left out.
 *
 * `dropped` is zero for a decision inside the bounds. Anything else is a typed
 * condition the caller logs: the keys are the shallowest ones first (a
 * section answers the broadest filter), so a capped decision still answers
 * `§ 316` and loses depth, and the loss is counted rather than hidden.
 */
export type ProvisionKeySet = {
  keys: readonly string[];
  dropped: number;
};

export const provisionKey = (
  workIdentifier: string,
  anchorPrefix: string,
): string => `${workIdentifier}${PROVISION_KEY_SEPARATOR}${anchorPrefix}`;

/** The bytes of a key as the projection sends it: JSON-encoded. */
const encodedByteLength = (value: string): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

/** Every anchor prefix of an anchor, shallowest first. Empty for no anchor. */
const anchorPrefixes = (anchor: string): string[] => {
  const segments = anchor.split(ANCHOR_SEPARATOR);
  if (segments.some((segment) => segment === "")) {
    return [];
  }
  return segments.map((_segment, index) =>
    segments.slice(0, index + 1).join(ANCHOR_SEPARATOR),
  );
};

type DepthKey = { key: string; depth: number };

/**
 * The distinct, sorted keys of a decision's provision links, bounded.
 *
 * Distinct and sorted so the same links give the same keys in any order, which
 * is what a fingerprint needs. An over-long key is dropped and counted. When
 * more than `PROVISION_KEYS_MAX_COUNT` remain, the shallowest keys are kept
 * (ties by text) and the rest are counted in `dropped`.
 */
export const provisionKeysOfLinks = (
  links: readonly ProvisionKeyLink[],
  maxCount: number = PROVISION_KEYS_MAX_COUNT,
): ProvisionKeySet => {
  const byKey = new Map<string, DepthKey>();
  let overlong = 0;
  for (const { workIdentifier, anchor } of links) {
    for (const [index, prefix] of anchorPrefixes(anchor).entries()) {
      const key = provisionKey(workIdentifier, prefix);
      if (byKey.has(key)) {
        continue;
      }
      if (encodedByteLength(key) > PROVISION_KEY_MAX_BYTES) {
        overlong += 1;
        continue;
      }
      byKey.set(key, { key, depth: index });
    }
  }
  const distinct = [...byKey.values()];
  const kept =
    distinct.length <= maxCount
      ? distinct
      : distinct
          .toSorted(
            (left, right) =>
              left.depth - right.depth || compareText(left.key, right.key),
          )
          .slice(0, maxCount);
  return {
    keys: kept.map(({ key }) => key).toSorted(compareText),
    dropped: overlong + (distinct.length - kept.length),
  };
};

/** The provision a filter names, as the search side states it. */
export type ProvisionKeyFilter = {
  work: string;
  unit: SectionUnit;
  section: number;
  sectionSuffix?: string | undefined;
  subsection?: string | undefined;
  letter?: string | undefined;
  point?: string | undefined;
};

/** Lowercase, no leading zeros: the form anchors store designators in. */
const canonicalDesignator = (value: string): string =>
  value.toLowerCase().replace(/^0+(?=\d)/u, "");

/**
 * The one key a filter queries by: the work and the anchor of the deepest
 * level the filter names. A level the filter leaves out is left out of the
 * anchor, as an anchor leaves out a level its link did not cite, so a filter
 * on a letter without a subsection asks for the anchor such a link stores.
 *
 * The section suffix is part of the section's designator (`316a`), and the
 * article unit renders with `cl_` where a section renders with `par_`.
 */
export const provisionFilterKey = (filter: ProvisionKeyFilter): string => {
  const { render } = CZ_PROFILE.anchor;
  const section = `${String(filter.section)}${filter.sectionSuffix ?? ""}`;
  const segments = [
    render[filter.unit](canonicalDesignator(section)),
    ...(filter.subsection === undefined
      ? []
      : [render.subsection(canonicalDesignator(filter.subsection))]),
    ...(filter.letter === undefined
      ? []
      : [render.letter(canonicalDesignator(filter.letter))]),
    ...(filter.point === undefined
      ? []
      : [render.point(canonicalDesignator(filter.point))]),
  ];
  return provisionKey(filter.work, segments.join(ANCHOR_SEPARATOR));
};
