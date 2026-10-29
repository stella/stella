import { expect, test } from "bun:test";

import {
  type ExpansionDictionaryProbe,
  PUBLISHED_EXPANSION_LANGUAGES,
} from "@/api/lib/legal-search/expansion";
import type { MorphologyLanguage } from "@/api/lib/legal-search/morphology/stem";
import { QUERY_EXPANSION_MODES } from "@/api/lib/legal-search/query-expansion-mode";

import { queryExpansionDictionariesInvariant } from "./query-expansion";

const CONTEXT = {
  now: new Date("2026-10-17T09:00:00.000Z"),
  signal: new AbortController().signal,
};

const UNAVAILABLE = {
  status: "unavailable",
} as const satisfies ExpansionDictionaryProbe;

const probing =
  (probes: Partial<Record<MorphologyLanguage, ExpansionDictionaryProbe>>) =>
  async (language: MorphologyLanguage) =>
    await Promise.resolve(probes[language] ?? UNAVAILABLE);

test("published dictionaries exist to be probed", () => {
  expect(PUBLISHED_EXPANSION_LANGUAGES.length).toBeGreaterThan(0);
});

test.each(QUERY_EXPANSION_MODES.filter((mode) => mode !== "off"))(
  "under %p, a dictionary that cannot load, one served stale and one empty each fire",
  async (mode) => {
    const verdict = await queryExpansionDictionariesInvariant({
      mode,
      languages: ["cs", "pl", "sk", "de"],
      probe: probing({
        cs: { status: "loaded", entries: 1200 },
        pl: { status: "stale", entries: 900 },
        de: { status: "loaded", entries: 0 },
      }),
    }).check(CONTEXT);

    expect(verdict).toEqual({
      status: "violated",
      checked: 4,
      findings: [
        expect.objectContaining({ target: "pl", reason: "stale" }),
        expect.objectContaining({ target: "sk", reason: "unavailable" }),
        expect.objectContaining({ target: "de", reason: "empty" }),
      ],
    });
  },
);

test("loaded dictionaries hold", async () => {
  expect(
    await queryExpansionDictionariesInvariant({
      mode: "shadow",
      languages: ["cs"],
      probe: probing({ cs: { status: "loaded", entries: 1 } }),
    }).check(CONTEXT),
  ).toEqual({ status: "held", checked: 1 });
});

test("with expansion off, nothing is probed", async () => {
  const probed: MorphologyLanguage[] = [];
  const verdict = await queryExpansionDictionariesInvariant({
    mode: "off",
    languages: PUBLISHED_EXPANSION_LANGUAGES,
    probe: async (language) => {
      probed.push(language);
      return await Promise.resolve(UNAVAILABLE);
    },
  }).check(CONTEXT);
  expect(verdict).toEqual({ status: "skipped", reason: "feature-off" });
  expect(probed).toEqual([]);
});
