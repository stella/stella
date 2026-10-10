/** Explicit temporal statements in the cited text; absence never selects a date. */
export const APPLIED_VERSION_BASES = [
  "stated_version",
  "stated_date",
  "not_stated",
] as const;
export const VERSION_EVIDENCE_KINDS = [
  "stated_version",
  "stated_date",
  "inferred",
] as const;
export const STATED_DATE_RELATIONS = ["on", "until", "from"] as const;

export type VersionEvidence = {
  start: number;
  end: number;
};

export type AppliedProvisionVersion =
  | {
      type: "stated_date";
      date: string;
      relation: (typeof STATED_DATE_RELATIONS)[number];
      evidence: VersionEvidence & { kind: "stated_date" };
    }
  | {
      type: "stated_version";
      amendmentWorkIdentifier: string;
      evidence: VersionEvidence & { kind: "stated_version" };
    }
  | { type: "not_stated" };
