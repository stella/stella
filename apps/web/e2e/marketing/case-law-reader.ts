import { panic, TaggedError } from "better-result";
import * as v from "valibot";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import type { MarketingCaseLawScenario } from "@stll/playwright-tools/marketing-case-law";

export class MarketingDecisionPathError extends TaggedError(
  "MarketingDecisionPathError",
)<{ message: string }> {}

const decisionBadgeSchema = v.object({
  caseNumber: v.string(),
  country: v.string(),
  court: v.string(),
  id: v.pipe(v.string(), v.uuid()),
  language: v.nullable(v.string()),
  languageAlternates: v.array(v.object({ language: v.string() })),
  slug: v.nullable(v.string()),
});

const threadListSchema = v.object({
  global: v.array(
    v.object({
      decision: v.nullable(
        v.variant("type", [
          v.object({ type: v.literal("present"), badge: decisionBadgeSchema }),
          v.object({ type: v.literal("unavailable") }),
        ]),
      ),
    }),
  ),
});

/** Resolve the seeded readers from public badges, without visiting search. */
export const getMarketingDecisionPaths = (
  payload: unknown,
  scenarios: readonly MarketingCaseLawScenario[],
) => {
  const parsed = v.safeParse(threadListSchema, payload);
  if (!parsed.success) {
    throw new MarketingDecisionPathError({
      message: "Marketing decision thread response is malformed",
    });
  }
  const badges = parsed.output.global.flatMap(({ decision }) => {
    if (decision === null) {
      return [];
    }
    switch (decision.type) {
      case "present":
        return [decision.badge];
      case "unavailable":
        // An unrelated conversation's badge; a required decision that is
        // missing is reported by the scenario matching below.
        return [];
      default:
        decision satisfies never;
        return panic("Marketing decision badge has an unknown state");
    }
  });
  return new Map(
    scenarios.map((scenario) => {
      // Several conversations may reference one decision; only different
      // decisions make a scenario ambiguous.
      const matches = [
        ...new Map(
          badges
            .filter(
              (badge) =>
                badge.caseNumber === scenario.caseNumber &&
                badge.country === scenario.country &&
                badge.language === scenario.language,
            )
            .map((badge) => [badge.id, badge] as const),
        ).values(),
      ];
      if (matches.length !== 1) {
        throw new MarketingDecisionPathError({
          message: `${scenario.caseNumber}: expected one marketing decision badge, received ${String(matches.length)}`,
        });
      }
      const badge = matches.at(0);
      if (badge === undefined) {
        throw new MarketingDecisionPathError({
          message: `${scenario.caseNumber}: marketing decision badge is missing`,
        });
      }
      const route = createCaseLawDecisionRouteParams({
        caseNumber: badge.caseNumber,
        country: badge.country,
        court: badge.court,
        decisionId: badge.id,
        language: badge.language,
        languageAlternates: badge.languageAlternates,
        slug: badge.slug,
      });
      return [scenario.caseNumber, createCaseLawDecisionPath(route)] as const;
    }),
  );
};
