/**
 * The publication gate for public decision reads, by construction.
 *
 * A public endpoint that names a decision must answer "not found" when the
 * decision's country is outside the public list, its source may not be
 * redistributed, or the row is listing-only: its citation texts, graph counts
 * and provision references are as much its content as its full text. A
 * listing-only row is a listed identity whose detail never arrived (guide rule
 * 20); it is durable so a later observation can enrich it, and unpublished
 * until one does, here and on every aggregate surface alike.
 * The gate used to be a check each handler remembered to make, and two
 * handlers shipped without it. Here it is the only way to obtain a
 * `RedistributableDecisionSubject`, and every read handler takes one instead
 * of a bare id, so a handler that skips the gate does not typecheck.
 *
 * The subject carries the transaction that gated it, and that transaction is
 * the only database handle a gated handler receives. Resolving in one
 * transaction and reading in another would leave a window where a source
 * turned restricted in between and the content still went out under a brand
 * that says "gated"; carrying the handle closes it, because the content a
 * handler reads can only come from the state the gate approved. The gated
 * transaction is a repeatable-read snapshot, so every statement under it —
 * the gate's and the handler's — sees that one state.
 */
import { panic } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  DECISION_READ_RESOLUTION,
  type DecisionReadResolution,
} from "@stll/api-contract/case-law-decision-resolution";
import {
  PUBLIC_CASE_LAW_COUNTRIES,
  PUBLIC_CASE_LAW_PAGE_COUNTRIES,
} from "@stll/api-contract/case-law-launch-readiness";
import type { PublicCountrySurface } from "@stll/api-contract/public-country-capability";
import { publicCountriesFor } from "@stll/api-contract/public-country-capability";

import { caseLawSources, unredactedCaseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import {
  decisionAbsorptionSql,
  readDecisionAbsorption,
  supplementAnchorPrefix,
} from "@/api/lib/case-law/decision-absorption";
import { normalizePublicDecisionLanguage } from "@/api/lib/case-law/decision-language";
import { publishedCaseLawDecisionFor } from "@/api/lib/case-law/published-decisions-sql";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { isRedistributable } from "@/api/lib/legal-search/corpus-source";
import { storedObservationIsListingOnly } from "@/api/lib/legal-search/partial-observation-sql";

/** Module-private, so the subject type is constructible only below. */
const REDISTRIBUTABLE: unique symbol = Symbol("redistributableDecisionSubject");

/** How the requested address reached the subject. */
type DecisionSubjectResolution = DecisionReadResolution<
  SafeId<"caseLawDecision">
>;

/**
 * A decision the public may read: resolved and gated in one place.
 *
 * `tx` is the transaction the gate ran in. A handler reads through it and
 * receives no other handle, so its rows and the gate's verdict come from one
 * snapshot; see the module comment.
 */
export type RedistributableDecisionSubject = {
  readonly id: SafeId<"caseLawDecision">;
  readonly resolution: DecisionSubjectResolution;
  readonly tx: CaseLawPublicReadTransaction;
  /**
   * The countries the gate admitted the subject under: its surface's list.
   * Every decision a gated read reaches from the subject (citations, citing
   * decisions, leaders) is filtered against this same list, so a far end is
   * never more public than the subject's own surface allows.
   */
  readonly countries: readonly string[];
  readonly [REDISTRIBUTABLE]: true;
};

type SubjectOfOptions = {
  id: SafeId<"caseLawDecision">;
  resolution: DecisionSubjectResolution;
  tx: CaseLawPublicReadTransaction;
  countries: readonly string[];
};

const subjectOf = ({
  id,
  resolution,
  tx,
  countries,
}: SubjectOfOptions): RedistributableDecisionSubject => ({
  id,
  resolution,
  tx,
  countries,
  [REDISTRIBUTABLE]: true,
});

/** How a request names its subject. */
export type DecisionSubjectLocator =
  | { kind: "id"; id: SafeId<"caseLawDecision"> }
  | {
      kind: "slug";
      country: string;
      slug: string;
      language: string | undefined;
    };

/** The case-law country list each public surface answers to. */
export type CaseLawSurfaceCountries = Readonly<
  Record<PublicCountrySurface, readonly string[]>
>;

/**
 * Which country list a read answers to: `identity` resolves decisions and IDs,
 * `pages` serves public pages and sitemaps, and `search` serves search and listing.
 * An identity-public country is on the identity list only. The
 * gate resolves its surface here once and hands the list to every read it
 * admits; tests pass their own table (see `GateSurface`) to exercise a state
 * no country holds.
 */
export const CASE_LAW_SURFACE_COUNTRIES: CaseLawSurfaceCountries = {
  identity: publicCountriesFor("caseLaw", "identity"),
  pages: PUBLIC_CASE_LAW_PAGE_COUNTRIES,
  search: PUBLIC_CASE_LAW_COUNTRIES,
};

/**
 * The surface a gate reads for: a surface name, answered from the table
 * above, or (in tests) a surface with its own table.
 */
export type GateSurface =
  | PublicCountrySurface
  | {
      surface: PublicCountrySurface;
      surfaceCountries: CaseLawSurfaceCountries;
    };

const gateCountries = (surface: GateSurface): readonly string[] =>
  typeof surface === "string"
    ? CASE_LAW_SURFACE_COUNTRIES[surface]
    : surface.surfaceCountries[surface.surface];

const isListed = (countries: readonly string[], country: string): boolean =>
  countries.some((candidate) => candidate === country);

const locatorCondition = (
  locator: DecisionSubjectLocator,
  countries: readonly string[],
) => {
  switch (locator.kind) {
    case "id":
      return eq(unredactedCaseLawDecisions.id, locator.id);
    case "slug": {
      const country = locator.country.toUpperCase();
      const language = normalizePublicDecisionLanguage(locator.language);
      if (
        !isListed(countries, country) ||
        (locator.language !== undefined && language === null)
      ) {
        return null;
      }
      return language === null
        ? and(
            eq(unredactedCaseLawDecisions.country, country),
            eq(unredactedCaseLawDecisions.slug, locator.slug),
          )
        : and(
            eq(unredactedCaseLawDecisions.country, country),
            eq(unredactedCaseLawDecisions.slug, locator.slug),
            sql`replace(lower(${unredactedCaseLawDecisions.language}), '_', '-') = ${language}`,
          );
    }
    default: {
      locator satisfies never;
      return panic(`Unhandled locator: ${String(locator)}`);
    }
  }
};

/** The rows a condition names, whether or not they are published. */
const selectLocatedRows = (
  tx: CaseLawPublicReadTransaction,
  condition: SQL | undefined,
) =>
  tx
    .select({
      id: unredactedCaseLawDecisions.id,
      country: unredactedCaseLawDecisions.country,
      descriptor: caseLawSources.descriptor,
      published: sql<boolean>`${publishedCaseLawDecisionFor(unredactedCaseLawDecisions)}`,
      absorption: decisionAbsorptionSql(unredactedCaseLawDecisions.metadata),
    })
    .from(unredactedCaseLawDecisions)
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, unredactedCaseLawDecisions.sourceId),
    )
    .where(condition);

/** The row a condition names, whether or not it is published. */
const selectLocatedRow = async (
  tx: CaseLawPublicReadTransaction,
  condition: SQL | undefined,
) => (await selectLocatedRows(tx, condition).limit(1)).at(0);

type LocatedRow = NonNullable<Awaited<ReturnType<typeof selectLocatedRow>>>;

const isPublic = (row: LocatedRow, countries: readonly string[]): boolean => {
  if (
    !row.published ||
    !isListed(countries, row.country) ||
    !isRedistributable(row.descriptor)
  ) {
    return false;
  }
  return true;
};

/**
 * The subject a locator names within `tx`, or null when it is not public.
 * Missing and unavailable subjects deliberately have one answer.
 *
 * An absorbed supplement row resolves to the judgment it went into, one hop,
 * and only when that judgment passes the same gate: the old address keeps
 * working without exposing anything the judgment's own address would not.
 */
const resolveSubjectIn = async (
  tx: CaseLawPublicReadTransaction,
  locator: DecisionSubjectLocator,
  countries: readonly string[],
): Promise<RedistributableDecisionSubject | null> => {
  const condition = locatorCondition(locator, countries);
  if (condition === null) {
    return null;
  }
  const row = await selectLocatedRow(tx, condition);
  if (row === undefined) {
    return null;
  }
  if (row.published) {
    return isPublic(row, countries)
      ? subjectOf({
          id: row.id,
          resolution: { type: DECISION_READ_RESOLUTION.DIRECT },
          tx,
          countries,
        })
      : null;
  }
  const absorption = readDecisionAbsorption(row.absorption);
  if (absorption === null) {
    return null;
  }
  const target = await selectLocatedRow(
    tx,
    eq(unredactedCaseLawDecisions.id, absorption.decisionId),
  );
  if (target === undefined || !isPublic(target, countries)) {
    return null;
  }
  return subjectOf({
    id: target.id,
    resolution: {
      type: DECISION_READ_RESOLUTION.ABSORBED_SUPPLEMENT,
      absorbedDecisionId: row.id,
      anchorPrefix: supplementAnchorPrefix(absorption),
    },
    tx,
    countries,
  });
};

/**
 * Gate many decisions, named by id, in one statement and read them in the
 * same snapshot.
 *
 * Only a decision published under its own id passes. An absorbed
 * supplement's id resolves through its judgment, one hop at a time, which is
 * `withRedistributableSubject`'s job; a batch caller that names one gets no
 * subject for it, the same answer as a missing or restricted decision.
 */
export const withRedistributableDecisions = async <T>(
  caseLawDb: CaseLawPublicReadDb,
  surface: GateSurface,
  ids: readonly SafeId<"caseLawDecision">[],
  read: (subjects: readonly RedistributableDecisionSubject[]) => Promise<T>,
): Promise<T> => {
  const countries = gateCountries(surface);
  return await caseLawDb(
    async (tx) => {
      const rows =
        ids.length === 0
          ? []
          : await selectLocatedRows(
              tx,
              inArray(unredactedCaseLawDecisions.id, [...ids]),
            );
      return await read(
        rows
          .filter((row) => row.published && isPublic(row, countries))
          .map((row) =>
            subjectOf({
              id: row.id,
              resolution: { type: DECISION_READ_RESOLUTION.DIRECT },
              tx,
              countries,
            }),
          ),
      );
    },
    { isolation: "repeatable-read" },
  );
};

/**
 * Gate a decision and read it in one transaction, on the named surface.
 *
 * `read` runs with the subject inside the transaction that approved it, so
 * every row it returns belongs to the snapshot the gate judged. Returns null
 * when the decision does not exist or its source may not be redistributed;
 * every caller turns that into the same "not found" its surface uses.
 *
 * Work that must not hold a database transaction — fetching a document from
 * the publisher, writing through the ingestion path — belongs after this
 * resolves, never inside `read`.
 */
export const withRedistributableSubject = async <T>(
  caseLawDb: CaseLawPublicReadDb,
  surface: GateSurface,
  locator: DecisionSubjectLocator,
  read: (subject: RedistributableDecisionSubject) => Promise<T>,
): Promise<T | null> =>
  await caseLawDb(
    async (tx) => {
      const subject = await resolveSubjectIn(
        tx,
        locator,
        gateCountries(surface),
      );
      return subject === null ? null : await read(subject);
    },
    { isolation: "repeatable-read" },
  );

/** Pending-text aggregates expose counts without publishing listing-only rows. */
export const readPendingTextCountsBySource = async (
  tx: CaseLawPublicReadTransaction,
  sourceIds: readonly SafeId<"caseLawSource">[],
) => {
  if (sourceIds.length === 0) {
    return [];
  }
  return await tx
    .select({
      sourceId: caseLawSources.id,
      pendingTextCount: sql<number>`count(${unredactedCaseLawDecisions.id})::integer`,
    })
    .from(caseLawSources)
    .leftJoin(
      unredactedCaseLawDecisions,
      and(
        eq(unredactedCaseLawDecisions.sourceId, caseLawSources.id),
        isNull(unredactedCaseLawDecisions.fulltext),
        storedObservationIsListingOnly(unredactedCaseLawDecisions.metadata),
      ),
    )
    .where(
      and(inArray(caseLawSources.id, sourceIds), redistributableCaseLawSource),
    )
    .groupBy(caseLawSources.id);
};
