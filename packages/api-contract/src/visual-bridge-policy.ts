import { panic } from "better-result";
import * as v from "valibot";

import type { GeneratedVisualInput } from "./generated-visual";
import type { VisualGuestMessage } from "./visual-sandbox";

// A view may contain arbitrary JSON. Drill actions are available only for
// the court/year projection named by the bridge contract.
const courtYearsSchema = v.object({
  courtYear: v.object({
    buckets: v.array(
      v.object({
        court: v.string(),
        year: v.pipe(v.number(), v.integer()),
      }),
    ),
  }),
});

type CreateVisualActionGateOptions = {
  data: unknown;
  links: GeneratedVisualInput["links"];
  literalLinks: readonly string[];
  now: () => number;
};

export const createVisualActionGate = ({
  data,
  links,
  literalLinks,
  now,
}: CreateVisualActionGateOptions) => {
  const decisionLinks = new Set((links ?? []).map(({ id }) => id));
  const externalLinks = new Set(literalLinks);
  const yearsByCourt = new Map<string, Set<number>>();
  const projection = v.safeParse(courtYearsSchema, data);
  if (projection.success) {
    for (const { court, year } of projection.output.courtYear.buckets) {
      let years = yearsByCourt.get(court);
      if (!years) {
        years = new Set();
        yearsByCourt.set(court, years);
      }
      years.add(year);
    }
  }
  let lastDrill = Number.NEGATIVE_INFINITY;
  return (message: VisualGuestMessage) => {
    switch (message.kind) {
      case "resize":
      case "ready":
        return true;
      case "open-link":
        return externalLinks.has(message.url);
      case "open-internal":
        return decisionLinks.has(message.linkId);
      case "drill": {
        if (!yearsByCourt.get(message.court)?.has(message.year)) {
          return false;
        }
        const current = now();
        if (current - lastDrill < 1000) {
          return false;
        }
        lastDrill = current;
        return true;
      }
      default: {
        message satisfies never;
        return panic("Unhandled visual bridge message kind");
      }
    }
  };
};
