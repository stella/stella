/**
 * models.dev publishes USD prices per one million tokens. Stella stores the
 * same rates as integer ledger units so usage arithmetic never depends on
 * floating point values.
 */
export const MODEL_RATE_UNITS_PER_USD = 100_000;

export type ModelRateAmounts = {
  /** Normalized ledger units per 1M input tokens. */
  inputPerMTok: number;
  /** Normalized ledger units per 1M output tokens. */
  outputPerMTok: number;
  /**
   * Normalized ledger units per 1M cached input tokens, when the provider
   * offers a cache-read adjustment. Falls back to `inputPerMTok` when absent.
   */
  cachedInputPerMTok?: number;
  /**
   * Normalized ledger units per 1M tokens written to a prompt cache. Falls
   * back to `inputPerMTok` when absent.
   */
  cachedWriteInputPerMTok?: number;
};

/**
 * A discriminated rate schedule. Consumers resolve the schedule from the
 * request's total input tokens before reading any prices, so a model with a
 * long-context premium cannot accidentally be metered at its base rate.
 */
export type ModelRate =
  | ({ kind: "flat" } & ModelRateAmounts)
  | {
      kind: "input-token-tiered";
      /** The base tier applies at or below this total input-token count. */
      inputTokenThreshold: number;
      standard: ModelRateAmounts;
      /** Applies to the entire request once input exceeds the threshold. */
      aboveThreshold: ModelRateAmounts;
    };

export const getStandardModelRate = (rate: ModelRate): ModelRateAmounts =>
  rate.kind === "flat" ? rate : rate.standard;

export const resolveModelRate = (
  rate: ModelRate,
  inputTokens: number,
): ModelRateAmounts =>
  rate.kind === "input-token-tiered" && inputTokens > rate.inputTokenThreshold
    ? rate.aboveThreshold
    : getStandardModelRate(rate);
