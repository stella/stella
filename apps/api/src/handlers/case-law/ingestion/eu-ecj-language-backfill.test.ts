import { describe, expect, test } from "bun:test";

import {
  type EcjCelexVariant,
  ecjListingIdentity,
} from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { listingIdentityKey } from "@/api/lib/legal-search/ingestion-types";

import {
  type EcjBackfillJournalEntry,
  type EcjBackfillMonth,
  type EcjLanguageBackfillOptions,
  type EcjVariantIngestOutcome,
  previousEcjBackfillMonth,
  runEcjLanguageBackfill,
} from "./eu-ecj-language-backfill";

/**
 * A publisher listing per month, a store of held identities and a durable
 * cursor, all in memory: the walk's contract is what it does with them.
 */
const world = (listings: Record<EcjBackfillMonth, EcjCelexVariant[]>) => {
  const held = new Set<string>();
  const state = { cursor: null as EcjBackfillMonth | null };
  const journal: EcjBackfillJournalEntry[] = [];
  const ingested: string[] = [];
  const identityOf = (variant: EcjCelexVariant): string | undefined => {
    const identity = ecjListingIdentity(variant);
    return identity.type === "unidentifiable"
      ? undefined
      : (listingIdentityKey(identity) ?? undefined);
  };
  const seams = {
    listMonth: async (month: EcjBackfillMonth) => listings[month] ?? [],
    identityOf,
    heldIdentities: async (identities: readonly string[]) =>
      new Set(identities.filter((identity) => held.has(identity))),
    ingest: async (
      variant: EcjCelexVariant,
    ): Promise<EcjVariantIngestOutcome> => {
      const identity = identityOf(variant);
      if (identity !== undefined) {
        held.add(identity);
        ingested.push(identity);
      }
      return { type: "written" };
    },
    loadCursor: async () => state.cursor,
    advanceCursor: async (
      expected: EcjBackfillMonth | null,
      next: EcjBackfillMonth,
    ) => {
      if (state.cursor !== expected) {
        return false;
      }
      state.cursor = next;
      return true;
    },
    journal: async (entry: EcjBackfillJournalEntry) => {
      journal.push(entry);
    },
  } satisfies Partial<EcjLanguageBackfillOptions>;
  return { held, state, journal, ingested, identityOf, seams };
};

const variant = (celex: string, language: string): EcjCelexVariant => {
  const found = (
    [
      "EN",
      "CS",
      "DE",
      "BG",
      "FR",
    ] as const satisfies readonly EcjCelexVariant["language"][]
  ).find((candidate) => candidate === language);
  if (found === undefined) {
    throw new TypeError(`Unexpected test language ${language}`);
  }
  return { celex, language: found };
};

const LISTINGS = {
  "2024-03": [
    variant("62024CJ0244", "EN"),
    variant("62024CJ0244", "CS"),
    variant("62024CJ0244", "DE"),
  ],
  "2024-02": [variant("62024CO0100", "EN"), variant("62024CO0100", "BG")],
  "2024-01": [variant("62024CJ0001", "FR")],
};

const RUN = {
  newest: "2024-03",
  oldest: "2024-01",
  apply: true,
  maxMonths: 100,
  maxIngests: 100,
} as const;

describe("filling in missing language versions", () => {
  test("ingests exactly the listed variants no row holds", async () => {
    const { held, seams, ingested, identityOf } = world(LISTINGS);
    const alreadyHeld = identityOf(variant("62024CJ0244", "EN"));
    if (alreadyHeld === undefined) {
      throw new TypeError("Expected a keyable variant");
    }
    held.add(alreadyHeld);

    const report = await runEcjLanguageBackfill({ ...seams, ...RUN });

    expect(report.status).toBe("complete");
    expect(report.cursor).toBe("2024-01");
    expect(report.listed).toBe(6);
    expect(report.missing).toBe(5);
    expect(ingested).not.toContain(alreadyHeld);
    expect(ingested).toHaveLength(5);
  });

  test("a second run reaches the same fixed point and writes nothing", async () => {
    const { seams, ingested } = world(LISTINGS);
    await runEcjLanguageBackfill({ ...seams, ...RUN });
    const written = ingested.length;

    // A finished walk resumes past its oldest month and does nothing; a
    // restarted one re-lists every month and finds every variant held.
    const resumed = await runEcjLanguageBackfill({ ...seams, ...RUN });
    expect(resumed.status).toBe("complete");
    expect(resumed.monthsWalked).toBe(0);

    const restarted = await runEcjLanguageBackfill({
      ...seams,
      ...RUN,
      loadCursor: async () => null,
      advanceCursor: async () => true,
    });
    expect(restarted.missing).toBe(0);
    expect(ingested).toHaveLength(written);
  });

  test("a retryable failure holds the month and a later run finishes it", async () => {
    const { seams, state, journal, ingested } = world(LISTINGS);
    let failing = true;
    const flaky = async (target: EcjCelexVariant) =>
      failing && target.celex === "62024CO0100" && target.language === "BG"
        ? ({ type: "retryable", reason: "HTTP 503" } as const)
        : await seams.ingest(target);

    const first = await runEcjLanguageBackfill({
      ...seams,
      ...RUN,
      ingest: flaky,
    });
    expect(first.status).toBe("held");
    expect(first.heldAt).toBe("2024-02");
    // The month before the failure finished; the failing month did not.
    expect(state.cursor).toBe("2024-03");
    expect(journal.at(-1)).toMatchObject({
      month: "2024-02",
      outcome: "retryable",
      reason: "HTTP 503",
    });

    failing = false;
    const second = await runEcjLanguageBackfill({
      ...seams,
      ...RUN,
      ingest: flaky,
    });
    expect(second.status).toBe("complete");
    expect(state.cursor).toBe("2024-01");
    // The variant written before the failure was not fetched again.
    expect(new Set(ingested).size).toBe(ingested.length);
  });

  test("a variant listed but not served is terminal and journaled", async () => {
    const { seams, state, journal } = world(LISTINGS);
    const report = await runEcjLanguageBackfill({
      ...seams,
      ...RUN,
      ingest: async (target) =>
        target.language === "DE"
          ? { type: "unavailable" }
          : await seams.ingest(target),
    });

    expect(report.status).toBe("complete");
    expect(report.unavailable).toBe(1);
    expect(state.cursor).toBe("2024-01");
    expect(journal.filter(({ outcome }) => outcome === "unavailable")).toEqual([
      {
        month: "2024-03",
        celex: "62024CJ0244",
        language: "DE",
        outcome: "unavailable",
      },
    ]);
  });

  test("an exhausted ingest budget leaves the month for the next run", async () => {
    const { seams, state, ingested } = world(LISTINGS);
    const first = await runEcjLanguageBackfill({
      ...seams,
      ...RUN,
      maxIngests: 2,
    });

    expect(first.status).toBe("ingest-budget");
    expect(state.cursor).toBeNull();
    expect(ingested).toHaveLength(2);

    const second = await runEcjLanguageBackfill({ ...seams, ...RUN });
    expect(second.status).toBe("complete");
    expect(ingested).toHaveLength(6);
  });

  test("a run that lost the cursor to another stops without moving it", async () => {
    const { seams, state } = world(LISTINGS);
    const report = await runEcjLanguageBackfill({
      ...seams,
      ...RUN,
      advanceCursor: async (expected, next) => {
        // Another run finished an older month first.
        state.cursor = "2024-01";
        return await seams.advanceCursor(expected, next);
      },
    });

    expect(report.status).toBe("superseded");
    expect(report.cursor).toBe("2024-01");
    expect(state.cursor).toBe("2024-01");
  });

  test("a plan run lists and counts without writing or moving the cursor", async () => {
    const { seams, state, ingested } = world(LISTINGS);
    const report = await runEcjLanguageBackfill({
      ...seams,
      ...RUN,
      apply: false,
    });

    expect(report.missing).toBe(6);
    expect(ingested).toHaveLength(0);
    expect(state.cursor).toBeNull();
  });

  test("months step back across a year boundary", () => {
    expect(previousEcjBackfillMonth("2024-01")).toBe("2023-12");
    expect(previousEcjBackfillMonth("2024-10")).toBe("2024-09");
    expect(previousEcjBackfillMonth("1954-01")).toBe("1953-12");
  });
});
