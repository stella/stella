import type { DecisionModelProvider } from "@/api/lib/ai-config";

/** Input-only USD rates per million tokens; output is included. */
const DECISION_INPUT_PRICES = {
  typesafe: { global: 0.042, eu: 0.042 },
  openai: { global: 0.1, eu: 0.11 },
} as const satisfies Record<
  DecisionModelProvider,
  Record<"eu" | "global", number>
>;

type DecisionPriceOptions = {
  provider: DecisionModelProvider;
  region?: "eu" | "global" | undefined;
};

export const decisionPrice = ({ provider, region }: DecisionPriceOptions) => {
  const inputRate =
    DECISION_INPUT_PRICES[provider][
      region ?? (provider === "openai" ? "eu" : "global")
    ];
  return {
    usdPerInputToken: inputRate / 1_000_000,
    microUnitsPerMillionInputTokens: Math.round(inputRate * 100_000),
  };
};

/**
 * What a decision is for, which sets how sure the model must be. `verdict`
 * replaces a generative model's claim verdict, so it asks for more than a
 * first-pass classification does.
 */
export type DecisionConfidencePurpose = "default" | "polarity" | "verdict";

const JEV_FLOORS = {
  default: 0.6,
  polarity: 0.7,
  verdict: 0.8,
} as const satisfies Record<DecisionConfidencePurpose, number>;

/** Floors are calibrated per model. Luna starts conservatively until evaluated. */
export const decisionConfidenceFloor = (
  model: string,
  purpose: DecisionConfidencePurpose = "default",
): number => {
  if (model === "jev" || model.startsWith("jev-")) {
    return JEV_FLOORS[purpose];
  }
  // Luna and uncalibrated model ids use the conservative floor.
  return 0.8;
};
