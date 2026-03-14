import { Result } from "better-result";
/**
 * Live smoke test for the CJEU adapter.
 *
 * Hits real Cellar SPARQL + EUR-Lex endpoints to verify
 * upstream APIs haven't changed. Run daily in CI via
 * `bun test --test-name-pattern smoke`.
 *
 * Skipped unless SMOKE_TEST=1 is set (to avoid hitting
 * external services on every push).
 */
import { describe, expect, test } from "bun:test";

import { euEcjAdapter } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";

const SKIP = process.env.SMOKE_TEST !== "1";

describe.skipIf(SKIP)("euEcjAdapter smoke (live)", () => {
  test(
    "fetches at least one decision from a known date",
    async () => {
      // 2024-01-18 is known to have ECJ decisions
      const result = await euEcjAdapter.fetchPage("2024-01-18", {});

      if (!Result.isOk(result)) {
        throw new Error(`Expected Ok, got: ${result.error.message}`);
      }
      const page = result.value;

      expect(page.decisions.length).toBeGreaterThan(0);
      expect(page.nextCursor).toBe("2024-01-19");

      // Structural checks on each decision
      for (const d of page.decisions) {
        expect(d.caseNumber).toBeTruthy();
        expect(d.ecli).toMatch(/^ECLI:EU:[CT]:/);
        expect(d.court).toMatch(/^(Court of Justice|General Court)$/);
        expect(d.country).toBe("EU");
        expect(d.language).toMatch(/^[a-z]{2}$/);
        expect(d.decisionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(d.decisionType).toMatch(/^(judgment|order|opinion|unknown)$/);
        expect(d.sourceUrl).toContain("eur-lex");
        expect(d.metadata).toHaveProperty("celex");
        expect(d.rawHash).toHaveLength(64);
      }

      // At least one decision should have fulltext
      const withText = page.decisions.filter((d) => d.fulltext);
      expect(withText.length).toBeGreaterThan(0);

      console.log(
        `Smoke: ${page.decisions.length} decisions, ` +
          `${withText.length} with fulltext`,
      );
    },
    { timeout: 60_000 },
  );
});
