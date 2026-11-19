import { panic, TaggedError } from "better-result";

import { normalizeCountry } from "@stll/agent-input";
import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";
import {
  type HungarianActDesignation,
  hungarianDesignationWorkEli,
  readHungarianActCitations,
  readHungarianLawParts,
  readHungarianProvision,
} from "@stll/api-contract/magyar-kozlony-designation";
import {
  isPublicCountry,
  PUBLIC_COUNTRY_CAPABILITIES,
  type PublicCountry,
} from "@stll/api-contract/public-country-capability";
import { legalDayTimeZone } from "@stll/api-contract/public-country-legal-day";
import { STATUTE_ANCHOR_SCHEMES } from "@stll/api-contract/statute-anchor-schemes";
import {
  statuteGazetteAbbreviation,
  statuteGazetteEliCollection,
} from "@stll/api-contract/statute-gazette";
import {
  STATUTE_QUERY_CAPABILITIES,
  type StatuteQueryCountry,
} from "@stll/api-contract/statute-query-capability";
import { readStatuteQueryReferences } from "@stll/api-contract/statute-query-intent";
import { statuteAnchorKindPrefix } from "@stll/legal-ast/statute-anchor-scheme";
import { actIssuedFrom, pickNamedAct } from "@stll/legal-atlas/act-titles";
import { CZ_PROFILE } from "@stll/legal-atlas/cz-provision-citation-profile";
import {
  locateGazetteCitations,
  PROVISION_CITATION_GRAMMARS,
} from "@stll/legal-atlas/provision-citation-grammars";
import {
  type JurisdictionProfile,
  SECTION_UNITS,
  type SectionTermSpec,
  type SectionUnit,
  type WorkIdentifier,
} from "@stll/legal-atlas/provision-citation-profile";
import {
  nominativeTitle,
  resolveActCitation,
} from "@stll/legal-atlas/provision-citation-resolve";
import { SK_PROFILE } from "@stll/legal-atlas/sk-provision-citation-profile";
import { todayFor } from "@stll/time";

import type { LawReadAdmission } from "@/api/handlers/legal-resolve/admission";
import { resolveStatuteExpression } from "@/api/handlers/legislation/by-eli";
import { readPublicLegislationHandler } from "@/api/handlers/legislation/get";
import { readProvisionPreviewHandler } from "@/api/handlers/legislation/provision-preview";
import { readNamedLegislationWorks } from "@/api/lib/legal-search/legislation-work-names";
import {
  legislationPublicReadDb,
  type LegislationReadDb,
} from "@/api/lib/legislation-public-read-db";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

type LawProfile = {
  citation: JurisdictionProfile;
  queryCountry: StatuteQueryCountry;
  gazette: (typeof PROVISION_CITATION_GRAMMARS)[JurisdictionProfile["jurisdiction"]]["gazette"];
};

const LAW_PROFILES = {
  CZE: {
    citation: CZ_PROFILE,
    queryCountry: "cze",
    gazette: PROVISION_CITATION_GRAMMARS.CZE.gazette,
  },
  SVK: {
    citation: SK_PROFILE,
    queryCountry: "svk",
    gazette: PROVISION_CITATION_GRAMMARS.SVK.gazette,
  },
} as const satisfies Record<JurisdictionProfile["jurisdiction"], LawProfile>;

type LawResolveInput = {
  citation?: string | undefined;
  collection?: string | undefined;
  year?: string | undefined;
  number?: string | undefined;
  section?: string | undefined;
  asOf?: string | undefined;
};

type LawResolver = (input: LawResolveInput) => Promise<LegalResolveResponse>;

/** Works the corpus's stored titles name, for an act the profile does not list. */
type ReadNamedWorks = (
  name: string,
) => Promise<readonly { eli: string; validUntil: string | null }[]>;

class UnresolvedActCitationError extends TaggedError(
  "UnresolvedActCitationError",
)<{
  message: string;
}> {}

const UNRESOLVED_ACT_CITATION = failureSink({
  event: "legal_resolve.law.unresolved_act",
  expected: [],
});

/**
 * A citation that names its act in words and still names no act: either
 * the profile and the corpus's titles both miss a name courts write, or the
 * corpus lacks the act. Both are data to fix, so the miss is reported.
 * The name stays out of telemetry, which carries no free text a request
 * supplied; the count per jurisdiction is the signal.
 */
const reportUnresolvedActCitation = (country: string) => {
  observeFailure(
    new UnresolvedActCitationError({
      message: "An act citation named no act",
    }),
    {
      sink: UNRESOLVED_ACT_CITATION,
      ctx: { feature: "legal-resolve", jurisdiction: country },
    },
  );
};

type LawDependencies = {
  legislationDb?: LegislationReadDb;
  resolveExpression?: typeof resolveStatuteExpression;
  readDocument?: typeof readPublicLegislationHandler;
  readPreview?: typeof readProvisionPreviewHandler;
  readNamedWorks?: ReadNamedWorks;
  reportUnresolvedAct?: (actName: string) => void;
  today?: () => string;
};

type CitedActRead =
  | { type: "work"; eli: string }
  | { type: "unknown"; hint?: string }
  | { type: "unresolved"; actName: string };

// A `number/year` reference. When the gazette grammar declines one, it named
// a bare act number, a case-law reporter or the treaty collection. Only
// the shared query grammar may admit a number without its gazette suffix.
const NUMBERED_REFERENCE = /\d\s*\/\s*\d{4}/u;

type ReadCitedActOptions = {
  citation: string;
  citedOn: string;
  readNamedWorks: ReadNamedWorks;
  profile: LawProfile;
};

/**
 * The act a written citation names: a gazette number outright; else an
 * alias or title the citation profile reads for the citing date, so a
 * recodified title names the act then in force; else a name the corpus's
 * stored titles state. Names that fit several acts name none.
 */
const readCitedAct = async ({
  citation,
  citedOn,
  readNamedWorks,
  profile,
}: ReadCitedActOptions): Promise<CitedActRead> => {
  const gazette = locateGazetteCitations(citation).find(
    ({ jurisdiction }) => jurisdiction === profile.citation.jurisdiction,
  );
  if (gazette !== undefined) {
    const read = resolveActCitation({
      text: citation.slice(gazette.start, gazette.end),
      profile: profile.citation,
      citedOn,
    });
    if (read.status === "resolved") {
      return readWork(read.work, profile);
    }
    return { type: "unknown" };
  }
  if (NUMBERED_REFERENCE.test(citation)) {
    const references = readStatuteQueryReferences(
      profile.queryCountry,
      citation,
    );
    if (references.length !== 1) {
      return { type: "unknown" };
    }
    const read = resolveActCitation({
      text: citation,
      profile: profile.citation,
      citedOn,
    });
    return read.status === "resolved"
      ? readWork(read.work, profile)
      : { type: "unknown" };
  }
  const read = resolveActCitation({
    text: citation,
    profile: profile.citation,
    citedOn,
  });
  switch (read.status) {
    case "resolved":
      return readWork(read.work, profile);
    case "ambiguous_act":
      return { type: "unknown" };
    case "no_act":
      break;
    default:
      read satisfies never;
      return panic("Unknown act citation outcome");
  }
  if (read.actName === "") {
    return { type: "unknown" };
  }
  const named = await readNamedWorks(read.actName);
  if (named.length > 0) {
    const picked = pickNamedAct({
      candidates: named.map(({ eli, validUntil }) => ({
        act: eli,
        citedFrom: actIssuedFrom(eli),
        citedUntil: validUntil,
      })),
      date: citedOn,
      sameAct: (left, right) => left === right,
    });
    return picked.type === "resolved"
      ? { type: "work", eli: picked.act }
      : { type: "unknown" };
  }
  // Only a name shaped like a short title (`zákona o …`) is a miss worth
  // reporting; free text that names nothing is the caller's.
  return nominativeTitle(read.actName, profile.citation) === null
    ? { type: "unknown" }
    : { type: "unresolved", actName: read.actName };
};

type CitedProvision = { anchor: string; section: string };

/**
 * The provisions a cited number may name, most likely first. The words that
 * introduce a number (`§`, `čl.`, `článok`) are the profile's own; an act
 * numbers its provisions by section or by article, never both, so a bare
 * number names a section, else the article of that number.
 */
const citedProvisions = (
  section: string,
  profile: JurisdictionProfile,
): readonly CitedProvision[] => {
  const written = section.trim();
  const folded = written.toLocaleLowerCase(profile.language);
  let term: SectionTermSpec | undefined;
  for (const candidate of profile.sectionTerms) {
    if (
      folded.startsWith(candidate.text.toLocaleLowerCase(profile.language)) &&
      (term === undefined || candidate.text.length > term.text.length)
    ) {
      term = candidate;
    }
  }
  const match = /^(\d+)\s*([a-z])?$/iu.exec(
    written.slice(term?.text.length ?? 0).trim(),
  );
  const number = match?.at(1);
  if (number === undefined) {
    return [];
  }
  const designator = `${number}${match?.at(2)?.toLowerCase() ?? ""}`;
  const units: readonly SectionUnit[] =
    term === undefined ? SECTION_UNITS : [term.unit];
  return units.map((unit) => ({
    anchor: `${statuteAnchorKindPrefix(profile.anchor, unit)}${designator}`,
    section:
      unit === "section"
        ? designator
        : `${profile.citationTerms.article} ${designator}`,
  }));
};

const collectionKey = (collection: string) =>
  collection.replace(/[.\s]/gu, "").toLowerCase();

const readWork = (work: WorkIdentifier, profile: LawProfile): CitedActRead => {
  if (
    !Number.isSafeInteger(work.number) ||
    work.number < 1 ||
    work.number > 99_999 ||
    !Number.isSafeInteger(work.year) ||
    work.year < profile.citation.earliestYear ||
    work.year > 9999
  ) {
    return { type: "unknown" };
  }
  const collection = statuteGazetteEliCollection(work.collection);
  if (
    collection !==
    STATUTE_QUERY_CAPABILITIES[profile.queryCountry].defaultCollection
  ) {
    return { type: "unknown" };
  }
  const expected = statuteGazetteAbbreviation(collection, work.year);
  if (expected !== work.collection) {
    return {
      type: "unknown",
      hint: `Use ${expected ?? panic("Statute collection has no spelling")} for an act published in ${String(work.year)}.`,
    };
  }
  return {
    type: "work",
    eli: profile.gazette.eli({
      number: String(work.number),
      year: String(work.year),
      collection: work.collection,
    }),
  };
};

const isInForceOn = (
  from: string | null,
  to: string | null,
  date: string,
): boolean => (from === null || from <= date) && (to === null || to > date);

type StructuredActRead =
  CitedActRead | { type: "incomplete"; missing: string[] };

const readStructuredAct = (
  { collection, year, number }: LawResolveInput,
  profile: LawProfile,
): StructuredActRead => {
  if (collection === undefined || year === undefined || number === undefined) {
    return {
      type: "incomplete",
      missing: Object.entries({ collection, year, number }).flatMap(
        ([key, value]) => (value === undefined ? [key] : []),
      ),
    };
  }
  const parsedYear = parseIntegerToken(year, {
    sign: "unsigned",
    min: profile.citation.earliestYear,
    max: 9999,
  });
  const parsedNumber = parseIntegerToken(number, {
    sign: "unsigned",
    min: 1,
    max: 99_999,
  });
  if (parsedYear.isErr() || parsedNumber.isErr()) {
    return { type: "unknown" };
  }
  const printed = profile.citation.collections.find(({ spellings }) =>
    spellings.some(
      (spelling) => collectionKey(spelling) === collectionKey(collection),
    ),
  );
  const canonical =
    statuteGazetteAbbreviation(collection, parsedYear.value) ??
    printed?.canonical ??
    null;
  if (
    canonical === null ||
    !profile.citation.collections.some((entry) => entry.canonical === canonical)
  ) {
    return { type: "unknown" };
  }
  return readWork(
    {
      number: parsedNumber.value,
      year: parsedYear.value,
      collection: canonical,
    },
    profile,
  );
};

/**
 * How one jurisdiction's citations name an act and a provision in it. The
 * resolver around it (expression, provision preview, force dates) is the
 * same for every country; only reading the citation differs.
 */
type LawGrammar = {
  country: PublicCountry;
  readCitedAct: (options: {
    citation: string;
    citedOn: string;
    readNamedWorks: ReadNamedWorks;
  }) => Promise<CitedActRead>;
  readStructuredAct: (input: LawResolveInput) => StructuredActRead;
  citedProvisions: (section: string) => readonly CitedProvision[];
};

/** Czech and Slovak law: gazette numbers, the citation profile's titles. */
const gazetteLawGrammar = (profile: LawProfile): LawGrammar => ({
  country: profile.citation.jurisdiction,
  readCitedAct: async (options) => await readCitedAct({ ...options, profile }),
  readStructuredAct: (input) => readStructuredAct(input, profile),
  citedProvisions: (section) => citedProvisions(section, profile.citation),
});

const createLawResolver =
  (grammar: LawGrammar) =>
  async (
    input: LawResolveInput,
    {
      legislationDb = legislationPublicReadDb,
      resolveExpression = resolveStatuteExpression,
      readDocument = readPublicLegislationHandler,
      readPreview = readProvisionPreviewHandler,
      readNamedWorks = async (name) =>
        await legislationDb(
          async (tx) =>
            await readNamedLegislationWorks(tx, {
              query: name,
              country: grammar.country,
            }),
        ),
      reportUnresolvedAct = () => reportUnresolvedActCitation(grammar.country),
      today = () => todayFor(legalDayTimeZone(grammar.country)).toString(),
    }: LawDependencies = {},
  ): Promise<LegalResolveResponse> => {
    const act =
      input.citation === undefined
        ? grammar.readStructuredAct(input)
        : await grammar.readCitedAct({
            citation: input.citation,
            citedOn: input.asOf ?? today(),
            readNamedWorks,
          });
    let eli: string;
    switch (act.type) {
      case "work":
        eli = act.eli;
        break;
      case "incomplete":
        return { status: "incomplete_identifier", missing: act.missing };
      case "unresolved":
        reportUnresolvedAct(act.actName);
        return { status: "not_found", reason: "unknown_document" };
      case "unknown":
        return {
          status: "not_found",
          reason: "unknown_document",
          ...(act.hint === undefined ? {} : { hint: act.hint }),
        };
      default:
        act satisfies never;
        return panic("Unknown cited act read");
    }
    if (input.section === undefined) {
      return { status: "incomplete_identifier", missing: ["section"] };
    }
    const provisions = grammar.citedProvisions(input.section);
    if (provisions.length === 0) {
      return { status: "not_found", reason: "unknown_section" };
    }
    const expression = await resolveExpression(
      { eli, ...(input.asOf === undefined ? {} : { asOf: input.asOf }) },
      legislationDb,
      "search",
    );
    if (expression.type !== "expression") {
      return { status: "not_found", reason: "unknown_document" };
    }
    // The next candidate is asked only when the one before it is missing.
    const readCited = async (
      remaining: readonly CitedProvision[],
    ): Promise<
      | {
          section: string;
          preview: Extract<
            Awaited<ReturnType<typeof readPreview>>,
            { blocks: unknown }
          >;
        }
      | undefined
    > => {
      const [provision, ...rest] = remaining;
      if (provision === undefined) {
        return undefined;
      }
      const preview = await readPreview({
        documentId: expression.id,
        anchor: provision.anchor,
        citedAnchor: undefined,
        legislationDb,
      });
      return "blocks" in preview
        ? { section: provision.section, preview }
        : await readCited(rest);
    };
    const [document, found] = await Promise.all([
      readDocument(expression.id, legislationDb, "search"),
      readCited(provisions),
    ]);
    if (!("eli" in document)) {
      return { status: "not_found", reason: "unknown_document" };
    }
    if (found === undefined) {
      return { status: "not_found", reason: "unknown_section" };
    }
    const { preview } = found;
    const inForce = {
      from: document.versionValidFrom,
      to: document.versionValidTo,
    };
    return {
      status: "resolved",
      document: {
        kind: "provision",
        documentId: expression.id,
        eli,
        country: grammar.country,
        title: document.title,
        section: found.section,
        readerUrl:
          preview.url ??
          panic("Resolved public-law provision has no reader URL"),
        inForce,
        versionStatus: isInForceOn(inForce.from, inForce.to, today())
          ? "current"
          : "outdated",
        blocks: preview.blocks,
      },
    };
  };

const STRUCTURED_LAW_HINT =
  "A structured identity names a law: collection törvény, its year and number. Pass any other act as a citation with the day it was signed.";

const UNDATED_DECREE_HINT =
  "Name the act with the day it was signed, as the gazette prints it: 123/2020. (IV. 30.) Korm. rendelet.";

/** The Work one Hungarian citation names; several, or none, name no Work. */
const readHungarianAct = (
  acts: readonly HungarianActDesignation[],
): CitedActRead => {
  const [act, ...others] = acts;
  if (act === undefined || others.length > 0) {
    return { type: "unknown" };
  }
  const eli = hungarianDesignationWorkEli(act);
  if (eli === null) {
    return act.kind === "numbered" && act.signed === null
      ? { type: "unknown", hint: UNDATED_DECREE_HINT }
      : { type: "unknown" };
  }
  return { type: "work", eli };
};

/**
 * Hungarian law: the Magyar Közlöny designation of an act (`2013. évi V.
 * törvény`, `123/2020. (IV. 30.) Korm. rendelet`) or a code's abbreviation
 * read for the citing date (`Ptk.`), and a section (`6:519. §`, `25/G. §`)
 * or article (`IV. cikk`) in the gazette's anchors.
 */
const HUNGARIAN_LAW_GRAMMAR: LawGrammar = {
  country: "HUN",
  readCitedAct: async ({ citation, citedOn }) =>
    await Promise.resolve(
      readHungarianAct(readHungarianActCitations(citation, citedOn)),
    ),
  readStructuredAct: ({ collection, year, number }) => {
    if (
      collection === undefined ||
      year === undefined ||
      number === undefined
    ) {
      return {
        type: "incomplete",
        missing: Object.entries({ collection, year, number }).flatMap(
          ([key, value]) => (value === undefined ? [key] : []),
        ),
      };
    }
    const law = readHungarianLawParts({ kind: collection, year, number });
    return law === null
      ? { type: "unknown", hint: STRUCTURED_LAW_HINT }
      : readHungarianAct([law]);
  },
  citedProvisions: (section) =>
    readHungarianProvision(section).map(({ unit, designator }) => ({
      anchor: `${statuteAnchorKindPrefix(STATUTE_ANCHOR_SCHEMES.HUN, unit)}${designator}`,
      section: `${designator}. ${unit === "section" ? "§" : "cikk"}`,
    })),
};

export const resolveCzechLaw = createLawResolver(
  gazetteLawGrammar(LAW_PROFILES.CZE),
);
export const resolveSlovakLaw = createLawResolver(
  gazetteLawGrammar(LAW_PROFILES.SVK),
);
export const resolveHungarianLaw = createLawResolver(HUNGARIAN_LAW_GRAMMAR);

const unavailable: LawResolver = async () =>
  await Promise.resolve({ status: "country_unavailable" });

const LAW_RESOLVERS = {
  AUT: unavailable,
  BRA: unavailable,
  CZE: resolveCzechLaw,
  EU: unavailable,
  GBR: unavailable,
  HUN: resolveHungarianLaw,
  POL: unavailable,
  SVK: resolveSlovakLaw,
  USA: unavailable,
} as const satisfies Record<PublicCountry, LawResolver>;

type ResolveLawCitationOptions = {
  admission: LawReadAdmission;
  country: string;
  input: LawResolveInput;
};

export const resolveLawCitation = async ({
  admission: _admission,
  country: countryInput,
  input,
}: ResolveLawCitationOptions): Promise<LegalResolveResponse> => {
  const normalized = normalizeCountry(countryInput);
  if (!normalized.ok || !isPublicCountry(normalized.value.alpha3)) {
    return { status: "country_unavailable" };
  }
  if (
    PUBLIC_COUNTRY_CAPABILITIES[normalized.value.alpha3].legislation !==
    "admitted"
  ) {
    return { status: "country_unavailable" };
  }
  return await LAW_RESOLVERS[normalized.value.alpha3](input);
};
