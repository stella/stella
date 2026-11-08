import { Result } from "better-result";

import type { GuidanceKind } from "@stll/legal-ast/document-kind";

import {
  isTextlessExtraction,
  type SoftLawAuthority,
  type SoftLawDocumentInput,
  SoftLawItemError,
  type SoftLawMetadata,
} from "./soft-law-types";

type KindDisposition =
  | { type: "eligible" }
  | { type: "excluded"; reason: string }
  /** The publisher served no collection of this kind when last checked. */
  | {
      type: "none-found";
      checkedAt: string;
      evidence: readonly [string, ...string[]];
    };
type AuthorityPolicy = {
  expression: "optional" | "required";
  referenceStyle: "literal" | "wp_number";
  identitySeries:
    { type: "none" } | { type: "source-kind"; values: readonly string[] };
  kinds: Record<GuidanceKind, KindDisposition>;
};

const eligible = { type: "eligible" } as const;
const excluded = {
  type: "excluded",
  reason: "Outside the authority's admitted guidance collection",
} as const;

const UOOU_SK_CHECKED_AT = "2026-10-30";
const UOOU_SK_ORIGIN = "https://dataprotection.gov.sk";
/** The Office's own methodology page states "Dokumenty aktualizujeme." and lists no documents. */
const UOOU_SK_METHODOLOGIES = `${UOOU_SK_ORIGIN}/sk/legislativa-metodiky/metodiky-faq/metodiky-uradu/`;
/** Names methodologies, guidance, recommendations and FAQ; links only the page above and EDPB material. */
const UOOU_SK_METHODOLOGIES_FAQ = `${UOOU_SK_ORIGIN}/sk/legislativa-metodiky/metodiky-faq/`;
/** Every page the publisher serves; none is a decision, opinion, position or FAQ collection. */
const UOOU_SK_SITEMAP = `${UOOU_SK_ORIGIN}/sitemap.xml`;
/** Describes the inspection procedure and plan; publishes no inspection reports. */
const UOOU_SK_INSPECTIONS = `${UOOU_SK_ORIGIN}/sk/urad/kontrola-spracuvania-osobnych-udajov/`;

const pendingPolicy = {
  expression: "required",
  referenceStyle: "literal",
  identitySeries: { type: "none" },
  kinds: {
    methodology: excluded,
    recommendation: excluded,
    opinion: excluded,
    faq: excluded,
    guideline: excluded,
    position: excluded,
    statement: excluded,
    inspection_report: excluded,
    annual_report: excluded,
    other: excluded,
  },
} as const satisfies AuthorityPolicy;

export const SOFT_LAW_AUTHORITY_POLICIES = {
  "cz-uoou": {
    expression: "optional",
    referenceStyle: "literal",
    identitySeries: { type: "none" },
    kinds: {
      methodology: eligible,
      recommendation: eligible,
      opinion: eligible,
      faq: eligible,
      guideline: eligible,
      position: eligible,
      statement: excluded,
      inspection_report: eligible,
      annual_report: eligible,
      other: eligible,
    },
  },
  "eu-edpb": {
    expression: "required",
    referenceStyle: "literal",
    identitySeries: {
      type: "source-kind",
      values: [
        "Guideline",
        "Guidelines",
        "Recommendation",
        "Statement",
        "Opinion of the Board (Art. 64)",
        "Legislative opinion",
        "Adequacy",
      ],
    },
    kinds: {
      methodology: excluded,
      recommendation: eligible,
      opinion: eligible,
      faq: excluded,
      guideline: eligible,
      position: excluded,
      statement: eligible,
      inspection_report: excluded,
      annual_report: excluded,
      other: excluded,
    },
  },
  "eu-wp29": {
    expression: "required",
    referenceStyle: "wp_number",
    identitySeries: { type: "none" },
    kinds: {
      methodology: excluded,
      recommendation: eligible,
      opinion: eligible,
      faq: excluded,
      guideline: eligible,
      position: eligible,
      statement: eligible,
      inspection_report: excluded,
      annual_report: excluded,
      other: excluded,
    },
  },
  "at-dsb": pendingPolicy,
  "be-apd": pendingPolicy,
  "bg-cpdp": pendingPolicy,
  "hr-azop": pendingPolicy,
  "cy-dpa": pendingPolicy,
  "dk-datatilsynet": pendingPolicy,
  "ee-aki": pendingPolicy,
  "fi-ombudsman": pendingPolicy,
  "fr-cnil": pendingPolicy,
  "de-bfdi": {
    expression: "required",
    referenceStyle: "literal",
    identitySeries: { type: "none" },
    kinds: {
      methodology: excluded,
      recommendation: eligible,
      opinion: excluded,
      faq: excluded,
      guideline: excluded,
      position: excluded,
      statement: excluded,
      inspection_report: excluded,
      annual_report: excluded,
      other: excluded,
    },
  },
  "el-hdpa": pendingPolicy,
  "hu-naih": pendingPolicy,
  "is-personuvernd": pendingPolicy,
  "ie-dpc": pendingPolicy,
  "it-garante": pendingPolicy,
  "lv-dvi": pendingPolicy,
  "li-dss": pendingPolicy,
  "lt-vdai": pendingPolicy,
  "lu-cnpd": pendingPolicy,
  "mt-idpc": pendingPolicy,
  "nl-ap": pendingPolicy,
  "no-datatilsynet": pendingPolicy,
  "pl-uodo": pendingPolicy,
  "pt-cnpd": pendingPolicy,
  "ro-anspdcp": pendingPolicy,
  "sk-uoou": {
    expression: "optional",
    referenceStyle: "literal",
    identitySeries: { type: "none" },
    kinds: {
      methodology: {
        type: "none-found",
        checkedAt: UOOU_SK_CHECKED_AT,
        evidence: [UOOU_SK_METHODOLOGIES, UOOU_SK_METHODOLOGIES_FAQ],
      },
      recommendation: {
        type: "none-found",
        checkedAt: UOOU_SK_CHECKED_AT,
        evidence: [UOOU_SK_METHODOLOGIES, UOOU_SK_METHODOLOGIES_FAQ],
      },
      opinion: {
        type: "none-found",
        checkedAt: UOOU_SK_CHECKED_AT,
        evidence: [UOOU_SK_SITEMAP, UOOU_SK_METHODOLOGIES_FAQ],
      },
      faq: {
        type: "none-found",
        checkedAt: UOOU_SK_CHECKED_AT,
        evidence: [UOOU_SK_METHODOLOGIES_FAQ, UOOU_SK_SITEMAP],
      },
      guideline: {
        type: "none-found",
        checkedAt: UOOU_SK_CHECKED_AT,
        evidence: [UOOU_SK_METHODOLOGIES, UOOU_SK_METHODOLOGIES_FAQ],
      },
      position: {
        type: "none-found",
        checkedAt: UOOU_SK_CHECKED_AT,
        evidence: [UOOU_SK_SITEMAP],
      },
      statement: {
        type: "excluded",
        reason:
          "The news listing mixes press releases, relayed EDPB statements and vacancy notices; it is not a guidance collection.",
      },
      inspection_report: {
        type: "none-found",
        checkedAt: UOOU_SK_CHECKED_AT,
        evidence: [UOOU_SK_INSPECTIONS, UOOU_SK_SITEMAP],
      },
      annual_report: eligible,
      other: {
        type: "excluded",
        reason:
          "The glossary, model forms, training links and court-decision compilations are explanatory or third-party material, not issued guidance.",
      },
    },
  },
  "si-ip": pendingPolicy,
  "es-aepd": pendingPolicy,
  "se-imy": pendingPolicy,
  "eu-edps": pendingPolicy,
  "de-dsk": pendingPolicy,
  "de-bw": pendingPolicy,
  "de-by-baylfd": pendingPolicy,
  "de-by-baylda": pendingPolicy,
  "de-be": pendingPolicy,
  "de-bb": pendingPolicy,
  "de-hb": pendingPolicy,
  "de-hh": pendingPolicy,
  "de-he": pendingPolicy,
  "de-mv": pendingPolicy,
  "de-ni": pendingPolicy,
  "de-nw": pendingPolicy,
  "de-rp": pendingPolicy,
  "de-sl": pendingPolicy,
  "de-sn": pendingPolicy,
  "de-st": pendingPolicy,
  "de-sh": pendingPolicy,
  "de-th": pendingPolicy,
  "es-apdcat": pendingPolicy,
  "es-avpd": pendingPolicy,
  "es-ctpd": pendingPolicy,
  "at-pdk": pendingPolicy,
  "be-vtc": pendingPolicy,
  "be-coc": pendingPolicy,
  "be-comitei": pendingPolicy,
  "be-comitep": pendingPolicy,
} as const satisfies Record<SoftLawAuthority, AuthorityPolicy>;

/** The persistence boundary refuses incomplete authority expressions, including replayed receipts. */
export const validateSoftLawAuthorityMetadata = (
  authority: SoftLawAuthority,
  metadata: SoftLawMetadata,
  extraction?: Pick<SoftLawDocumentInput, "extractionQuality" | "text">,
) => {
  const policy = SOFT_LAW_AUTHORITY_POLICIES[authority];
  if (policy.kinds[metadata.kind].type !== "eligible") {
    return Result.err(
      new SoftLawItemError({
        message:
          "Document kind is outside this authority's admitted collection",
        tag: "invalid_document",
      }),
    );
  }
  if (
    policy.expression === "required" &&
    (!metadata.sourceKind?.trim() ||
      (metadata.statedReference.state !== "stated" &&
        (policy.referenceStyle === "wp_number"
          ? !extraction ||
            !isTextlessExtraction(extraction.text, extraction.extractionQuality)
          : !metadata.sourceDocumentId?.trim())) ||
      metadata.expression?.type !== "identified" ||
      !metadata.stage ||
      !metadata.relations)
  ) {
    return Result.err(
      new SoftLawItemError({
        message:
          "This authority requires language, revision and lifecycle metadata",
        tag: "invalid_document",
      }),
    );
  }
  if (
    policy.identitySeries.type === "source-kind" &&
    metadata.sourceKind &&
    !policy.identitySeries.values.some((value) => value === metadata.sourceKind)
  ) {
    return Result.err(
      new SoftLawItemError({
        message: "Document source kind is outside the identity series",
        tag: "invalid_document",
      }),
    );
  }
  return Result.ok();
};
