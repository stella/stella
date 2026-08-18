import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";
import { loadTestDictionaries } from "./load-dictionaries";

setDefaultTimeout(15_000);

const dictionaries = await loadTestDictionaries();

const BASE_CONFIG: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: false,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  enableHotwordRules: false,
  enableZoneClassification: false,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "legal-form-lowercase-bridge-test",
  dictionaries,
};

const orgs = async (text: string, languages?: string[]) =>
  (
    await detectNative(
      languages === undefined ? BASE_CONFIG : { ...BASE_CONFIG, languages },
      text,
    )
  )
    .filter((entity) => entity.label === "organization")
    .map((entity) => entity.text);

const money = async (text: string, languages?: string[]) =>
  (
    await detectNative(
      languages === undefined ? BASE_CONFIG : { ...BASE_CONFIG, languages },
      text,
    )
  )
    .filter((entity) => entity.label === "monetary amount")
    .map((entity) => entity.text);

// English capitalizes every word of an organization name except a closed
// connector set, so the backward walk from a legal-form suffix must not
// bridge prose ("invested in", "round of") to an earlier capitalized word.
describe("closed lowercase bridge (en)", () => {
  test("a verb and preposition between two organizations end the name", async () => {
    expect(
      await orgs("Northwind Ventures LLC invested in Acme Holdings Ltd.", [
        "en",
      ]),
    ).toEqual(["Northwind Ventures LLC", "Acme Holdings Ltd."]);
    expect(
      await orgs(
        "Northwind Ventures LLC invested heavily in Acme Holdings Ltd.",
        ["en"],
      ),
    ).toEqual(["Northwind Ventures LLC", "Acme Holdings Ltd."]);
  });

  test("a noun phrase before 'of' is not part of the name", async () => {
    expect(
      await orgs(
        "Northwind Ventures LLC led the Series B round of Acme Holdings Ltd.",
        ["en"],
      ),
    ).toEqual(["Northwind Ventures LLC", "Acme Holdings Ltd."]);
    expect(
      await orgs(
        "Acme Holdings Ltd. sold its Prague subsidiary to Northwind Ventures LLC.",
        ["en"],
      ),
    ).toEqual(["Acme Holdings Ltd.", "Northwind Ventures LLC"]);
  });

  test("a list separator before 'and' closes the name", async () => {
    // "…Priya Ramanathan, and Northwind Capital Partners LLC" is a party
    // list; the conjunction after a comma is not part of the second name.
    expect(
      await orgs(
        "represented by its Chief Executive Officer Priya Ramanathan, and Northwind Capital Partners LLC, represented by Jonathan H. Whitaker.",
        ["en"],
      ),
    ).toEqual(["Northwind Capital Partners LLC"]);
    expect(await orgs("Acme Widgets and Bar, Inc. signed.", ["en"])).toEqual([
      "Acme Widgets and Bar, Inc.",
    ]);
  });

  test("closed connectors still bridge inside a name", async () => {
    expect(
      await orgs(
        "Advised by Banco de Sabadell S.A. and Bank of America Corp.",
        ["en"],
      ),
    ).toEqual(["Banco de Sabadell S.A.", "Bank of America Corp."]);
  });

  test("lowercase words before the first capitalized word stay admitted", async () => {
    // The tail rule is policy-independent: only bridging back across an
    // already-admitted capitalized word is closed.
    expect(await orgs("Sold to Česká spořitelna, a.s. today.", ["en"])).toEqual(
      ["Česká spořitelna, a.s."],
    );
  });
});

describe("open lowercase bridge (all languages)", () => {
  test("Czech names with inner lowercase words survive", async () => {
    expect(
      await orgs(
        "Základní škola a Mateřská škola Brno, příspěvková organizace",
      ),
    ).toEqual(["Základní škola a Mateřská škola Brno, příspěvková organizace"]);
  });

  test("a selected open language keeps the walk open", async () => {
    expect(
      await orgs("Nájemce: Základní škola a Mateřská škola Brno, s.r.o.", [
        "en",
        "cs",
      ]),
    ).toEqual(["Základní škola a Mateřská škola Brno, s.r.o."]);
  });
});

describe("grouped numbers before an organization", () => {
  test("a grouped amount is never a name fragment", async () => {
    // Regardless of policy: the digit groups of "45,000,000" split at the
    // skipped commas and used to become the name head ("000 in Acme …").
    expect(
      await orgs("Northwind invested USD 45,000,000 in Acme Holdings Ltd."),
    ).toEqual(["Acme Holdings Ltd."]);
    expect(
      await money("Northwind invested USD 45,000,000 in Acme Holdings Ltd."),
    ).toEqual(["USD 45,000,000"]);
    expect(await orgs("USD 45,000,000 Acme Holdings Ltd.", ["en"])).toEqual([
      "Acme Holdings Ltd.",
    ]);
  });

  test("a dot-grouped amount is not a name fragment either", async () => {
    expect(
      await orgs("Northwind invested EUR 45.000.000 in Acme Holdings Ltd."),
    ).toEqual(["Acme Holdings Ltd."]);
    expect(
      await money("Northwind invested EUR 45.000.000 in Acme Holdings Ltd."),
    ).toEqual(["EUR 45.000.000"]);
  });

  test("a thousands separator is not a leading-clause comma", async () => {
    expect(
      await orgs("Paid 45,000,000 to Acme Holdings Ltd. at closing.", ["en"]),
    ).toEqual(["Acme Holdings Ltd."]);
  });
});
