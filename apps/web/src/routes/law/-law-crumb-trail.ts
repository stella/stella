import { useMatches } from "@tanstack/react-router";
import { panic } from "better-result";

import type { FileRoutesById } from "@/routeTree.gen";

import {
  decisionLawCrumbTrailOf,
  statuteLawCrumbTrailOf,
} from "./-law-crumb-trail.logic";
import type { LawCrumbTrail } from "./-law-crumb-trail.logic";

// Reader routes have a document slug; deriving the census from the generated
// router makes a new reader require a producer instead of silently losing chrome.
type LawReaderRouteId = Extract<
  keyof FileRoutesById,
  `/law/${string}/$slug${string}`
>;
type TrailProducers = {
  [Id in LawReaderRouteId]: (
    data: FileRoutesById[Id]["types"]["loaderData"],
  ) => LawCrumbTrail;
};

export const LAW_CRUMB_TRAIL_PRODUCERS = {
  "/law/$country/statutes/$slug/": ({ statute, work }) =>
    statuteLawCrumbTrailOf(statute ?? work),
  "/law/$country/statutes/$slug/v/$version": ({ statute, work }) =>
    statuteLawCrumbTrailOf(statute ?? work),
  "/law/$country/cases/$court/$slug": decisionLawCrumbTrailOf,
  "/law/$country/cases/$court/$language/$slug": decisionLawCrumbTrailOf,
} as const satisfies TrailProducers;

const isLawReaderMatch = <Match extends { routeId: string }>(
  match: Match,
): match is Extract<Match, { routeId: LawReaderRouteId }> =>
  Object.hasOwn(LAW_CRUMB_TRAIL_PRODUCERS, match.routeId);

export const useLawCrumbTrail = () =>
  useMatches({
    select: (matches): LawCrumbTrail | null => {
      const match = matches.at(-1);
      if (match?.loaderData === undefined || !isLawReaderMatch(match)) {
        return null;
      }
      switch (match.routeId) {
        case "/law/$country/statutes/$slug/":
          return LAW_CRUMB_TRAIL_PRODUCERS[match.routeId](match.loaderData);
        case "/law/$country/statutes/$slug/v/$version":
          return LAW_CRUMB_TRAIL_PRODUCERS[match.routeId](match.loaderData);
        case "/law/$country/cases/$court/$slug":
          return LAW_CRUMB_TRAIL_PRODUCERS[match.routeId](match.loaderData);
        case "/law/$country/cases/$court/$language/$slug":
          return LAW_CRUMB_TRAIL_PRODUCERS[match.routeId](match.loaderData);
        default:
          match satisfies never;
          return panic("Law reader has no trail accessor branch");
      }
    },
  });
