/**
 * Resolving a published case reference to the decisions that answer to it.
 *
 * A docket, an ECLI or a reporter citation is an identity, not a query. The
 * text index ranks: it answers a docket with every decision that mentions it,
 * in an order that has nothing to do with which one *is* that docket, and a
 * bounded page of that order can leave the decision itself out. So this reads the identity columns
 * the citator resolves by and never the ranking, which also makes it
 * independent of which search provider a deployment runs: the columns are
 * there either way.
 *
 * Identity spans two tables. `case_law_decisions` holds the primary docket and
 * the ECLI; the parallel references a publisher supplies (a second docket, a
 * reporter citation) are stored only as `case_law_decision_identifiers` rows.
 * Both are read, so a reference that names a decision by either one resolves.
 *
 * `searchDecisionsHandler` has an identity branch too, reading the same id set
 * (`decisionIdsNamedBy`), but only inside the corpus-index provider and only
 * as a first attempt before it falls through to the text index. A lookup
 * cannot fall through, so it reads here.
 *
 * Both public gates apply, in one statement with the read: a decision whose
 * country is outside the public list, whose source may not be redistributed,
 * or which is listing-only, does not exist for this caller either.
 */

import { panic } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

import {
  decisionDocketTailSpellings,
  docketFamilyKeyOf,
  type DecisionDocketSelector,
} from "@stll/api-contract/decision-docket-reference";
import type { DecisionIdentifierIntent } from "@stll/api-contract/decision-query-intent";
import {
  DECISION_IDENTIFIER_TYPES,
  type DecisionIdentifierType,
  type DecisionPrimaryReferenceType,
} from "@stll/legal-ast/decision-identifier";

import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import {
  bareCitationKey,
  normalizeDecisionIdentifierValueIn,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import {
  courtPresentation,
  readCourtRegistry,
} from "@/api/lib/case-law/court-presentation";
import { readPublicDecisionLanguageAlternatesInTx } from "@/api/lib/case-law/language-alternates";
import type { PublicDecisionLanguageAlternate } from "@/api/lib/case-law/language-alternates";
import { loadPublicCourtWeightsWithin } from "@/api/lib/case-law/public-case-law-config";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution-sql";
import { LIMITS } from "@/api/lib/limits";

/**
 * What a lookup names its subject by: a docket, an ECLI, a reporter citation,
 * or a neutral citation. The kind is the caller's; a neutral citation arrives
 * only typed as one, since no free-text grammar claims it.
 *
 * A docket is read by its case file (`family`): the read returns every
 * decision filed under it, and the `selector` the reference printed is what
 * the caller's resolution narrows them by. The file is never narrowed here,
 * because a stored row does not always carry what tells siblings apart.
 */
export type DecisionIdentityLocator =
  | {
      kind: "docket";
      value: string;
      family: string;
      selector: DecisionDocketSelector;
    }
  | { kind: "ecli"; value: string }
  | { kind: "reporter"; value: string }
  | { kind: "neutral"; value: string };

/** The locator an entry's identifier is read by. */
export const decisionIdentityLocatorOf = (
  identifier: DecisionIdentifierIntent,
): DecisionIdentityLocator => {
  switch (identifier.kind) {
    case "docket":
      return {
        kind: identifier.kind,
        value: identifier.value,
        family: identifier.family,
        selector: identifier.selector,
      };
    case "ecli":
    case "neutral":
    case "reporter":
      return { kind: identifier.kind, value: identifier.value };
    default: {
      identifier satisfies never;
      return panic(`Unhandled decision identifier: ${String(identifier)}`);
    }
  }
};

/**
 * Every spelling a member of the docket's file can be stored under: the
 * docket itself, the docket with a part numeral or a stray separator a
 * publisher left on it (stored where its document carries no key of its own),
 * and, when the reference printed a sheet, the full file number a legacy row
 * or a parallel identifier still holds. Each is keyed as the stored column is.
 */
const docketSpellingsOf = ({
  family,
  selector,
}: Pick<
  Extract<DecisionIdentityLocator, { kind: "docket" }>,
  "family" | "selector"
>): string[] => [
  family,
  ...decisionDocketTailSpellings(family),
  // Tight and spaced, as legacy rows and parallel identifiers print it; the
  // stored key is whatever the ingest key function makes of each.
  ...(selector.kind === "sheet"
    ? [`${family}-${selector.value}`, `${family} - ${selector.value}`]
    : []),
];

/**
 * The `citation_key` values a docket's file is read under: each stored
 * spelling of a member, keyed by the function that writes the column.
 */
export const docketFamilyCitationKeys = (
  locator: Pick<
    Extract<DecisionIdentityLocator, { kind: "docket" }>,
    "family" | "selector"
  >,
): string[] => [
  ...new Set(
    docketSpellingsOf(locator)
      .map((spelling) => bareCitationKey(spelling))
      .filter((key) => key.length > 0),
  ),
];

/** The identifier rows each kind of reference is stored under. */
const IDENTIFIER_TYPE_OF_LOCATOR_KIND = {
  docket: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  ecli: DECISION_IDENTIFIER_TYPES.ECLI,
  neutral: DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
  reporter: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
} as const satisfies Record<
  DecisionIdentityLocator["kind"],
  DecisionIdentifierType
>;

/**
 * One decision as a lookup answers it: enough to cite it and to fetch it.
 * `identifiers` carries the parallel references the publisher supplied (a
 * second docket, a reporter citation), so a caller's exact-match check can see
 * every name the decision answers to and not only its primary one.
 */
export type DecisionIdentityRow = {
  caseNumber: string;
  /** What kind of reference `caseNumber` is. */
  caseNumberType: DecisionPrimaryReferenceType;
  country: string;
  court: string;
  courtAbbreviation: string | null;
  decisionDate: string | null;
  ecli: string | null;
  id: SafeId<"caseLawDecision">;
  identifiers: readonly { type: DecisionIdentifierType; value: string }[];
  /** The reference as the court published it, sheet included, if recorded. */
  publishedCaseNumber?: string | null;
  /** The sheet the court published the decision on, if recorded. */
  sheetNumber?: string | null;
  language: string;
  /** Every language version, which decides whether its route names one. */
  languageAlternates: readonly PublicDecisionLanguageAlternate[];
  slug: string | null;
};

type LookupDecisionsByIdentityOptions = {
  caseLawDb: CaseLawPublicReadDb;
  country: string;
  locator: DecisionIdentityLocator;
};

/**
 * Candidates read before the caller's exact-identity filter. Every predicate
 * below is key equality, but the caller compares by its own canonical key and
 * drops what merely collides under this normalization, so the listed-candidate
 * cap belongs after that filter; this read is bounded by the wider page size
 * the search handler's identity branch already reads by.
 */
const IDENTITY_CANDIDATE_SCAN_MAX = LIMITS.caseLawSearchPageSizeMax;

type IdentifierRowMatchOptions = {
  /** Whose key the column holds: the jurisdiction the reference is read in. */
  jurisdiction: string | undefined;
  tx: CaseLawPublicReadTransaction;
  type: DecisionIdentifierType;
  /** As the reference spells them; normalized here for the column. */
  values: readonly string[];
};

/**
 * The decision ids a publisher-supplied identifier row points at, normalized
 * by the function ingestion writes that column with. A set, not a correlated
 * `EXISTS`: joined to the decision's own column by `OR`, a correlated
 * subquery leaves the planner no index to drive and the read walks the
 * whole table.
 */
const identifierRowDecisionIds = ({
  jurisdiction,
  tx,
  type,
  values,
}: IdentifierRowMatchOptions) => {
  const keys = [
    ...new Set(
      values.map((value) =>
        normalizeDecisionIdentifierValueIn(jurisdiction, type, value),
      ),
    ),
  ];
  const [onlyKey] = keys;
  return tx
    .select({ id: caseLawDecisionIdentifiers.decisionId })
    .from(caseLawDecisionIdentifiers)
    .where(
      and(
        eq(caseLawDecisionIdentifiers.type, type),
        keys.length === 1 && onlyKey !== undefined
          ? eq(caseLawDecisionIdentifiers.normalizedValue, onlyKey)
          : inArray(caseLawDecisionIdentifiers.normalizedValue, keys),
      ),
    );
};

/**
 * The decision's own column a kind of reference is also held in, or null for
 * a kind held only in the identifier rows. ECLIs are published in one case but
 * cited in another, and the column stores the published spelling. The
 * docket's identity is its citation key, which `bareCitationKey` already
 * normalizes: the same function that writes the column.
 */
const ownColumnCondition = (locator: DecisionIdentityLocator) => {
  switch (locator.kind) {
    case "docket":
      return inArray(
        caseLawDecisions.citationKey,
        docketFamilyCitationKeys(locator),
      );
    case "ecli":
      return inArray(caseLawDecisions.ecli, [
        locator.value,
        locator.value.toUpperCase(),
      ]);
    case "neutral":
    case "reporter":
      return null;
    default: {
      locator satisfies never;
      return panic(`Unhandled decision locator: ${String(locator)}`);
    }
  }
};

/**
 * Whether this connection may read the case-file key. The column's grant
 * lands a release after the column itself, so a reader that does not hold it
 * yet still serves, reading the file by its spellings alone. Checked on this
 * transaction, so the grant takes effect without a restart.
 */
const canReadDocketFamilyKey = async (
  tx: CaseLawPublicReadTransaction,
): Promise<boolean> => {
  const [permission] = await tx
    .select({
      available: sql<boolean>`has_column_privilege(current_user, 'public.case_law_decisions', 'docket_family_key', 'SELECT')`,
    })
    .from(sql`(SELECT 1) AS reader_permission_probe`);
  return (permission ?? panic("Reader privilege query returned no result"))
    .available;
};

/**
 * The case-file key a reference reads its file by, or null when it reads none.
 *
 * Only a bare docket: a sheet or part names one decision, which its stored
 * spellings reach directly, while the whole file can outgrow the candidates a
 * read keeps and push the named decision out before the selector is applied.
 */
export const docketFamilyKeyToRead = async ({
  country,
  locator,
  tx,
}: {
  country: string | undefined;
  locator: DecisionIdentityLocator;
  tx: CaseLawPublicReadTransaction;
}): Promise<string | null> => {
  if (
    locator.kind !== "docket" ||
    locator.selector.kind !== "none" ||
    country === undefined
  ) {
    return null;
  }
  const familyKey = docketFamilyKeyOf(locator.family, country);
  return familyKey !== null && (await canReadDocketFamilyKey(tx))
    ? familyKey
    : null;
};

/**
 * The ids of the decisions a reference names: the identifier rows of the
 * reference's type, unioned with the decision's own column where the kind has
 * one, so the outer read is a membership test that the primary key answers;
 * each side of the union has its own index. Shared by the lookup and the
 * search handler's identity branch, so the two cannot disagree about which
 * decisions a reference names. The country only normalizes the reference;
 * both callers scope the outer read to it, so the own-column sides stay on
 * their identity indexes alone.
 *
 * `familyKey` (from `docketFamilyKeyToRead`) adds the docket's case file by
 * its stored key: the members stored with a sheet or part after their
 * docket, which no spelling reaches. The spellings stay for rows not keyed
 * yet.
 */
export const decisionIdsNamedBy = ({
  country,
  familyKey,
  locator,
  tx,
}: {
  country: string | undefined;
  familyKey: string | null;
  locator: DecisionIdentityLocator;
  tx: CaseLawPublicReadTransaction;
}) => {
  const published = identifierRowDecisionIds({
    jurisdiction: country,
    tx,
    type: IDENTIFIER_TYPE_OF_LOCATOR_KIND[locator.kind],
    values:
      locator.kind === "docket" ? docketSpellingsOf(locator) : [locator.value],
  });
  const ownCondition = ownColumnCondition(locator);
  if (ownCondition === null) {
    return published;
  }
  const own = tx
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(ownCondition);
  if (familyKey === null) {
    return unionAll(own, published);
  }
  const family = tx
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.docketFamilyKey, familyKey));
  return unionAll(own, published, family);
};

/**
 * The parallel references of exactly the decisions named, keyed by id; a
 * decision with none maps to an empty list.
 */
const readIdentifiersByDecision = async (
  tx: CaseLawPublicReadTransaction,
  decisionIds: readonly SafeId<"caseLawDecision">[],
): Promise<Map<string, { type: DecisionIdentifierType; value: string }[]>> => {
  const identifiersByDecision = new Map<
    string,
    { type: DecisionIdentifierType; value: string }[]
  >(decisionIds.map((id) => [String(id), []]));
  if (decisionIds.length === 0) {
    return identifiersByDecision;
  }
  const identifierRows = await tx
    .select({
      decisionId: caseLawDecisionIdentifiers.decisionId,
      type: caseLawDecisionIdentifiers.type,
      value: caseLawDecisionIdentifiers.value,
    })
    .from(caseLawDecisionIdentifiers)
    .where(inArray(caseLawDecisionIdentifiers.decisionId, [...decisionIds]));
  for (const row of identifierRows) {
    // Keyed off the decisions named, so a row for anything else is a join
    // this statement cannot produce.
    const values =
      identifiersByDecision.get(String(row.decisionId)) ??
      panic("Read an identifier for a decision this lookup did not name");
    values.push({ type: row.type, value: row.value });
  }
  return identifiersByDecision;
};

/**
 * The sheet a decision sits on, as the source's adapter recorded it when it
 * split the court's published reference (`3 Afs 41/2008 - 98`) into the
 * docket and the sheet. Read from the row's metadata, which the public reader
 * holds, so a sibling with no ECLI and no parallel file number is still told
 * apart by its sheet. Absent for a source that publishes none.
 */
const publishedSheetColumns = {
  publishedCaseNumber: sql<
    string | null
  >`${caseLawDecisions.metadata} ->> 'publishedCaseNumber'`,
  sheetNumber: sql<
    string | null
  >`${caseLawDecisions.metadata} ->> 'sheetNumber'`,
};

/** What a decision answers to, enough to resolve a reference among several. */
export type DecisionIdentityHit = {
  caseNumber: string;
  ecli: string | null;
  id: SafeId<"caseLawDecision">;
  identifiers: readonly { type: DecisionIdentifierType; value: string }[];
  publishedCaseNumber: string | null;
  sheetNumber: string | null;
};

/**
 * The identity columns of decisions an identity read already named, by
 * primary key: the docket, the ECLI, the published reference and sheet, and
 * the parallel references, which are what tell a file's siblings apart. In
 * the read's own order.
 */
export const readDecisionIdentityHits = async (
  tx: CaseLawPublicReadTransaction,
  decisionIds: readonly SafeId<"caseLawDecision">[],
): Promise<DecisionIdentityHit[]> => {
  if (decisionIds.length === 0) {
    return [];
  }
  const rows = await tx
    .select({
      caseNumber: caseLawDecisions.caseNumber,
      ecli: caseLawDecisions.ecli,
      id: caseLawDecisions.id,
      ...publishedSheetColumns,
    })
    .from(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, [...decisionIds]));
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const identifiersByDecision = await readIdentifiersByDecision(
    tx,
    decisionIds,
  );
  return decisionIds.flatMap((id) => {
    const row = byId.get(String(id));
    return row === undefined
      ? []
      : [
          {
            ...row,
            identifiers:
              identifiersByDecision.get(String(id)) ??
              panic("Lost a decision's identifier list"),
          },
        ];
  });
};

export const lookupDecisionsByIdentity = async ({
  caseLawDb,
  country,
  locator,
}: LookupDecisionsByIdentityOptions): Promise<DecisionIdentityRow[]> => {
  const rows = await caseLawDb(async (tx) => {
    const familyKey = await docketFamilyKeyToRead({ country, locator, tx });
    const decisions = await tx
      .select({
        caseNumber: caseLawDecisions.caseNumber,
        caseNumberType: caseLawDecisions.caseNumberType,
        country: caseLawDecisions.country,
        court: caseLawDecisions.court,
        courtId: caseLawDecisions.courtId,
        decisionDate: caseLawDecisions.decisionDate,
        ecli: caseLawDecisions.ecli,
        id: caseLawDecisions.id,
        language: caseLawDecisions.language,
        languageGroupKey: caseLawDecisions.languageGroupKey,
        ...publishedSheetColumns,
        slug: caseLawDecisions.slug,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(
        and(
          inArray(
            caseLawDecisions.id,
            decisionIdsNamedBy({ country, familyKey, locator, tx }),
          ),
          eq(caseLawDecisions.country, country),
          publishedCaseLawDecision,
          redistributableCaseLawSourceFor(caseLawSources.descriptor),
        ),
      )
      // Court, then date, then id: the candidates a caller has to choose
      // between come back in the same order twice, and in the order the choice
      // is actually made in.
      .orderBy(
        caseLawDecisions.court,
        caseLawDecisions.decisionDate,
        caseLawDecisions.id,
      )
      .limit(IDENTITY_CANDIDATE_SCAN_MAX);

    if (decisions.length === 0) {
      return [];
    }

    const identifiersByDecision = await readIdentifiersByDecision(
      tx,
      decisions.map((decision) => decision.id),
    );

    const alternates = await readPublicDecisionLanguageAlternatesInTx(
      tx,
      decisions.map((decision) => decision.languageGroupKey),
    );

    const registry = await readCourtRegistry(
      async () => await loadPublicCourtWeightsWithin(tx),
    );
    return decisions.map(
      ({ languageGroupKey, courtId, ...decision }): DecisionIdentityRow =>
        Object.assign(decision, {
          courtAbbreviation: courtPresentation(registry, {
            ...decision,
            courtId,
          }).courtAbbreviation,
          identifiers:
            identifiersByDecision.get(String(decision.id)) ??
            panic("Lost a decision's identifier list"),
          languageAlternates: alternates.alternatesFor(languageGroupKey),
        }),
    );
  });

  return rows;
};
