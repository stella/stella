import { inArray } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { ADMITTED_PUBLIC_COUNTRIES } from "@stll/api-contract/public-country-capability";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { provisionCitationProfileFor } from "@stll/legal-atlas/provision-citation-profiles";
import {
  locateProvisionCitations,
  provisionWorkEli,
} from "@stll/legal-atlas/provision-citation-resolve";
import type { LocatedProvisionCitationSpan } from "@stll/legal-atlas/provision-citation-resolve";

import { legislationDocuments } from "@/api/db/schema";
import { lookupDecisionsByIdentity } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { extractCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";
import type { ExtractedCitation } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { lookupDecisionIdentity } from "@/api/handlers/legal-resolve/decision-identity";
import { resolveWorksAtDate } from "@/api/lib/legal-search/legislation-works-at-date";
import type { WorkAtDateRequest } from "@/api/lib/legal-search/legislation-works-at-date";
import {
  buildCaseLawDecisionAppUrl,
  buildLegislationDocumentAppUrl,
} from "@/api/lib/legal-search/public-law-app-urls";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { boundedString } from "@/api/lib/search/response-text-bounds";

export const legalCitationLinksBodySchema = t.Object(
  {
    /** The finished answer, exactly as the reader renders it. */
    text: t.String({ maxLength: LIMITS.legalCitationLinksTextMaxChars }),
    /** The day the answer was written: a statute links to the wording then. */
    asOf: t.String({ format: "date" }),
    /**
     * Jurisdictions to read citations against, most likely first: a bare
     * `§ 52 ZP` names a different act in each, and the first that reads it
     * claims it.
     */
    countries: t.Array(tPublicLawCountry, {
      minItems: 1,
      maxItems: LIMITS.legalCitationLinksCountriesMax,
    }),
  },
  { additionalProperties: false },
);

type LegalCitationLinksBody = Static<typeof legalCitationLinksBodySchema>;

/** An app URL: origin, a slug path and a provision anchor. */
const LINK_URL_BYTES = 2048;

export const legalCitationLinksSuccessResponseSchema = t.Object(
  {
    links: t.Array(
      t.Object(
        {
          /** UTF-16 offsets into the text as sent, end exclusive. */
          start: t.Number({
            minimum: 0,
            maximum: LIMITS.legalCitationLinksTextMaxChars,
          }),
          end: t.Number({
            minimum: 1,
            maximum: LIMITS.legalCitationLinksTextMaxChars,
          }),
          kind: t.UnionEnum(["statute", "decision"]),
          url: boundedString(LINK_URL_BYTES),
        },
        { additionalProperties: false },
      ),
      { maxItems: LIMITS.legalCitationLinksSpansMax },
    ),
  },
  { additionalProperties: false },
);

export type LegalCitationLink = Static<
  typeof legalCitationLinksSuccessResponseSchema
>["links"][number];

type Span = { start: number; end: number };

const overlaps = (span: Span, taken: readonly Span[]): boolean =>
  taken.some((other) => span.start < other.end && other.start < span.end);

/** The admitted countries the caller named, canonical, in its order, once. */
const readCountries = (
  inputs: readonly string[],
  admitted: readonly string[],
): string[] => {
  const countries: string[] = [];
  for (const input of inputs) {
    const read = readPublicLawCountry(input, { admitted });
    if (read.kind === "read" && !countries.includes(read.country)) {
      countries.push(read.country);
    }
  }
  return countries;
};

type LocatedStatute = LocatedProvisionCitationSpan & {
  country: string;
  eli: string;
};

/**
 * Every provision the text cites with its act, read with each country's
 * profile in the caller's order: the first profile that resolves a stretch of
 * text claims it, so a later country never relinks it. The caller passes
 * only countries whose public law this surface reads.
 */
export const locateStatutes = ({
  text,
  asOf,
  countries,
}: {
  text: string;
  asOf: string;
  countries: readonly string[];
}): LocatedStatute[] => {
  const located: LocatedStatute[] = [];
  for (const country of countries) {
    const profile = provisionCitationProfileFor(country);
    if (profile === null) {
      continue;
    }
    for (const span of locateProvisionCitations({
      text,
      profile,
      citedOn: asOf,
    })) {
      if (overlaps(span, located)) {
        continue;
      }
      // A work outside the country's statute collections (an EU regulation
      // cited in Czech prose) has no ELI here and stays plain text.
      const eli = provisionWorkEli(profile, span.citation.work);
      if (eli !== null) {
        located.push({ ...span, country, eli });
      }
    }
  }
  return located.slice(0, LIMITS.legalCitationLinksSpansMax);
};

const workKey = ({ country, eli }: { country: string; eli: string }) =>
  `${country}|${eli}`;

/**
 * The statute links: each located provision at the consolidation in force on
 * `asOf`, one batched resolve for all of them. A work the corpus does not
 * hold, or holds no wording of on that day, is left unlinked.
 */
const linkStatutes = async ({
  located,
  asOf,
  legislationDb,
}: {
  located: readonly LocatedStatute[];
  asOf: string;
  legislationDb: LegislationReadDb;
}): Promise<LegalCitationLink[]> => {
  const requests = new Map<string, WorkAtDateRequest>();
  for (const span of located) {
    const key = workKey(span);
    requests.set(key, { key, country: span.country, eli: span.eli, asOf });
  }
  if (requests.size === 0) {
    return [];
  }
  const { idByKey, versions } = await legislationDb(async (tx) => {
    const resolved = await resolveWorksAtDate(tx, [...requests.values()]);
    const ids = [...new Set(resolved.idByKey.values())];
    return {
      idByKey: resolved.idByKey,
      versions:
        ids.length === 0
          ? []
          : await tx
              .select({
                id: legislationDocuments.id,
                eli: legislationDocuments.eli,
                slug: legislationDocuments.slug,
                country: legislationDocuments.country,
                versionValidFrom: legislationDocuments.versionValidFrom,
              })
              .from(legislationDocuments)
              .where(inArray(legislationDocuments.id, ids)),
    };
  });
  const versionById = new Map(versions.map((row) => [row.id, row]));
  return located.flatMap((span): LegalCitationLink[] => {
    const id = idByKey.get(workKey(span));
    const version = id === undefined ? undefined : versionById.get(id);
    if (version === undefined) {
      return [];
    }
    const url = buildLegislationDocumentAppUrl({
      country: version.country,
      documentId: version.id,
      eli: version.eli,
      slug: version.slug,
      version: version.versionValidFrom,
      anchor: span.citation.anchor,
    });
    return url === null
      ? []
      : [{ start: span.start, end: span.end, kind: "statute", url }];
  });
};

/** Every place a citation's spelling stands in the text. */
const occurrencesOf = (text: string, needle: string): Span[] => {
  const spans: Span[] = [];
  if (needle.length === 0) {
    return spans;
  }
  for (
    let start = text.indexOf(needle);
    start !== -1;
    start = text.indexOf(needle, start + needle.length)
  ) {
    spans.push({ start, end: start + needle.length });
  }
  return spans;
};

/**
 * What the citation reads as in the text. An ECLI has no final dot of its
 * own, so a dot after it closes the sentence.
 */
const citationSpelling = ({
  citationText,
  identifierType,
}: ExtractedCitation): string =>
  identifierType === DECISION_IDENTIFIER_TYPES.ECLI
    ? citationText.replace(/\.+$/u, "")
    : citationText;

/**
 * The identity to resolve: the docket with the sheet the text printed after
 * it (`3 Afs 41/2008 - 98`), since a docket names a file that may hold
 * several decisions and the sheet picks one.
 */
const citationIdentifier = (citation: ExtractedCitation): string => {
  const spelling = citationSpelling(citation);
  return citation.citedSheetNumber === null ||
    citation.identifierType !== DECISION_IDENTIFIER_TYPES.CASE_NUMBER
    ? spelling
    : `${spelling}-${citation.citedSheetNumber}`;
};

/** A dash between a docket and its sheet, spaced or not (`41/2008 - 98`). */
const SHEET_DASH = /^ ?[-‐‑‒–—] ?(?<sheet>\d{1,4})(?!\d)/u;

/**
 * The span over the sheet the text printed right after the docket, so the
 * link covers the whole reference the reader sees.
 */
const withSheet = (text: string, span: Span, sheet: string | null): Span => {
  if (sheet === null) {
    return span;
  }
  const after = SHEET_DASH.exec(text.slice(span.end, span.end + 8));
  return after?.groups?.["sheet"] === sheet
    ? { start: span.start, end: span.end + after[0].length }
    : span;
};

/**
 * The decision links: each docket, reporter number or ECLI the text names,
 * resolved by exact identity in the caller's countries in order. The first
 * country with any answer decides: only a unique decision is linked. A
 * docket naming a whole file links to the decision dated as the text dates
 * it, or to the file's only decision when no date is written; any other
 * ambiguous or incomplete identifier stays plain text rather than a guess.
 */
const linkDecisions = async ({
  text,
  countries,
  taken,
  lookup,
}: {
  text: string;
  countries: readonly string[];
  taken: readonly Span[];
  lookup: typeof lookupDecisionsByIdentity;
}): Promise<LegalCitationLink[]> => {
  const citations = extractCitations([{ index: 0, text }])
    .map((citation) => ({
      identifier: citationIdentifier(citation),
      citedDecisionDate: citation.citedDecisionDate,
      spans: occurrencesOf(text, citationSpelling(citation))
        .map((span) => withSheet(text, span, citation.citedSheetNumber))
        .filter((span) => !overlaps(span, taken)),
    }))
    .filter(({ spans }) => spans.length > 0)
    .slice(0, LIMITS.legalCitationLinksDecisionsMax);

  const resolved = await Promise.all(
    citations.map(async ({ citedDecisionDate, identifier, spans }) => {
      for (const country of countries) {
        // db-await-in-loop: countries are tried in order and the first answer
        // decides; bounded by legalCitationLinksCountriesMax
        const identity = await lookupDecisionIdentity({
          country,
          identifier,
          lookup,
          docketFamily: { citedDecisionDate },
        });
        if (identity.status === "not_found") {
          continue;
        }
        if (identity.status !== "unique") {
          return [];
        }
        const row = identity.decision;
        const url = buildCaseLawDecisionAppUrl({
          caseNumber: row.caseNumber,
          country: row.country,
          court: row.court,
          decisionId: row.id,
          language: row.language,
          languageAlternates: row.languageAlternates,
          slug: row.slug,
        });
        return url === null
          ? []
          : spans.map((span): LegalCitationLink => ({
              ...span,
              kind: "decision",
              url,
            }));
      }
      return [];
    }),
  );
  return resolved.flat();
};

type LegalCitationLinksDependencies = {
  legislationDb: LegislationReadDb;
  lookup?: typeof lookupDecisionsByIdentity;
};

/**
 * The statute and decision citations a finished answer makes, each as the
 * span of text to link and the page it opens. The text itself is never
 * rewritten: a caller wraps exactly these spans, so what the reader sees is
 * the answer as written, with links.
 *
 * Statutes link to the provision in the consolidation in force on `asOf`, so
 * an answer read a year later still opens the wording it was written
 * against. Statute spans are read first and a decision citation never takes
 * text a statute already claimed.
 */
export const legalCitationLinksHandler = async (
  body: LegalCitationLinksBody,
  {
    legislationDb,
    lookup = lookupDecisionsByIdentity,
  }: LegalCitationLinksDependencies,
): Promise<{ links: LegalCitationLink[] }> => {
  const countries = readCountries(body.countries, ADMITTED_PUBLIC_COUNTRIES);
  const located = locateStatutes({
    text: body.text,
    asOf: body.asOf,
    countries,
  });
  const statutes = await linkStatutes({
    located,
    asOf: body.asOf,
    legislationDb,
  });
  const decisions = await linkDecisions({
    text: body.text,
    countries,
    taken: located,
    lookup,
  });
  // Two decision spellings can share text (a docket inside a longer one):
  // the earlier, then longer, keeps it, so no character carries two links.
  const links: LegalCitationLink[] = [];
  for (const link of [...statutes, ...decisions].toSorted(
    (left, right) => left.start - right.start || right.end - left.end,
  )) {
    if (!overlaps(link, links)) {
      links.push(link);
    }
  }
  return { links: links.slice(0, LIMITS.legalCitationLinksSpansMax) };
};
