export const SOFT_LAW_KINDS = [
  "methodology",
  "recommendation",
  "opinion",
  "faq",
  "guideline",
  "position",
  "statement",
  "inspection_report",
  "annual_report",
  "other",
] as const;
export const SOFT_LAW_VALIDITY_STATES = [
  "not_stated",
  "withdrawn",
  "superseded",
  "historical_repealed_basis",
] as const;
export const SOFT_LAW_STATED_STATES = ["stated", "not_stated"] as const;
export const SOFT_LAW_AUTHORITIES = {
  "cz-uoou": { jurisdiction: "CZE", name: "Úřad pro ochranu osobních údajů" },
  "eu-edpb": { jurisdiction: "EU", name: "European Data Protection Board" },
  "eu-wp29": { jurisdiction: "EU", name: "Article 29 Working Party" },
} as const;
export type SoftLawAuthority = keyof typeof SOFT_LAW_AUTHORITIES;
export type SoftLawStated<T> =
  | { state: "stated"; value: T }
  | { state: "not_stated" };
export type SoftLawEvidence = {
  url: string;
  quote: string;
  locator: string;
};
export type SoftLawExpression =
  | { type: "unspecified" }
  | {
      type: "identified";
      language: string;
      revision: SoftLawStated<string>;
    };
export type SoftLawKind = (typeof SOFT_LAW_KINDS)[number];
export type SoftLawValidityState = (typeof SOFT_LAW_VALIDITY_STATES)[number];
