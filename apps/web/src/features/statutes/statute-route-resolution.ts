import type { LegislationInconsistentVersion } from "@stll/api-contract/legislation-expression";
import {
  extractStatuteDocumentIdFromRouteParam,
  normalizeStatuteVersionSegment,
  type StatuteRouteParams,
  toStatuteCountrySegment,
} from "@stll/api-contract/statute-route";

import type { StatuteSlugKey } from "@/features/statutes/queries/statutes";
import { isStatuteWindowGap } from "@/features/statutes/statute-expression";
import type { StatuteWindowGap } from "@/features/statutes/statute-expression";
import { isPublicStatuteCountry } from "@/lib/statutes/statute-route";

/** The corpus reads an address resolves through: by document id, and by slug. */
export type StatuteRouteReads<Statute> = {
  byId: (documentId: string) => Promise<Statute | null>;
  bySlug: (key: StatuteSlugKey) => Promise<Statute | StatuteWindowGap | null>;
};

/** A statute address, and the `?asOf` lookup the page also answers. */
export type StatuteRouteRequest = StatuteRouteParams & {
  asOf: string | undefined;
};

/**
 * What a statute address names. `found` carries the consolidation to show,
 * null when nothing of the Work was in force on the requested day, and the
 * Work's member that answers for its chrome either way. `window-gap` is a
 * day the publisher's own inconsistent dates leave without an in-force
 * reading, with the versions responsible.
 */
export type StatuteRouteResolution<Statute> =
  | { type: "unserved" }
  | { type: "missing" }
  | { type: "found"; statute: Statute | null; work: Statute }
  | {
      type: "window-gap";
      /** The day asked about, which only the act's page read on it explains. */
      asOf: string;
      versions: readonly LegislationInconsistentVersion[];
      work: Statute;
    };

/**
 * The one reading of a statute address, shared by the act's page and every
 * link that opens the act elsewhere.
 *
 * A jurisdiction the public corpus does not serve is `unserved`. The id form
 * names one consolidation directly, so a date cannot narrow it. A slug is
 * read on the requested day (the `/v/` opening, else `?asOf`); when nothing
 * was in force then, the Work is read without one, so the reader still lands
 * on the act.
 */
export const resolveStatuteRoute = async <Statute>(
  { asOf: requestedAsOf, country, slug, version }: StatuteRouteRequest,
  reads: StatuteRouteReads<Statute>,
): Promise<StatuteRouteResolution<Statute>> => {
  const countrySegment = toStatuteCountrySegment(country);
  if (!isPublicStatuteCountry(countrySegment)) {
    return { type: "unserved" };
  }

  // The id form addresses one consolidation of a Work the corpus holds no
  // slug for. It names that text directly, so a date cannot narrow it.
  const documentId = extractStatuteDocumentIdFromRouteParam(slug);
  if (documentId !== null) {
    const addressed = await reads.byId(documentId);
    return addressed === null
      ? { type: "missing" }
      : { type: "found", statute: addressed, work: addressed };
  }

  const asOf = normalizeStatuteVersionSegment(version) ?? requestedAsOf;
  const addressed = await reads.bySlug(
    asOf === undefined
      ? { country: countrySegment, slug }
      : { asOf, country: countrySegment, slug },
  );
  let windowGap: readonly LegislationInconsistentVersion[] | null = null;
  if (isStatuteWindowGap(addressed)) {
    windowGap = addressed.windowGap;
  } else if (addressed !== null) {
    return { type: "found", statute: addressed, work: addressed };
  }

  if (asOf === undefined) {
    return { type: "missing" };
  }

  // Nothing was in force on the requested day; the Work still has chrome to
  // answer with, so it is read without one.
  const work = await reads.bySlug({ country: countrySegment, slug });
  if (work === null || isStatuteWindowGap(work)) {
    return { type: "missing" };
  }
  return windowGap === null
    ? { type: "found", statute: null, work }
    : { type: "window-gap", asOf, versions: windowGap, work };
};
