import { panic } from "better-result";

import type {
  InferredProvisionVersionCandidate,
  ProvisionVersionBasis,
} from "@stll/api-contract/provision-version-basis";
import {
  DECISION_DATE_VERSION_BASIS,
  provisionVersionAsOf,
} from "@stll/api-contract/provision-version-basis";

import { caseLawProvisionCitations } from "@/api/db/schema";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

/** Shared by both citation reads, so their temporal projections stay identical. */
export const PROVISION_VERSION_COLUMNS = {
  appliedVersionBasis: caseLawProvisionCitations.appliedVersionBasis,
  appliedVersionDate: caseLawProvisionCitations.appliedVersionDate,
  appliedVersionDateRelation:
    caseLawProvisionCitations.appliedVersionDateRelation,
  appliedVersionAmendmentWorkIdentifier:
    caseLawProvisionCitations.appliedVersionAmendmentWorkIdentifier,
  appliedVersionExpressionDate:
    caseLawProvisionCitations.appliedVersionExpressionDate,
  appliedVersionExpressionEli:
    caseLawProvisionCitations.appliedVersionExpressionEli,
  versionEvidenceStart: caseLawProvisionCitations.versionEvidenceStart,
  versionEvidenceEnd: caseLawProvisionCitations.versionEvidenceEnd,
  versionEvidenceKind: caseLawProvisionCitations.versionEvidenceKind,
};

type VersionRow = Pick<
  typeof caseLawProvisionCitations.$inferSelect,
  keyof typeof PROVISION_VERSION_COLUMNS | "versionValidFrom"
>;

const statedBasis = (row: VersionRow): ProvisionVersionBasis => {
  const expression =
    row.appliedVersionExpressionDate === null
      ? null
      : {
          date: row.appliedVersionExpressionDate,
          eli:
            row.appliedVersionExpressionEli ??
            panic("Applied version expression has no ELI"),
        };
  switch (row.appliedVersionBasis) {
    case null:
      return DECISION_DATE_VERSION_BASIS;
    case "not_stated":
      return { type: "not_stated" };
    case "stated_date":
      return {
        type: "stated_date",
        date: row.appliedVersionDate ?? panic("Stated version date is absent"),
        relation:
          row.appliedVersionDateRelation ??
          panic("Stated version date relation is absent"),
        expression,
        evidence: {
          kind: "stated_date",
          start:
            row.versionEvidenceStart ??
            panic("Stated version evidence is absent"),
          end:
            row.versionEvidenceEnd ??
            panic("Stated version evidence is absent"),
        },
      };
    case "stated_version":
      return {
        type: "stated_version",
        amendmentWorkIdentifier:
          row.appliedVersionAmendmentWorkIdentifier ??
          panic("Stated amendment is absent"),
        expression,
        evidence: {
          kind: "stated_version",
          start:
            row.versionEvidenceStart ??
            panic("Stated version evidence is absent"),
          end:
            row.versionEvidenceEnd ??
            panic("Stated version evidence is absent"),
        },
      };
    default: {
      row.appliedVersionBasis satisfies never;
      return panic("Unknown applied version basis");
    }
  }
};

export const projectProvisionVersion = <TRow extends VersionRow>(row: TRow) => {
  const {
    appliedVersionBasis: _appliedVersionBasis,
    appliedVersionDate: _appliedVersionDate,
    appliedVersionDateRelation: _appliedVersionDateRelation,
    appliedVersionAmendmentWorkIdentifier:
      _appliedVersionAmendmentWorkIdentifier,
    appliedVersionExpressionDate: _appliedVersionExpressionDate,
    appliedVersionExpressionEli: _appliedVersionExpressionEli,
    versionEvidenceStart: _versionEvidenceStart,
    versionEvidenceEnd: _versionEvidenceEnd,
    versionEvidenceKind: _versionEvidenceKind,
    versionValidFrom,
    ...rest
  } = row;
  const versionBasis = statedBasis(row);
  return {
    ...rest,
    versionBasis,
    // The shared selection owns this field, so new rows never carry an inferred date here.
    versionValidFrom: provisionVersionAsOf(
      { versionBasis, versionValidFrom },
      null,
    ),
    inferredVersionCandidate: {
      type: "inferred",
      kind: "decision_date",
      versionValidFrom,
    } as const satisfies InferredProvisionVersionCandidate,
  };
};

type ProvisionCitationRow = typeof caseLawProvisionCitations.$inferSelect;
type ProvisionVersionProjection = ReturnType<
  typeof projectProvisionVersion<ProvisionCitationRow>
>;

type ProvisionVersionProjectionRow = ProvisionCitationRow &
  Pick<ProvisionVersionProjection, "versionBasis" | "inferredVersionCandidate">;
// The raw temporal inputs selected in PROVISION_VERSION_COLUMNS are folded
// into `versionBasis` and its evidence instead of reaching the client as
// independent fields.
type MissingProvisionCitationProjectionColumn = UnprojectedColumns<
  ProvisionVersionProjectionRow,
  ProvisionVersionProjection,
  keyof typeof PROVISION_VERSION_COLUMNS
>;
type UnexpectedProvisionCitationProjectionColumn = UnbackedProjectionKeys<
  ProvisionVersionProjectionRow,
  ProvisionVersionProjection,
  keyof typeof PROVISION_VERSION_COLUMNS
>;

true satisfies MissingProvisionCitationProjectionColumn extends never
  ? true
  : never;
true satisfies UnexpectedProvisionCitationProjectionColumn extends never
  ? true
  : never;
