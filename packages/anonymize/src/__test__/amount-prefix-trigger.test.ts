import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";
import { loadTestDictionaries } from "./load-dictionaries";

setDefaultTimeout(15_000);

const dictionaries = await loadTestDictionaries();

const CONFIG: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  enableHotwordRules: false,
  enableZoneClassification: false,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "amount-prefix-trigger-test",
  dictionaries,
};

const moneyTexts = async (text: string) =>
  (await detectNative(CONFIG, text))
    .filter((entity) => entity.label === "monetary amount")
    .map((entity) => entity.text);

// The amount-prefix triggers ("in the amount of", "ve výši", "in Höhe
// von", ...) used to extend to the next comma or sentence end and swallowed
// the clause after the figure. The value is now bounded to the amount.
describe("amount-prefix triggers stop after the amount", () => {
  test("English clause text after the amount stays out of the span", async () => {
    expect(
      await moneyTexts(
        "A fee in the amount of USD 500,000 payable within 30 days.",
      ),
    ).toEqual(["USD 500,000"]);
  });

  test("Czech clause text after the amount stays out of the span", async () => {
    expect(
      await moneyTexts(
        "Smluvní pokuta ve výši 500.000,- Kč je splatná do 30 dnů.",
      ),
    ).toEqual(["500.000,- Kč"]);
  });

  test("German clause text after the amount stays out of the span", async () => {
    expect(
      await moneyTexts(
        "Eine Vertragsstrafe in Höhe von EUR 3.750.000,00 ist sofort fällig.",
      ),
    ).toEqual(["EUR 3.750.000,00"]);
  });

  test("a bare number after the trigger is still an amount", async () => {
    expect(
      await moneyTexts("A deposit in the amount of 500,000 is due at signing."),
    ).toEqual(["500,000"]);
  });

  test("a magnitude word after a currency-anchored amount is kept", async () => {
    expect(
      await moneyTexts("A payment in the amount of USD 1.5 million is due."),
    ).toEqual(["USD 1.5 million"]);
  });

  test("a bare number keeps its magnitude word and a trailing currency", async () => {
    expect(
      await moneyTexts("A reserve in the amount of 1.5 million is kept."),
    ).toEqual(["1.5 million"]);
    expect(
      await moneyTexts("A reserve in the amount of 1.5 million EUR is kept."),
    ).toEqual(["1.5 million EUR"]);
    // A share count is not an amount.
    expect(
      await moneyTexts("Holdings in the amount of 100 million shares."),
    ).toEqual(["100"]);
  });

  test("a signed value after the trigger is still an amount", async () => {
    expect(
      await moneyTexts("An adjustment in the amount of -500 was booked."),
    ).toEqual(["-500"]);
    expect(
      await moneyTexts("An adjustment in the amount of −1,250.50 was booked."),
    ).toEqual(["−1,250.50"]);
  });

  test("a percentage after the trigger keeps its percent sign", async () => {
    expect(
      await moneyTexts("Úrok ve výši 0,5 % z dlužné částky za každý den."),
    ).toEqual(["0,5 %"]);
  });
});
