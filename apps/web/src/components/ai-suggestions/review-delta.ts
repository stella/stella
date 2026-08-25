/**
 * Temporary mirror of the API-derived delta contract from
 * `.agents/plans/055-review-position-spine.md` (Contracts section). Slice 1
 * (`packages/api-contract`) defines the real type; slice 3's presentation
 * components import this local copy until that lands, then switch over.
 */

export type DeltaCitation = { blockId: string; text: string };

export type DeltaValue = {
  text: string;
  value: number | null;
  unit: string | null;
  citation: DeltaCitation;
};

export type ReviewDelta =
  | {
      kind: "parameter";
      target: DeltaValue | null;
      standard: DeltaValue | null;
    }
  | {
      kind: "enumeration";
      items: {
        label: string;
        inTarget: boolean;
        inStandard: boolean;
        citation: DeltaCitation | null;
      }[];
    }
  | { kind: "presence"; term: string; inTarget: boolean; inStandard: boolean }
  | { kind: "language" };

export type ReviewImpact =
  | "favourable"
  | "unfavourable"
  | "neutral"
  | "unknown";
