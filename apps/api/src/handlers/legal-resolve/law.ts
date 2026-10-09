import { panic } from "better-result";

import { normalizeCountry } from "@stll/agent-input";
import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";
import {
  isPublicCountry,
  type PublicCountry,
} from "@stll/api-contract/public-country-capability";
import {
  locateGazetteCitations,
  PROVISION_CITATION_GRAMMARS,
} from "@stll/legal-atlas/provision-citation-grammars";
import { todayFor } from "@stll/time";

import type { LawReadAdmission } from "@/api/handlers/legal-resolve/admission";
import { resolveStatuteExpression } from "@/api/handlers/legislation/by-eli";
import { readPublicLegislationHandler } from "@/api/handlers/legislation/get";
import { readProvisionPreviewHandler } from "@/api/handlers/legislation/provision-preview";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";

type LawResolveInput = {
  citation?: string | undefined;
  collection?: string | undefined;
  year?: string | undefined;
  number?: string | undefined;
  section?: string | undefined;
  asOf?: string | undefined;
};

type LawResolver = (input: LawResolveInput) => Promise<LegalResolveResponse>;

type CzechLawDependencies = {
  resolveExpression?: typeof resolveStatuteExpression;
  readDocument?: typeof readPublicLegislationHandler;
  readPreview?: typeof readProvisionPreviewHandler;
  today?: () => string;
};

const normalizedSection = (
  section: string,
): { anchor: string; section: string } | null => {
  const match = /^(\d+)\s*([a-z])?$/iu.exec(section.trim());
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
    today = czechToday,
  }: CzechLawDependencies = {},
): Promise<LegalResolveResponse> => {
  const missing: string[] = [];
  let eli: string | undefined;
  if (input.citation !== undefined) {
    eli = locateGazetteCitations(input.citation).find(
      ({ jurisdiction }) => jurisdiction === "CZE",
    )?.eli;
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
  );
  if (expression.type !== "expression") {
    return { status: "not_found", reason: "unknown_document" };
  }
  const [document, preview] = await Promise.all([
    readDocument(expression.id, legislationPublicReadDb),
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
        preview.appUrl ??
        panic("Resolved public-law provision has no reader URL"),
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

export const LAW_RESOLVERS = {
  AUT: unavailable,
  CZE: resolveCzechLaw,
  EU: unavailable,
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
  return await LAW_RESOLVERS[normalized.value.alpha3](input);
};
