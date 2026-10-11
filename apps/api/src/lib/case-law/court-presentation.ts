import { panic, Result } from "better-result";

import {
  courtAbbreviation,
  type CourtAbbreviationInput,
} from "@stll/api-contract/case-law-court-abbreviations";
import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";
import { resolveUsCourt } from "@stll/api-contract/us-courts";

import { courtTierLabel } from "@/api/lib/case-law/court-tiers";
import {
  type CourtWeightMap,
  decisionCourtWeight,
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

/** Name-pattern weights; compiled court directories remain available when this read fails. */
export type CourtRegistry = CourtWeightMap | null;

/**
 * A row whose rank is unavailable carries no abbreviation with this fallback.
 */
const UNRANKED_TIER: CourtTierLabel = "other";

type PresentedDecision = CourtAbbreviationInput & {
  /** The directory court id, where the decision's jurisdiction stores one. */
  courtId: string | null;
};

/** Directory courts carry their publisher's short name without loading it in the browser. */
export const decisionCourtAbbreviation = (
  decision: PresentedDecision,
): string | null => {
  if (decision.country !== "USA") {
    return courtAbbreviation(decision) ?? null;
  }
  const resolved =
    decision.courtId === null ? undefined : resolveUsCourt(decision.courtId);
  if (resolved?.type === "accepted") {
    return resolved.court.shortCode;
  }
  // Graph reads need only the code, but retain the rank owner's invalid-id
  // telemetry even when they do not render a tier.
  decisionCourtWeight(new Map(), decision);
  return null;
};

/**
 * A court the registry could be read for. A directory court whose stored id
 * the directory does not resolve gets no chip, as with no registry: the rank
 * read has already reported it, and its peers are drawn as usual.
 */
const rankedPresentation = (
  courtWeights: CourtWeightMap,
  decision: PresentedDecision,
): CourtPresentation => {
  const rank = decisionCourtWeight(courtWeights, decision);
  switch (rank.type) {
    case "ranked":
      return {
        courtAbbreviation: decisionCourtAbbreviation(decision),
        courtTier: courtTierLabel(rank.tier),
      };
    case "invalid-directory-identity":
      return { courtAbbreviation: null, courtTier: UNRANKED_TIER };
    default:
      rank satisfies never;
      return panic(`Unhandled court rank: ${JSON.stringify(rank)}`);
  }
};

export const courtPresentation = (
  courtWeights: CourtRegistry,
  decision: PresentedDecision,
): CourtPresentation => {
  if (decision.country === "USA") {
    // The compiled directory owns both the name and rank; the DB name-pattern
    // registry may be unavailable without affecting this jurisdiction.
    return rankedPresentation(courtWeights ?? new Map(), decision);
  }
  return courtWeights === null
    ? { courtAbbreviation: null, courtTier: UNRANKED_TIER }
    : rankedPresentation(courtWeights, decision);
};

/**
 * How long a public read waits for the registry before drawing no chip.
 *
 * The loader's own bound is five seconds — half the reader's critical-query
 * budget, spent while the read holds a reader connection. A badge is
 * presentation, so it gets a fraction of that and the read carries on without
 * it. The loader caches for a minute and the call it raced keeps running, so
 * the next read is warm either way.
 */
const REGISTRY_READ_TIMEOUT_MS = 1000;

/**
 * The registry for a read that must survive without it: bounded, and degraded
 * to nothing rather than propagated.
 *
 * Reported every time so the degraded name-pattern ranking remains visible.
 * Compiled directory courts do not depend on this read.
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
      effect: "name_pattern_weights_unavailable",
    });
    return null;
  }
  return registry.value;
};
