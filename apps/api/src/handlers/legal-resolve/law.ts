import { panic, TaggedError } from "better-result";

import { normalizeCountry } from "@stll/agent-input";
import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";
import {
  isPublicCountry,
  PUBLIC_COUNTRY_CAPABILITIES,
  type PublicCountry,
} from "@stll/api-contract/public-country-capability";
import {
  statuteGazetteAbbreviation,
  statuteGazetteEliCollection,
} from "@stll/api-contract/statute-gazette";
import {
  STATUTE_QUERY_CAPABILITIES,
  type StatuteQueryCountry,
} from "@stll/api-contract/statute-query-capability";
import { readStatuteQueryReferences } from "@stll/api-contract/statute-query-intent";
import { CZ_PROFILE } from "@stll/legal-atlas/cz-provision-citation-profile";
import {
  locateGazetteCitations,
  PROVISION_CITATION_GRAMMARS,
} from "@stll/legal-atlas/provision-citation-grammars";
import type {
  JurisdictionProfile,
  WorkIdentifier,
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
  timeZone: string;
  gazette: (typeof PROVISION_CITATION_GRAMMARS)[JurisdictionProfile["jurisdiction"]]["gazette"];
};

const LAW_PROFILES = {
  CZE: {
    citation: CZ_PROFILE,
    queryCountry: "cze",
    timeZone: "Europe/Prague",
    gazette: PROVISION_CITATION_GRAMMARS.CZE.gazette,
  },
  SVK: {
    citation: SK_PROFILE,
    queryCountry: "svk",
    timeZone: "Europe/Bratislava",
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
type ReadNamedWorks = (name: string) => Promise<readonly { eli: string }[]>;

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
  const elis = new Set(
    (await readNamedWorks(read.actName)).map(({ eli }) => eli),
  );
  const [eli, ...others] = elis;
  if (eli !== undefined) {
    return others.length === 0 ? { type: "work", eli } : { type: "unknown" };
  }
  // Only a name shaped like a short title (`zákona o …`) is a miss worth
  // reporting; free text that names nothing is the caller's.
  return nominativeTitle(read.actName, profile.citation) === null
    ? { type: "unknown" }
    : { type: "unresolved", actName: read.actName };
};

const normalizedSection = (
  section: string,
  profile: JurisdictionProfile,
): { anchor: string; section: string } | null => {
  const match = /^(?:§\s*)?(\d+)\s*([a-z])?$/iu.exec(section.trim());
  const number = match?.at(1);
  if (number === undefined) {
    return null;
  }
  const suffix = match?.at(2)?.toLowerCase() ?? "";
  return {
    anchor: profile.anchor.render.section(`${number}${suffix}`),
    section: `${number}${suffix}`,
  };
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

const createLawResolver =
  (profile: LawProfile) =>
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
              country: profile.citation.jurisdiction,
            }),
        ),
      reportUnresolvedAct = () =>
        reportUnresolvedActCitation(profile.citation.jurisdiction),
      today = () => todayFor(profile.timeZone).toString(),
    }: LawDependencies = {},
  ): Promise<LegalResolveResponse> => {
    const act =
      input.citation === undefined
        ? readStructuredAct(input, profile)
        : await readCitedAct({
            citation: input.citation,
            citedOn: input.asOf ?? today(),
            readNamedWorks,
            profile,
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
    const section = normalizedSection(input.section, profile.citation);
    if (section === null) {
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
    const [document, preview] = await Promise.all([
      readDocument(expression.id, legislationDb, "search"),
      readPreview({
        documentId: expression.id,
        anchor: section.anchor,
        citedAnchor: undefined,
        legislationDb,
      }),
    ]);
    if (!("eli" in document)) {
      return { status: "not_found", reason: "unknown_document" };
    }
    if (!("blocks" in preview)) {
      return { status: "not_found", reason: "unknown_section" };
    }
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
        country: profile.citation.jurisdiction,
        title: document.title,
        section: section.section,
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

export const resolveCzechLaw = createLawResolver(LAW_PROFILES.CZE);
export const resolveSlovakLaw = createLawResolver(LAW_PROFILES.SVK);

const unavailable: LawResolver = async () =>
  await Promise.resolve({ status: "country_unavailable" });

const LAW_RESOLVERS = {
  AUT: unavailable,
  BRA: unavailable,
  CZE: resolveCzechLaw,
  EU: unavailable,
  GBR: unavailable,
  HUN: unavailable,
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
