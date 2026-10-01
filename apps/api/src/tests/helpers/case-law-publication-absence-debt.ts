import {
  DECISION_PUBLICATION_FIELD_KEYS,
  type DecisionPublicationFieldKey,
} from "@stll/api-contract/case-law-text-field";

import type { SourceRegistrationKey } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";

type PublicationAbsenceDebt = {
  readonly field: DecisionPublicationFieldKey;
  readonly condition: "always" | "not_stated";
  readonly reason: string;
};

const unclassified = DECISION_PUBLICATION_FIELD_KEYS.map(
  (field) =>
    ({
      field,
      condition: "always",
      reason:
        "The adapter retains the value but emits no publisher absence status for this field.",
    }) as const,
);

// Closed adapter cohort: adding a source or removing a marker requires an explicit debt decision.
// Entries may be deleted as publisher availability becomes observable; the baseline never grows.
export const TYPED_ABSENCE_DEBT = {
  "cz-regional": unclassified,
  "cz-ns": unclassified,
  "cz-nss": unclassified,
  "cz-us": unclassified,
  "sk-courts": unclassified.filter(({ field }) => field !== "sourceUrl"),
  "sk-us": [
    ...unclassified.filter(({ field }) => field !== "ecli"),
    {
      field: "ecli",
      condition: "not_stated",
      reason:
        "An omitted mkECLI states no publication reason; null and omitted keys are distinct.",
    },
  ],
  "pl-courts": unclassified,
  "pl-sn": unclassified,
  "pl-kio": unclassified,
  "pl-tk": unclassified,
  "pl-nsa": unclassified,
  "pl-ncourt": unclassified,
  "at-courts": unclassified,
  "at-vfgh": unclassified,
  "at-vwgh": unclassified,
  "at-bvwg": unclassified,
  "at-lvwg": unclassified,
  "at-asylgh": unclassified,
  "at-ubas": unclassified,
  "at-uvs": unclassified,
  "at-verg": unclassified,
  "at-umse": unclassified,
  "at-bks": unclassified,
  "at-findok": unclassified,
  "eu-ecj": unclassified,
  "hu-bhgy": unclassified,
  "pl-kis": unclassified,
  "pl-uodo": unclassified,
  "pl-uokik": unclassified,
  "us-courtlistener": unclassified,
} as const satisfies Record<
  SourceRegistrationKey,
  readonly PublicationAbsenceDebt[]
>;
