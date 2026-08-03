import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import type { Dictionaries } from "@stll/anonymize";

import type { GroundTruthDocument } from "../ground-truth";
import { loadGroundTruth } from "../ground-truth";
import {
  buildStllBenchmarkConfig,
  createStllAdapter,
  loadStllBenchmarkConfig,
  runStllAdapterWithInitializer,
} from "../adapters/stella";
import { loadCorpusDictionaries } from "../dictionaries";

const document = (
  id: string,
  language: string,
  text: string,
): GroundTruthDocument => ({
  id,
  language,
  title: id,
  text,
  entities: [],
});

describe("stella benchmark adapter language scoping", () => {
  test("pins the shipped product-default prepared pipeline output", async () => {
    const outcome = await createStllAdapter().run(await loadGroundTruth());
    if (outcome.status !== "ok") {
      throw new Error(outcome.reason);
    }

    const hash = createHash("sha256");
    let spanCount = 0;
    for (const [documentId, predictions] of outcome.predictions) {
      for (const { start, end, label } of predictions) {
        hash.update(`${documentId}\0${start}\0${end}\0${label}\n`);
        spanCount++;
      }
    }

    expect(spanCount).toBe(172);
    expect(hash.digest("hex")).toBe(
      "e950b7a28df156fcaf43c6739a86b68802eb9bd6f97e391fc4eedf546900cda3",
    );
  });

  test("uses the all-language package when no scoped package is shipped", async () => {
    const outcome = await createStllAdapter().run([
      document("es-1", "es", "Paciente Ana García"),
    ]);

    expect(outcome.status).toBe("ok");
  });

  test("an English corpus builds and reuses only an English pipeline", async () => {
    const builtLanguages: string[] = [];
    const processedLanguages: string[] = [];
    const docs = [
      document("en-1", "en", "first"),
      document("en-2", "EN", "second"),
    ];

    const outcome = await runStllAdapterWithInitializer(
      docs,
      async () => async (language) => {
        builtLanguages.push(language);
        return {
          redactText: (text) => {
            processedLanguages.push(`${language}:${text}`);
            return { resolvedEntities: [] };
          },
        };
      },
    );

    expect(outcome.status).toBe("ok");
    expect(builtLanguages).toEqual(["en"]);
    expect(processedLanguages).toEqual([
      "en:first",
      "en:second",
      "en:first",
      "en:second",
    ]);
  });

  test("a mixed corpus builds separate pipelines in deterministic order", async () => {
    const builtLanguages: string[] = [];
    const processedLanguages: string[] = [];
    const docs = [
      document("de-1", "de", "eins"),
      document("en-1", "en", "one"),
      document("de-2", "DE", "zwei"),
    ];

    await runStllAdapterWithInitializer(docs, async () => async (language) => {
      builtLanguages.push(language);
      return {
        redactText: (text) => {
          processedLanguages.push(`${language}:${text}`);
          return { resolvedEntities: [] };
        },
      };
    });

    expect(builtLanguages).toEqual(["de", "en"]);
    expect(processedLanguages).toEqual([
      "de:eins",
      "en:one",
      "de:zwei",
      "de:eins",
      "en:one",
      "de:zwei",
    ]);
  });

  test("each pipeline config carries one language rather than a union", () => {
    const dictionaries: Dictionaries = {};

    const english = buildStllBenchmarkConfig(dictionaries, "en");
    const german = buildStllBenchmarkConfig(dictionaries, "de");

    expect(english.language).toBe("en");
    expect(english.languages).toBeUndefined();
    expect(english.nameCorpusLanguages).toEqual(["en"]);
    expect(german.language).toBe("de");
    expect(german.languages).toBeUndefined();
    expect(german.nameCorpusLanguages).toEqual(["de"]);
  });

  test("pipeline configs receive only the requested language's names", async () => {
    const [englishConfig, germanConfig, cachedEnglish] = await Promise.all([
      loadStllBenchmarkConfig("en"),
      loadStllBenchmarkConfig("de"),
      loadCorpusDictionaries("EN"),
    ]);
    const english = englishConfig.dictionaries;
    const german = germanConfig.dictionaries;
    if (english === undefined || german === undefined) {
      throw new Error("benchmark pipeline config omitted dictionaries");
    }

    expect(Object.keys(english.firstNames ?? {})).toEqual(["en"]);
    expect(Object.keys(english.surnames ?? {})).toEqual(["en"]);
    expect(Object.keys(german.firstNames ?? {})).toEqual(["de"]);
    expect(Object.keys(german.surnames ?? {})).toEqual(["de"]);
    expect(cachedEnglish).toBe(english);
    expect(
      Object.values(english.denyListMeta ?? {}).every(
        (meta) => meta.country === null && meta.category !== "Names",
      ),
    ).toBeTrue();
    expect(english.citiesByCountry).toEqual({});
  });
});
