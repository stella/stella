// parser-output-unchanged: query reference lookup; stored title derivation is unchanged
import { panic } from "better-result";
import { and, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { readStatuteQueryScope } from "@stll/api-contract/statute-query-capability";
import {
  readStatuteQueryReferences,
  type StatuteQueryReference,
} from "@stll/api-contract/statute-query-intent";
import {
  splitStatuteTitleCitation,
  statuteTitleCitationMentionRegex,
} from "@stll/api-contract/statute-route";

import type { Transaction } from "@/api/db/root";
import {
  LEGISLATION_WORK_NAME_KEY_MAX_CHARS,
  legislationDocuments,
  legislationWorkNames,
} from "@/api/db/schema";
import type { LegislationWorkNameDerivation } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { actNumberCondition } from "@/api/lib/legal-search/legislation-act-number";
import { redistributableLegislationVersion } from "@/api/lib/legal-search/legislation-redistribution";
import type { LegislationReadTransaction } from "@/api/lib/legislation-public-read-db";

/**
 * The names a stored legislation title states, and how a query is matched
 * against them.
 *
 * Everything here is read off stored titles: the publisher's title itself,
 * the parts of it that are the act's own name, and the names other stored
 * titles give an act where they cite it. No list of names, abbreviations or
 * word forms is kept anywhere, so a jurisdiction is covered by the titles it
 * stores and nothing else.
 *
 * What a title does not state is not matched: an inflected form, an
 * abbreviation, a long official name shortened in speech. A later deriver can
 * add such names as rows of its own `derivation` (with its provenance), and
 * the lookup below reads them unchanged; this module derives only what the
 * text itself says.
 */

/** Word tokens: letters, marks and digits, anything else separates. */
const WORD_TOKEN = /[\p{L}\p{M}\p{N}]+/gu;
const DIGITS_ONLY = /^\p{N}+$/u;
const LETTERS_ONLY = /^\p{L}[\p{L}\p{M}]*$/u;
const PARENTHETICAL = /\(([^()]+)\)/gu;
const FIRST_CLAUSE_END = /[,;]/u;

/**
 * How a name and a query are compared: case-folded word tokens, joined by one
 * space. Diacritics are kept (they tell words apart), punctuation is not.
 * Null for text with no word, for a bare number (a year or a paragraph is not
 * an act's name), and for a key too long to index.
 */
export const legislationNameMatchKey = (text: string): string | null => {
  const tokens = Array.from(
    text.normalize("NFC").toLowerCase().matchAll(WORD_TOKEN),
    (match) => match[0],
  );
  // A bare number, or no word at all, names no act.
  if (tokens.every((token) => DIGITS_ONLY.test(token))) {
    return null;
  }
  const key = tokens.join(" ");
  return key.length > LEGISLATION_WORK_NAME_KEY_MAX_CHARS ? null : key;
};

/** One row of `legislation_work_names`, before it is stored. */
export type LegislationWorkNameForm =
  | {
      origin: "official";
      officialTitle: string;
      matchKey: string | null;
    }
  | {
      origin: "derived";
      derivation: Exclude<
        LegislationWorkNameDerivation,
        "derived_from_citation"
      >;
      derivedName: string;
      matchKey: string;
    }
  | {
      origin: "derived";
      derivation: "derived_from_citation";
      derivedName: string;
      matchKey: string;
      citedKey: string;
    };

const parentheticalsOf = (text: string): string[] =>
  [...text.matchAll(PARENTHETICAL)].flatMap((match) => {
    const inner = match[1]?.trim();
    return inner === undefined || inner === "" ? [] : [inner];
  });

/**
 * The word a citing title writes right before a citation (`zákona č.
 * 89/2012 Sb.` → `zákona`), skipping abbreviations that end in a full stop.
 * Null when that word is not plain letters.
 */
const headWordBefore = (text: string): string | null => {
  const words = text.trim().split(/\s+/u);
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index];
    if (word === undefined || word === "") {
      return null;
    }
    if (word.endsWith(".")) {
      continue;
    }
    return LETTERS_ONLY.test(word) ? word : null;
  }
  return null;
};

const formIdentity = (form: LegislationWorkNameForm): string =>
  JSON.stringify([
    form.origin === "official" ? null : form.derivation,
    form.origin === "derived" && form.derivation === "derived_from_citation"
      ? form.citedKey
      : null,
    form.matchKey,
  ]);

/**
 * Every name one stored title states, the official title first.
 *
 * - the title as stored, as the `official` form;
 * - its own name: the rest after the citation it opens with, up to the first
 *   comma or semicolon (a later clause is typically another act's name), and
 *   every parenthesis in it;
 * - the citation it opens with, which is how other titles refer to it;
 * - for every citation of another act the title makes, the name written after
 *   it, that name with the word before the citation, and every parenthesis
 *   in it, each keyed to the cited citation rather than to a work.
 */
export const legislationWorkNameForms = (
  title: string,
): LegislationWorkNameForm[] => {
  const forms: LegislationWorkNameForm[] = [
    {
      origin: "official",
      officialTitle: title,
      matchKey: legislationNameMatchKey(title),
    },
  ];
  const derive = (
    derivation: Exclude<LegislationWorkNameDerivation, "derived_from_citation">,
    name: string,
  ) => {
    const matchKey = legislationNameMatchKey(name);
    if (matchKey !== null) {
      forms.push({
        origin: "derived",
        derivation,
        derivedName: name,
        matchKey,
      });
    }
  };
  const deriveFromCitation = (name: string, citedKey: string) => {
    const matchKey = legislationNameMatchKey(name);
    if (matchKey !== null) {
      forms.push({
        origin: "derived",
        derivation: "derived_from_citation",
        derivedName: name,
        matchKey,
        citedKey,
      });
    }
  };

  const { citation, rest } = splitStatuteTitleCitation(title);
  const ownName = rest.split(FIRST_CLAUSE_END, 1)[0]?.trim() ?? "";
  if (ownName !== "") {
    derive("derived_title_segment", ownName);
    for (const inner of parentheticalsOf(ownName)) {
      derive("derived_parenthetical", inner);
    }
  }
  const ownCitationKey =
    citation === null ? null : legislationNameMatchKey(citation);
  if (citation !== null) {
    derive("derived_title_citation", citation);
  }

  for (const mention of title.matchAll(statuteTitleCitationMentionRegex())) {
    const citedKey = legislationNameMatchKey(mention[1] ?? "");
    const name = mention[2]?.trim() ?? "";
    // The citation a title opens with is its own, not a citation of another act.
    if (citedKey === null || citedKey === ownCitationKey || name === "") {
      continue;
    }
    deriveFromCitation(name, citedKey);
    const head = headWordBefore(title.slice(0, mention.index));
    if (head !== null) {
      deriveFromCitation(`${head} ${name}`, citedKey);
    }
    for (const inner of parentheticalsOf(name)) {
      deriveFromCitation(inner, citedKey);
    }
  }

  const officialKey = legislationNameMatchKey(title);
  const seen = new Set<string>();
  return forms.filter((form) => {
    const identity = formIdentity(form);
    // A title that is its own name adds no derived form beside the official one.
    const repeatsOfficial =
      form.origin === "derived" &&
      form.derivation === "derived_title_segment" &&
      form.matchKey === officialKey;
    if (seen.has(identity) || repeatsOfficial) {
      return false;
    }
    seen.add(identity);
    return true;
  });
};

/** A stored version whose title the names are read from. */
export type LegislationWorkNameSubject = {
  id: SafeId<"legislationDocument">;
  country: string;
  title: string;
};

type StoredWorkNameRow = {
  id: SafeId<"legislationWorkName">;
  documentId: SafeId<"legislationDocument">;
  country: string;
  officialTitle: string | null;
  derivedName: string | null;
  derivation: LegislationWorkNameDerivation | null;
  citedKey: string | null;
  matchKey: string | null;
};

type WorkNameInsert = typeof legislationWorkNames.$inferInsert;

const rowOfForm = (
  subject: LegislationWorkNameSubject,
  form: LegislationWorkNameForm,
): WorkNameInsert =>
  form.origin === "official"
    ? {
        documentId: subject.id,
        country: subject.country,
        officialTitle: form.officialTitle,
        derivedName: null,
        derivation: null,
        citedKey: null,
        matchKey: form.matchKey,
      }
    : {
        documentId: subject.id,
        country: subject.country,
        officialTitle: null,
        derivedName: form.derivedName,
        derivation: form.derivation,
        citedKey:
          form.derivation === "derived_from_citation" ? form.citedKey : null,
        matchKey: form.matchKey,
      };

const rowIdentity = (row: {
  documentId: string;
  country: string;
  officialTitle?: string | null | undefined;
  derivedName?: string | null | undefined;
  derivation?: string | null | undefined;
  citedKey?: string | null | undefined;
  matchKey?: string | null | undefined;
}): string =>
  JSON.stringify([
    row.documentId,
    row.country,
    row.officialTitle ?? null,
    row.derivedName ?? null,
    row.derivation ?? null,
    row.citedKey ?? null,
    row.matchKey ?? null,
  ]);

/** What bringing some versions' names up to their titles would change. */
export type LegislationWorkNamePlan = {
  inserts: WorkNameInsert[];
  deleteIds: SafeId<"legislationWorkName">[];
  /** Versions whose stored names differ from what their titles state. */
  changedDocumentIds: SafeId<"legislationDocument">[];
};

/**
 * The difference between the names stored for `subjects` and the names their
 * titles state. Pure: a dry run reports it, a write applies it, and applying
 * it twice changes nothing the second time.
 */
export const planLegislationWorkNames = (
  subjects: readonly LegislationWorkNameSubject[],
  stored: readonly StoredWorkNameRow[],
): LegislationWorkNamePlan => {
  const storedByIdentity = new Map(
    stored.map((row) => [rowIdentity(row), row]),
  );
  const desired = subjects.flatMap((subject) =>
    legislationWorkNameForms(subject.title).map((form) =>
      rowOfForm(subject, form),
    ),
  );
  const desiredIdentities = new Set(desired.map((row) => rowIdentity(row)));
  const inserts = desired.filter(
    (row) => !storedByIdentity.has(rowIdentity(row)),
  );
  const deletes = stored.filter(
    (row) => !desiredIdentities.has(rowIdentity(row)),
  );
  const changed = new Set<SafeId<"legislationDocument">>([
    ...inserts.map((row) => row.documentId),
    ...deletes.map((row) => row.documentId),
  ]);
  return {
    inserts,
    deleteIds: deletes.map((row) => row.id),
    changedDocumentIds: [...changed],
  };
};

type WorkNameReadTransaction = Pick<Transaction, "select">;
type WorkNameWriteTransaction = Pick<
  Transaction,
  "select" | "insert" | "delete"
>;

/** The names stored for these versions, by the form key's leading column. */
export const readStoredLegislationWorkNames = async (
  tx: WorkNameReadTransaction,
  documentIds: readonly SafeId<"legislationDocument">[],
): Promise<StoredWorkNameRow[]> =>
  documentIds.length === 0
    ? []
    : await tx
        .select({
          id: legislationWorkNames.id,
          documentId: legislationWorkNames.documentId,
          country: legislationWorkNames.country,
          officialTitle: legislationWorkNames.officialTitle,
          derivedName: legislationWorkNames.derivedName,
          derivation: legislationWorkNames.derivation,
          citedKey: legislationWorkNames.citedKey,
          matchKey: legislationWorkNames.matchKey,
        })
        .from(legislationWorkNames)
        .where(inArray(legislationWorkNames.documentId, [...documentIds]));

/**
 * Bring the stored names of `subjects` up to what their titles state, inside
 * the caller's transaction: rows no title states any more are removed, new
 * ones inserted, unchanged ones left alone. The version rows themselves are
 * only read.
 */
export const syncLegislationWorkNamesTx = async (
  tx: WorkNameWriteTransaction,
  subjects: readonly LegislationWorkNameSubject[],
): Promise<LegislationWorkNamePlan> => {
  const stored = await readStoredLegislationWorkNames(
    tx,
    subjects.map((subject) => subject.id),
  );
  const plan = planLegislationWorkNames(subjects, stored);
  // Derived from the stored titles alone and rewritten with them, so the
  // version write these rows follow is the one a trail would record.
  if (plan.deleteIds.length > 0) {
    await tx
      .delete(legislationWorkNames)
      .where(inArray(legislationWorkNames.id, plan.deleteIds));
  }
  if (plan.inserts.length > 0) {
    await tx
      .insert(legislationWorkNames)
      .values(plan.inserts)
      .onConflictDoNothing();
  }
  return plan;
};

/** A Work as the corpus keys it: `(source, eli, language)`. */
export type LegislationWorkRef = {
  sourceId: SafeId<"legislationSource">;
  eli: string;
  language: string;
};

export const legislationWorkRefKey = (work: LegislationWorkRef): string =>
  JSON.stringify([work.sourceId, work.eli, work.language]);

/** A Work a query names, and whether a citation elsewhere backs the name. */
export type NamedLegislationWork = LegislationWorkRef & {
  fromCitation: boolean;
};

/** Versions whose own title states a name, read per lookup at most. */
const NAMED_VERSION_LIMIT = 500;
/** Distinct citations a name is written beside, read per lookup at most. */
const CITED_KEY_LIMIT = 50;

type NameLookup = {
  matchKey: string;
  country?: string | undefined;
};

const nameLookupWhere = ({ matchKey, country }: NameLookup): SQL[] => [
  eq(legislationWorkNames.matchKey, matchKey),
  ...(country === undefined ? [] : [eq(legislationWorkNames.country, country)]),
];

/**
 * Versions whose own title states the name, by the match-key index. Exported
 * so the plan test EXPLAINs the statement search runs.
 */
export const ownNameVersionsQuery = (
  tx: LegislationReadTransaction,
  lookup: NameLookup,
) =>
  tx
    .select({ documentId: legislationWorkNames.documentId })
    .from(legislationWorkNames)
    .where(
      and(
        ...nameLookupWhere(lookup),
        isNull(legislationWorkNames.citedKey),
        or(
          isNull(legislationWorkNames.derivation),
          ne(legislationWorkNames.derivation, "derived_title_citation"),
        ),
      ),
    )
    .groupBy(legislationWorkNames.documentId)
    .limit(NAMED_VERSION_LIMIT);

/** Citations other titles write the name beside, by the same index. */
export const citedKeysQuery = (
  tx: LegislationReadTransaction,
  lookup: NameLookup,
) =>
  tx
    .select({
      country: legislationWorkNames.country,
      citedKey: legislationWorkNames.citedKey,
    })
    .from(legislationWorkNames)
    .where(
      and(...nameLookupWhere(lookup), isNotNull(legislationWorkNames.citedKey)),
    )
    .groupBy(legislationWorkNames.country, legislationWorkNames.citedKey)
    .limit(CITED_KEY_LIMIT);

/**
 * Act identities the query names in its jurisdiction. Without a jurisdiction,
 * or in one with no act grammar, there are none and only titles are matched.
 */
const statuteQueryReferences = (
  query: string,
  country: string | undefined,
): StatuteQueryReference[] => {
  if (country === undefined) {
    return [];
  }
  const scope = readStatuteQueryScope(country.toLowerCase());
  switch (scope.type) {
    case "supported":
      return readStatuteQueryReferences(scope.country, query);
    case "unsupported":
      return [];
    default: {
      scope satisfies never;
      return panic(`Unhandled statute query scope: ${String(scope)}`);
    }
  }
};

type ReadNamedLegislationWorksOptions = {
  query: string;
  /** Narrows the lookup to one jurisdiction's names. */
  country?: string | undefined;
};

/**
 * Explicit citations and aliases address Works by act identity. Otherwise
 * the whole query is compared with names stored titles state. A name a
 * citation elsewhere attaches to a Work corroborates it: when any named Work is corroborated, only the
 * corroborated ones are returned, because an amending act's own title can
 * carry the amended act's name without being that act.
 *
 * Identity lookups use the ELI trigram index; title lookups use the match-key
 * index. Every read is bounded.
 */
export const readNamedLegislationWorks = async (
  tx: LegislationReadTransaction,
  { query, country }: ReadNamedLegislationWorksOptions,
): Promise<NamedLegislationWork[]> => {
  // Explicit act identities outrank titles of amendments that mention them.
  const references = statuteQueryReferences(query, country);
  if (references.length > 0) {
    const versions = await tx
      .select({
        sourceId: legislationDocuments.sourceId,
        eli: legislationDocuments.eli,
        language: legislationDocuments.language,
      })
      .from(legislationDocuments)
      .where(
        and(
          redistributableLegislationVersion,
          or(
            ...references.map((reference) => {
              const actCondition = actNumberCondition({
                number: `${reference.number}/${reference.year}`,
                collection: reference.collection ?? undefined,
              });
              if (actCondition === null) {
                return panic(
                  "Parsed statute reference has no act-number condition",
                );
              }
              return and(
                eq(
                  legislationDocuments.country,
                  reference.country.toUpperCase(),
                ),
                actCondition,
              );
            }),
          ),
        ),
      )
      .groupBy(
        legislationDocuments.sourceId,
        legislationDocuments.eli,
        legislationDocuments.language,
      )
      .orderBy(
        legislationDocuments.sourceId,
        legislationDocuments.eli,
        legislationDocuments.language,
      )
      .limit(NAMED_VERSION_LIMIT);
    if (versions.length > 0) {
      return versions.map(({ sourceId, eli, language }) => ({
        sourceId,
        eli,
        language,
        fromCitation: true,
      }));
    }
  }
  const matchKey = legislationNameMatchKey(query);
  if (matchKey === null) {
    return [];
  }
  const ownNames = await ownNameVersionsQuery(tx, { matchKey, country });
  const citedKeys = await citedKeysQuery(tx, { matchKey, country });

  const citations = citedKeys.flatMap(({ country: citedCountry, citedKey }) =>
    citedKey === null ? [] : [{ country: citedCountry, citedKey }],
  );
  const citedVersions =
    citations.length === 0
      ? []
      : await tx
          .select({ documentId: legislationWorkNames.documentId })
          .from(legislationWorkNames)
          .where(
            and(
              eq(legislationWorkNames.derivation, "derived_title_citation"),
              or(
                ...citations.map((citation) =>
                  and(
                    eq(legislationWorkNames.matchKey, citation.citedKey),
                    eq(legislationWorkNames.country, citation.country),
                  ),
                ),
              ),
            ),
          )
          .limit(NAMED_VERSION_LIMIT);

  const fromCitationIds = new Set(citedVersions.map((row) => row.documentId));
  const versionIds = [
    ...new Set([...ownNames.map((row) => row.documentId), ...fromCitationIds]),
  ];
  if (versionIds.length === 0) {
    return [];
  }

  const versions = await tx
    .select({
      id: legislationDocuments.id,
      sourceId: legislationDocuments.sourceId,
      eli: legislationDocuments.eli,
      language: legislationDocuments.language,
    })
    .from(legislationDocuments)
    .where(inArray(legislationDocuments.id, versionIds));

  const works = new Map<string, NamedLegislationWork>();
  for (const version of versions) {
    const work: NamedLegislationWork = {
      sourceId: version.sourceId,
      eli: version.eli,
      language: version.language,
      fromCitation: fromCitationIds.has(version.id),
    };
    const key = legislationWorkRefKey(work);
    const known = works.get(key);
    works.set(key, {
      ...work,
      fromCitation: work.fromCitation || (known?.fromCitation ?? false),
    });
  }
  const named = [...works.values()];
  const corroborated = named.filter((work) => work.fromCitation);
  const chosen = corroborated.length > 0 ? corroborated : named;
  // Ordered by key rather than by language: the order only has to be stable.
  const byKey = new Map(
    chosen.map((work) => [legislationWorkRefKey(work), work]),
  );
  const ordered: NamedLegislationWork[] = [];
  for (const key of [...byKey.keys()].toSorted()) {
    const work = byKey.get(key);
    if (work !== undefined) {
      ordered.push(work);
    }
  }
  return ordered;
};
