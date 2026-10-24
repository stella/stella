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
  { type: "eligible" } | { type: "excluded"; reason: string };
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
  "de-bfdi": pendingPolicy,
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
  "sk-uoou": pendingPolicy,
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
  if (policy.kinds[metadata.kind].type === "excluded") {
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
