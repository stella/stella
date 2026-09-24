import { Result } from "better-result";

import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";

import {
  courtAbbreviation,
  type CourtAbbreviationInput,
} from "@/api/lib/case-law/court-abbreviations";
import {
  courtTierLabelFromMap,
  type CourtWeightMap,
} from "@/api/lib/case-law/court-weights";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { withTimeout } from "@/api/lib/with-timeout";

/**
 * What a public surface needs to draw a court beside its name: the short form
 * a lawyer writes it as, and how high it stands.
 *
 * Both are derived here rather than by each surface, so the chip on a search
 * hit, on a decision page and in the corpus status is the same chip. The tier
 * travels with the abbreviation because it is what the chip is drawn from — a
 * client deriving the tier from the abbreviation would be a second, silently
 * drifting reading of the court registry.
 *
 * A null abbreviation is a court nothing states one for: there is no chip to
 * draw, and the court name already carries the meaning on its own.
 */
export type CourtPresentation = {
  courtAbbreviation: string | null;
  courtTier: CourtTierLabel;
};

/** The court registry, or nothing when the read that answers for it did not. */
export type CourtRegistry = CourtWeightMap | null;

/**
 * The tier a row reports when no registry could be read. It is never drawn:
 * the abbreviation is null in that case, so the client has no chip to weight.
 */
const UNRANKED_TIER: CourtTierLabel = "other";

export const courtPresentation = (
  courtWeights: CourtRegistry,
  decision: CourtAbbreviationInput,
): CourtPresentation =>
  // No registry, no chip. The alternative is a badge drawn at the bottom of a
  // scale nobody could read, which would show the Supreme Court as a district
  // one — a wrong answer where the honest one is silence, since the court's
  // name is beside it either way.
  courtWeights === null
    ? { courtAbbreviation: null, courtTier: UNRANKED_TIER }
    : {
        courtAbbreviation: courtAbbreviation(decision) ?? null,
        courtTier: courtTierLabelFromMap(
          courtWeights,
          decision.court,
          decision.country,
        ),
      };

/**
 * How long a public read waits for the registry before drawing no chip.
 *
 * The registry lives on the root pool, which a public read otherwise never
 * touches, and the loader's own bound is five seconds — half the reader's
 * critical-query budget, spent inside the transaction that holds a reader
 * connection. A badge is presentation, so it gets a fraction of that and the
 * read carries on without it. The loader caches for a minute and the call it
 * raced keeps running, so the next read is warm either way.
 */
const REGISTRY_READ_TIMEOUT_MS = 1000;

/**
 * The registry for a read that must survive without it: bounded, and degraded
 * to nothing rather than propagated.
 *
 * Reported every time, because a registry that stops answering takes every
 * court badge off the public surface at once and nothing else would say so.
 */
export const readCourtRegistry = async (
  read: () => Promise<CourtWeightMap>,
): Promise<CourtRegistry> => {
  const registry = await Result.tryPromise({
    try: async () =>
      await withTimeout(async () => await read(), {
        label: "court-presentation-registry-read",
        timeoutMs: REGISTRY_READ_TIMEOUT_MS,
      }),
    catch: (cause: unknown) => cause,
  });
  if (Result.isError(registry)) {
    logger.warn("case_law.court_presentation.registry_unavailable", {
      "error.type": errorTag(registry.error),
      effect: "no_court_badge",
    });
    return null;
  }
  return registry.value;
};
