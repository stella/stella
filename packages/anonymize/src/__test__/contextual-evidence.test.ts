import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { NativePipelineEntity } from "../native";
import type { Dictionaries, PipelineConfig } from "../types";
import { detectNative } from "./native-detect";
import { loadTestDictionaries } from "./load-dictionaries";

setDefaultTimeout(60_000);

const baseConfig: Omit<PipelineConfig, "dictionaries" | "language"> = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: true,
  enableDenyList: true,
  enableGazetteer: false,
  enableConfidenceBoost: true,
  enableCoreference: true,
  enableHotwordRules: true,
  enableZoneClassification: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "contextual-evidence-test",
};

let dictionariesPromise: Promise<Dictionaries> | undefined;
const detect = async (
  language: string,
  text: string,
): Promise<NativePipelineEntity[]> => {
  dictionariesPromise ??= loadTestDictionaries();
  return detectNative(
    {
      ...baseConfig,
      language,
      dictionaries: await dictionariesPromise,
    },
    text,
  );
};

const textsFor = (
  entities: readonly NativePipelineEntity[],
  label: string,
): string[] =>
  entities.filter((entity) => entity.label === label).map(({ text }) => text);

describe("context-backed identifiers", () => {
  const cases = [
    {
      language: "cs",
      text: "Rodné číslo je 900314/1258.",
      label: "birth number",
      value: "900314/1258",
    },
    {
      language: "cs",
      text: "Číslo občanského průkazu je 123456789.",
      label: "identity card number",
      value: "123456789",
    },
    {
      language: "cs",
      text: "Číslo občanského průkazu je AB123456.",
      label: "identity card number",
      value: "AB123456",
    },
    {
      language: "cs",
      text: "Číslo občanského průkazu je AB01123456.",
      label: "identity card number",
      value: "AB01123456",
    },
    {
      language: "de",
      text: "Die Personalausweisnummer lautet T22000123.",
      label: "identity card number",
      value: "T22000123",
    },
    {
      language: "en",
      text: "The passport number is Z12345678.",
      label: "passport number",
      value: "Z12345678",
    },
  ] as const;

  for (const { language, text, label, value } of cases) {
    test(`${language} field grammar anchors extraction at the identifier`, async () => {
      const entities = await detect(language, text);
      expect(
        textsFor(entities, label).some((entityText) =>
          entityText.startsWith(value),
        ),
      ).toBe(true);
    });
  }

  test("field labels without identifier-shaped values stay negative", async () => {
    const negativeCases = [
      ["cs", "Rodné číslo je pouze název pole; hodnota v této šabloně chybí."],
      [
        "de",
        "Personalausweisnummer ist nur eine Feldbezeichnung; der Wert fehlt.",
      ],
      ["en", "Passport number is only a field label; the value is absent."],
    ] as const;

    for (const [language, text] of negativeCases) {
      const entities = await detect(language, text);
      expect(
        entities.some((entity) =>
          ["birth number", "identity card number", "passport number"].includes(
            entity.label,
          ),
        ),
      ).toBe(false);
    }
  });

  test("modern Czech identity-card numbers cannot start with zero", async () => {
    const entities = await detect(
      "cs",
      "Číslo občanského průkazu je 012345678.",
    );
    expect(textsFor(entities, "identity card number")).toEqual([]);
  });

  test("identifier field vocabulary stays language-scoped", async () => {
    const englishOnly = await detect(
      "en",
      "Číslo občanského průkazu je 123456789.",
    );
    const czechOnly = await detect("cs", "The passport number is Z12345678.");

    expect(textsFor(englishOnly, "identity card number")).toEqual([]);
    expect(textsFor(czechOnly, "passport number")).toEqual([]);
  });
});

describe("party connector organization boundaries", () => {
  test("punctuation, Unicode spacing, and normalization do not absorb the prior party", async () => {
    const separators = [", ", "; ", ",\u00a0", ";\u202f"];
    const contexts = ["kupujícím společností", "kupujícím společností"];
    const name = "Modrá věž s.r.o.";

    for (const separator of separators) {
      for (const context of contexts) {
        const text = `Jan Novák${separator}a ${context} ${name}`;
        const organizations = textsFor(
          await detect("cs", text),
          "organization",
        );
        expect(organizations).toContain(name);
        expect(
          organizations.some((organization) =>
            organization.includes("Jan Novák"),
          ),
        ).toBe(false);
      }
    }
  });

  test("the same connector remains valid inside a company name without party evidence", async () => {
    const text = "Masaryk a partneři s.r.o. uzavřeli smlouvu.";
    expect(textsFor(await detect("cs", text), "organization")).toContain(
      "Masaryk a partneři s.r.o.",
    );
  });
});
