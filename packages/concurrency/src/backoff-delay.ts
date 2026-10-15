import { panic } from "better-result";

type BackoffJitter =
  | {
      type: "full";
      random: number;
      minMs?: number;
      rounding?: "floor";
    }
  | {
      type: "additive";
      random: number;
      rangeMs: number;
      rounding?: "floor";
    }
  | {
      type: "multiplicative";
      random: number;
      minFactor: number;
      maxFactor: number;
    };

type BackoffDelayOptions = {
  baseMs: number;
  factor?: number;
  maxMs?: number;
  jitter?: BackoffJitter;
};

/**
 * The attempt is a zero-based exponent; callers own attempt numbering and clamps.
 * Full jitter caps its range first; additive/multiplicative jitter caps the result.
 */
export const backoffDelay = (
  attempt: number,
  {
    baseMs,
    factor = 2,
    maxMs = Number.POSITIVE_INFINITY,
    jitter,
  }: BackoffDelayOptions,
): number => {
  const delay = baseMs * factor ** attempt;
  if (jitter === undefined) {
    return Math.min(delay, maxMs);
  }
  switch (jitter.type) {
    case "full": {
      const ceiling = Math.min(delay, maxMs);
      const spread =
        jitter.minMs === undefined
          ? jitter.random * ceiling
          : jitter.random * (ceiling - jitter.minMs);
      const rounded = jitter.rounding === "floor" ? Math.floor(spread) : spread;
      return jitter.minMs === undefined ? rounded : jitter.minMs + rounded;
    }
    case "additive": {
      const spread = jitter.random * jitter.rangeMs;
      return Math.min(
        delay + (jitter.rounding === "floor" ? Math.floor(spread) : spread),
        maxMs,
      );
    }
    case "multiplicative": {
      return Math.min(
        delay *
          (jitter.minFactor +
            jitter.random * (jitter.maxFactor - jitter.minFactor)),
        maxMs,
      );
    }
    default: {
      jitter satisfies never;
      return panic("Unknown backoff jitter policy");
    }
  }
};
