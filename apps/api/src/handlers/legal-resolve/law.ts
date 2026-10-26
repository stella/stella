import { panic, TaggedError } from "better-result";

import { normalizeCountry } from "@stll/agent-input";
import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";
import {
  isPublicCountry,
  PUBLIC_COUNTRY_CAPABILITIES,
  type PublicCountry,
} from "@stll/api-contract/public-country-capability";
import { CZ_PROFILE } from "@stll/legal-atlas/cz-provision-citation-profile";
import {
  locateGazetteCitations,
  PROVISION_CITATION_GRAMMARS,
} from "@stll/legal-atlas/provision-citation-grammars";
import {
  nominativeTitle,
  resolveActCitation,
} from "@stll/legal-atlas/provision-citation-resolve";
import { todayFor } from "@stll/time";

import type { LawReadAdmission } from "@/api/handlers/legal-resolve/admission";
import { resolveStatuteExpression } from "@/api/handlers/legislation/by-eli";
import { readPublicLegislationHandler } from "@/api/handlers/legislation/get";
import { readProvisionPreviewHandler } from "@/api/handlers/legislation/provision-preview";
import { readNamedLegislationWorks } from "@/api/lib/legal-search/legislation-work-names";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const CZE = "CZE";

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

const readCzechNamedWorks: ReadNamedWorks = async (name) =>
  await legislationPublicReadDb(
    async (tx) =>
      await readNamedLegislationWorks(tx, { query: name, country: CZE }),
  );

class UnresolvedActCitationError extends TaggedError(
  "UnresolvedActCitationError",
)<{
  message: string;
}> {}

const UNRESOLVED_ACT_CITATION = failureSink({
  event: "legal_resolve.czech_law.unresolved_act",
  expected: [],
});

/**
 * A citation that names its act in words and still names no act: either
 * the profile and the corpus's titles both miss a name courts write, or the
 * corpus lacks the act. Both are data to fix, so the miss is reported.
 * The name stays out of telemetry, which carries no free text a request
 * supplied; the count per jurisdiction is the signal.
 */
const reportUnresolvedActCitation = () => {
  observeFailure(
    new UnresolvedActCitationError({
      message: "A Czech act citation named no act",
    }),
    {
      sink: UNRESOLVED_ACT_CITATION,
      ctx: { feature: "legal-resolve", jurisdiction: CZE },
    },
  );
};

type CzechLawDependencies = {
  resolveExpression?: typeof resolveStatuteExpression;
  readDocument?: typeof readPublicLegislationHandler;
  readPreview?: typeof readProvisionPreviewHandler;
  readNamedWorks?: ReadNamedWorks;
  reportUnresolvedAct?: (actName: string) => void;
  today?: () => string;
};

type CitedActRead =
  | { type: "work"; eli: string }
  | { type: "unknown" }
  | { type: "unresolved"; actName: string };

type ReadCitedActOptions = {
  citation: string;
  citedOn: string;
  readNamedWorks: ReadNamedWorks;
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
}: ReadCitedActOptions): Promise<CitedActRead> => {
  const gazette = locateGazetteCitations(citation).find(
    ({ jurisdiction }) => jurisdiction === CZE,
  );
  if (gazette !== undefined) {
    return { type: "work", eli: gazette.eli };
  }
  const read = resolveActCitation({
    text: citation,
    profile: CZ_PROFILE,
    citedOn,
  });
  switch (read.status) {
    case "resolved":
      return {
        type: "work",
        eli: PROVISION_CITATION_GRAMMARS.CZE.gazette.eli({
          number: String(read.work.number),
          year: String(read.work.year),
        }),
      };
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
  return nominativeTitle(read.actName, CZ_PROFILE) === null
    ? { type: "unknown" }
    : { type: "unresolved", actName: read.actName };
};

const normalizedSection = (
  section: string,
): { anchor: string; section: string } | null => {
  const match = /^(?:§\s*)?(\d+)\s*([a-z])?$/iu.exec(section.trim());
  const number = match?.at(1);
  if (number === undefined) {
    return null;
  }
  const suffix = match?.at(2)?.toLowerCase() ?? "";
  return { anchor: `par_${number}${suffix}`, section: `${number}${suffix}` };
};

const czechToday = (): string => todayFor("Europe/Prague").toString();
const CZECH_COLLECTION_OF_LAWS = "sb";

const isInForceOn = (
  from: string | null,
  to: string | null,
  date: string,
): boolean => (from === null || from <= date) && (to === null || to > date);

export const resolveCzechLaw = async (
  input: LawResolveInput,
  {
    resolveExpression = resolveStatuteExpression,
    readDocument = readPublicLegislationHandler,
    readPreview = readProvisionPreviewHandler,
    readNamedWorks = readCzechNamedWorks,
    reportUnresolvedAct = reportUnresolvedActCitation,
    today = czechToday,
  }: CzechLawDependencies = {},
): Promise<LegalResolveResponse> => {
  const missing: string[] = [];
  let eli: string | undefined;
  if (input.citation !== undefined) {
    const act = await readCitedAct({
      citation: input.citation,
      citedOn: input.asOf ?? today(),
      readNamedWorks,
    });
    switch (act.type) {
      case "work":
        eli = act.eli;
        break;
      case "unresolved":
        reportUnresolvedAct(act.actName);
        break;
      case "unknown":
        break;
      default:
        act satisfies never;
        return panic("Unknown cited act read");
    }
  } else {
    if (input.collection === undefined) {
      missing.push("collection");
    }
    if (input.year === undefined) {
      missing.push("year");
    }
    if (input.number === undefined) {
      missing.push("number");
    }
    if (missing.length === 0) {
      const { collection, year, number } = input;
      if (
        collection === CZECH_COLLECTION_OF_LAWS &&
        year !== undefined &&
        number !== undefined
      ) {
        eli = PROVISION_CITATION_GRAMMARS.CZE.gazette.eli({ number, year });
      }
    }
  }
  if (missing.length > 0) {
    return { status: "incomplete_identifier", missing };
  }
  if (eli === undefined) {
    return { status: "not_found", reason: "unknown_document" };
  }
  if (input.section === undefined) {
    return { status: "incomplete_identifier", missing: ["section"] };
  }
  const section = normalizedSection(input.section);
  if (section === null) {
    return { status: "not_found", reason: "unknown_section" };
  }
  const expression = await resolveExpression(
    { eli, ...(input.asOf === undefined ? {} : { asOf: input.asOf }) },
    legislationPublicReadDb,
    "search",
  );
  if (expression.type !== "expression") {
    return { status: "not_found", reason: "unknown_document" };
  }
  const [document, preview] = await Promise.all([
    readDocument(expression.id, legislationPublicReadDb, "search"),
    readPreview({
      documentId: expression.id,
      anchor: section.anchor,
      citedAnchor: undefined,
      legislationDb: legislationPublicReadDb,
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
      country: "CZE",
      title: document.title,
      section: section.section,
      readerUrl:
        preview.url ?? panic("Resolved public-law provision has no reader URL"),
      inForce,
      versionStatus: isInForceOn(inForce.from, inForce.to, today())
        ? "current"
        : "outdated",
      blocks: preview.blocks,
    },
  };
};

const unavailable: LawResolver = async () =>
  await Promise.resolve({ status: "country_unavailable" });

const LAW_RESOLVERS = {
  AUT: unavailable,
  CZE: resolveCzechLaw,
  EU: unavailable,
  GBR: unavailable,
  HUN: unavailable,
  POL: unavailable,
  SVK: unavailable,
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
