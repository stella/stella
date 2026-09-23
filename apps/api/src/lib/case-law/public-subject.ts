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
import { and, eq, sql } from "drizzle-orm";

import {
  DECISION_READ_RESOLUTION,
  type DecisionReadResolution,
} from "@stll/api-contract/case-law-decision-resolution";
import {
  isPublicCaseLawCountry,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
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
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import { isRedistributable } from "@/api/lib/legal-search/corpus-source";

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
  readonly [REDISTRIBUTABLE]: true;
};

type SubjectOfOptions = {
  id: SafeId<"caseLawDecision">;
  resolution: DecisionSubjectResolution;
  tx: CaseLawPublicReadTransaction;
};

const subjectOf = ({
  id,
  resolution,
  tx,
}: SubjectOfOptions): RedistributableDecisionSubject => ({
  id,
  resolution,
  tx,
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

const locatorCondition = (locator: DecisionSubjectLocator) => {
  switch (locator.kind) {
    case "id":
      return eq(caseLawDecisions.id, locator.id);
    case "slug": {
      const country = publicCaseLawCountry(locator.country);
      const language = normalizePublicDecisionLanguage(locator.language);
      if (
        country === null ||
        (locator.language !== undefined && language === null)
      ) {
        return null;
      }
      return language === null
        ? and(
            eq(caseLawDecisions.country, country),
            eq(caseLawDecisions.slug, locator.slug),
          )
        : and(
            eq(caseLawDecisions.country, country),
            eq(caseLawDecisions.slug, locator.slug),
            sql`replace(lower(${caseLawDecisions.language}), '_', '-') = ${language}`,
          );
    }
    default: {
      locator satisfies never;
      return panic(`Unhandled locator: ${String(locator)}`);
    }
  }
};

/** The row a condition names, whether or not it is published. */
const selectLocatedRow = async (
  tx: CaseLawPublicReadTransaction,
  condition: SQL | undefined,
) =>
  (
    await tx
      .select({
        id: caseLawDecisions.id,
        country: caseLawDecisions.country,
        descriptor: caseLawSources.descriptor,
        published: sql<boolean>`${publishedCaseLawDecision}`,
        absorption: decisionAbsorptionSql(caseLawDecisions.metadata),
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(condition)
      .limit(1)
  ).at(0);

type LocatedRow = NonNullable<Awaited<ReturnType<typeof selectLocatedRow>>>;

const isPublic = (row: LocatedRow): boolean => {
  if (
    !row.published ||
    !isPublicCaseLawCountry(row.country) ||
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
): Promise<RedistributableDecisionSubject | null> => {
  const condition = locatorCondition(locator);
  if (condition === null) {
    return null;
  }
  const row = await selectLocatedRow(tx, condition);
  if (row === undefined) {
    return null;
  }
  if (row.published) {
    return isPublic(row)
      ? subjectOf({
          id: row.id,
          resolution: { type: DECISION_READ_RESOLUTION.DIRECT },
          tx,
        })
      : null;
  }
  const absorption = readDecisionAbsorption(row.absorption);
  if (absorption === null) {
    return null;
  }
  const target = await selectLocatedRow(
    tx,
    eq(caseLawDecisions.id, absorption.decisionId),
  );
  if (target === undefined || !isPublic(target)) {
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
  });
};

/**
 * Gate a decision and read it in one transaction.
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
  locator: DecisionSubjectLocator,
  read: (subject: RedistributableDecisionSubject) => Promise<T>,
): Promise<T | null> =>
  await caseLawDb(
    async (tx) => {
      const subject = await resolveSubjectIn(tx, locator);
      return subject === null ? null : await read(subject);
    },
    { isolation: "repeatable-read" },
  );
