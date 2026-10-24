/** A publisher assertion, distinct from a derived lifecycle or validity window. */
export type LegislationPublisherInForceEvidence =
  | { status: "stated"; value: boolean; locator: string }
  | { status: "not-stated"; locator: string };

export type LegislationPublisherDateMeaning =
  | {
      type:
        | "publication"
        | "adoption"
        | "entry-into-force"
        | "applicability"
        | "end-of-validity";
    }
  | { type: "other"; publisherCode: string };

export type LegislationPublisherDateScope =
  | { type: "work" }
  | { type: "provision"; rawLocator: string };

/**
 * The lexical value survives normalization failures and publisher sentinels.
 * A work-level date alone does not establish every provision's applicability.
 */
export type LegislationPublisherDateEvidence = {
  meaning: LegislationPublisherDateMeaning;
  lexicalValue: string;
  normalizedDate: string | null;
  scope: LegislationPublisherDateScope;
  /** Publisher resource, field path, or other source locator for this assertion. */
  locator: string;
  annotation?: string;
  language?: string;
};

export type LegislationPublisherEvidence = {
  inForce: LegislationPublisherInForceEvidence;
  dates: readonly LegislationPublisherDateEvidence[];
};
