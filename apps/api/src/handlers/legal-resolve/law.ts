import { normalizeCountry } from "@stll/agent-input";
import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";
import {
  isPublicCountry,
  type PublicCountry,
} from "@stll/api-contract/public-country-capability";
import { locateGazetteCitations } from "@stll/legal-atlas/provision-citation-grammars";

import { resolveStatuteExpression } from "@/api/handlers/legislation/by-eli";
import { readPublicLegislationHandler } from "@/api/handlers/legislation/get";
import { readProvisionPreviewHandler } from "@/api/handlers/legislation/provision-preview";
import type { SafeId } from "@/api/lib/branded-types";
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
  resolveExpression?: (
    ...input: Parameters<typeof resolveStatuteExpression>
  ) => Promise<
    | { type: "expression"; id: SafeId<"legislationDocument"> }
    | {
        type: Exclude<
          Awaited<ReturnType<typeof resolveStatuteExpression>>["type"],
          "expression"
        >;
      }
  >;
  readDocument?: (
    ...input: Parameters<typeof readPublicLegislationHandler>
  ) => Promise<{ eli: string; title: string } | object>;
  readPreview?: (
    input: Parameters<typeof readProvisionPreviewHandler>[0],
  ) => Promise<{ blocks: unknown[]; appUrl: string } | object>;
};

const readDocumentIdentity = async (
  ...input: Parameters<typeof readPublicLegislationHandler>
): Promise<{ eli: string; title: string } | object> =>
  await readPublicLegislationHandler(...input);

const readPreviewBlocks = async (
  input: Parameters<typeof readProvisionPreviewHandler>[0],
): Promise<{ blocks: unknown[]; appUrl: string } | object> =>
  await readProvisionPreviewHandler(input);

const sectionAnchor = (section: string): string | null => {
  const match = /^(\d+)\s*([a-z])?$/iu.exec(section.trim());
  const number = match?.at(1);
  if (number === undefined) {
    return null;
  }
  return `par_${number}${match?.at(2)?.toLowerCase() ?? ""}`;
};

export const resolveCzechLaw = async (
  input: LawResolveInput,
  {
    resolveExpression = resolveStatuteExpression,
    readDocument = readDocumentIdentity,
    readPreview = readPreviewBlocks,
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
        collection !== undefined &&
        year !== undefined &&
        number !== undefined
      ) {
        eli = `https://www.e-sbirka.cz/eli/cz/${collection}/${year}/${number}`;
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
  const anchor = sectionAnchor(input.section);
  if (anchor === null) {
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
      anchor,
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
  const inForce = input.asOf === undefined;
  return {
    status: "resolved",
    document: {
      identifier: eli,
      country: "CZE",
      metadata: {
        title: document.title,
        url: preview.appUrl,
        inForce,
        versionStatus: inForce ? "current" : "outdated",
      },
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

export const resolveLawCitation = async (
  countryInput: string,
  input: LawResolveInput,
): Promise<LegalResolveResponse> => {
  const normalized = normalizeCountry(countryInput);
  if (!normalized.ok || !isPublicCountry(normalized.value.alpha3)) {
    return { status: "country_unavailable" };
  }
  return await LAW_RESOLVERS[normalized.value.alpha3](input);
};
