import { describe, expect, test } from "bun:test";

import {
  extractCaseLawDecisionIdFromIdRouteParam,
  parseCaseLawDecisionPath,
} from "@stll/api-contract/case-law-decision-route";
import scenarios from "@stll/playwright-tools/marketing-case-law.json" with { type: "json" };

import {
  getMarketingDecisionPaths,
  MarketingDecisionPathError,
} from "../marketing/case-law-reader";

const response = () => ({
  global: scenarios.map((scenario, index) => ({
    id: `thread-${String(index)}`,
    title: `Case review · ${scenario.caseNumber}`,
    decision: {
      type: "present",
      badge: {
        id: `12345678-1234-4234-8234-${String(index).padStart(12, "0")}`,
        caseNumber: scenario.caseNumber,
        country: scenario.country,
        court: "Nejvyšší soud",
        courtAbbreviation: "NS",
        courtTier: "supreme",
        decisionDate: "2022-01-15",
        language: scenario.language,
        languageAlternates: [
          { language: scenario.language },
          { language: "en" },
        ],
        slug: `stored-decision-${String(index)}`,
      },
    },
  })),
  workspaces: [],
});

describe("marketing readers resolve from publicly available thread badges", () => {
  test("resolves every shared scenario with its stored slug and language alternates", () => {
    const payload = response();
    const paths = getMarketingDecisionPaths(payload);
    expect(paths.size).toBe(scenarios.length);
    for (const {
      decision: { badge },
    } of payload.global) {
      const pathname = paths.get(badge.caseNumber);
      expect(pathname).toBeDefined();
      const route = parseCaseLawDecisionPath(pathname ?? "");
      expect(route).toEqual({
        country: badge.country.toLowerCase(),
        court: "nejvyssi-soud",
        language: badge.language,
        slug: badge.slug,
      });
    }
  });

  test("preserves the decision id when a stored slug is absent", () => {
    const payload = response();
    const first = payload.global.at(0);
    expect(first).toBeDefined();
    if (first === undefined) {
      throw new MarketingDecisionPathError({
        message: "Test fixture has no decision",
      });
    }
    const global = payload.global.map((thread) => ({
      ...thread,
      decision: {
        ...thread.decision,
        badge: { ...thread.decision.badge, slug: null },
      },
    }));
    const pathname = getMarketingDecisionPaths({ ...payload, global }).get(
      first.decision.badge.caseNumber,
    );
    const route = parseCaseLawDecisionPath(pathname ?? "");
    expect(extractCaseLawDecisionIdFromIdRouteParam(route?.slug ?? "")).toBe(
      first.decision.badge.id,
    );
  });

  test("rejects an empty response instead of retaining old reader images", () => {
    expect(() =>
      getMarketingDecisionPaths({ global: [], workspaces: [] }),
    ).toThrow(MarketingDecisionPathError);
    expect(() =>
      getMarketingDecisionPaths({ global: [], workspaces: [] }),
    ).toThrow("received 0");
  });

  test("rejects a missing or wrong-language scenario", () => {
    const payload = response();
    expect(() =>
      getMarketingDecisionPaths({
        ...payload,
        global: payload.global.slice(1),
      }),
    ).toThrow("received 0");
    expect(() =>
      getMarketingDecisionPaths({
        ...payload,
        global: payload.global.map((thread) => ({
          ...thread,
          decision: {
            ...thread.decision,
            badge: { ...thread.decision.badge, language: "en" },
          },
        })),
      }),
    ).toThrow("received 0");
  });

  test("rejects unavailable badges", () => {
    expect(() =>
      getMarketingDecisionPaths({
        global: [{ decision: { type: "unavailable" } }],
      }),
    ).toThrow("badges are unavailable");
  });

  test("resolves when several threads reference the same decision", () => {
    const payload = response();
    const paths = getMarketingDecisionPaths({
      ...payload,
      global: [
        ...payload.global,
        ...payload.global.map((thread) => ({
          ...thread,
          id: `${thread.id}-2`,
        })),
      ],
    });
    expect(paths).toEqual(getMarketingDecisionPaths(payload));
  });

  test("rejects different decisions matching one scenario", () => {
    const payload = response();
    const [first] = payload.global;
    if (first === undefined) {
      throw new Error("missing fixture thread");
    }
    expect(() =>
      getMarketingDecisionPaths({
        ...payload,
        global: [
          ...payload.global,
          {
            ...first,
            id: "other-thread",
            decision: {
              ...first.decision,
              badge: {
                ...first.decision.badge,
                id: "12345678-1234-4234-8234-999999999999",
              },
            },
          },
        ],
      }),
    ).toThrow("received 2");
  });

  test("rejects malformed route metadata", () => {
    expect(() =>
      getMarketingDecisionPaths({
        global: [{ decision: { type: "present", badge: { id: "broken" } } }],
      }),
    ).toThrow("response is malformed");
  });
});
