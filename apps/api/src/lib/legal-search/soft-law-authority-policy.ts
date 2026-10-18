import { Result } from "better-result";

import {
  type SoftLawAuthority,
  type SoftLawMetadata,
  type SOFT_LAW_KINDS,
  SoftLawItemError,
} from "./soft-law-types";

type KindDisposition =
  | { type: "eligible" }
  | { type: "excluded"; reason: string };
type AuthorityPolicy = {
  expression: "optional" | "required";
  referenceStyle: "literal" | "wp_number";
  identitySeries:
    | { type: "none" }
    | { type: "source-kind"; values: readonly string[] };
  kinds: Record<(typeof SOFT_LAW_KINDS)[number], KindDisposition>;
};

const eligible = { type: "eligible" } as const;
const excluded = {
  type: "excluded",
  reason: "Outside the authority's admitted guidance collection",
} as const;

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
} as const satisfies Record<SoftLawAuthority, AuthorityPolicy>;

/** The persistence boundary refuses incomplete EU expressions, including replayed receipts. */
export const validateSoftLawAuthorityMetadata = (
  authority: SoftLawAuthority,
  metadata: SoftLawMetadata,
  extractionQuality?: "extraction_failed",
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
          ? extractionQuality !== "extraction_failed"
          : !metadata.sourceDocumentId?.trim())) ||
      metadata.expression?.type !== "identified" ||
      !metadata.stage ||
      !metadata.relations)
  ) {
    return Result.err(
      new SoftLawItemError({
        message:
          "EU soft law requires language, revision and lifecycle metadata",
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
