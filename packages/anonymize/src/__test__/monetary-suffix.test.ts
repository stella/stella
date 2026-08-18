import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";
import { loadTestDictionaries } from "./load-dictionaries";

// Pipeline context build is CPU-bound; mirror the budget
// used by the other regex-focused suites.
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
  workspaceId: "monetary-suffix-test",
  dictionaries,
};

const detect = (text: string) => detectNative(CONFIG, text);

const findMoney = (entities: Awaited<ReturnType<typeof detect>>) =>
  entities.filter((e) => e.label === "monetary amount");

describe("monetary amounts with magnitude suffix", () => {
  test("captures '$25 million' as a single span including the unit", async () => {
    const text = "The deal closed at $25 million in cash.";
    const money = findMoney(await detect(text));
    expect(money).toHaveLength(1);
    expect(money[0]!.text).toBe("$25 million");
  });

  test("captures '$1 billion'", async () => {
    const text = "Termination fee was $1 billion.";
    const money = findMoney(await detect(text));
    expect(money.find((e) => e.text === "$1 billion")).toBeDefined();
  });

  test("captures hundred-scale suffixes from language data", async () => {
    const money = findMoney(await detect("Escrow holdback was $25 hundred."));
    expect(money.find((e) => e.text === "$25 hundred")).toBeDefined();
  });

  test("captures decimal magnitudes like '$1.5 trillion'", async () => {
    const text = "The fund manages $1.5 trillion in assets.";
    const money = findMoney(await detect(text));
    expect(money.find((e) => e.text === "$1.5 trillion")).toBeDefined();
  });

  test("captures abbreviated forms '$500K' and '$2bn'", async () => {
    const a = findMoney(await detect("Seed round of $500K closed."));
    expect(a.find((e) => e.text === "$500K")).toBeDefined();

    const b = findMoney(await detect("They raised $2bn last quarter."));
    expect(b.find((e) => e.text === "$2bn")).toBeDefined();
  });

  test("captures 'EUR 1.5 billion' (leading code + magnitude)", async () => {
    const money = findMoney(
      await detect("The contract value is EUR 1.5 billion."),
    );
    expect(money.find((e) => e.text === "EUR 1.5 billion")).toBeDefined();
  });

  test("captures '100 million USD' (magnitude between number and code)", async () => {
    const money = findMoney(await detect("Loss provision: 100 million USD."));
    expect(money.find((e) => e.text === "100 million USD")).toBeDefined();
  });

  test("captures '$25 million USD' with the leading symbol", async () => {
    const money = findMoney(await detect("Purchase price: $25 million USD."));
    expect(money.find((e) => e.text === "$25 million USD")).toBeDefined();
    expect(money.find((e) => e.text === "25 million USD")).toBeUndefined();
  });

  test("does not treat stock quantities as monetary amounts", async () => {
    const money = findMoney(
      await detect("The fund bought 100 million AMD shares yesterday."),
    );
    expect(money).toHaveLength(0);
  });

  test("does not treat modified stock quantities as monetary amounts", async () => {
    const money = findMoney(
      await detect(
        "The fund bought 100 million AMD ordinary shares yesterday.",
      ),
    );
    expect(money).toHaveLength(0);
  });

  test("matches uppercase plural forms ('MILLIONS')", async () => {
    // The plural `s` must sit inside the case-insensitive
    // group; otherwise uppercase plurals slip back to
    // the bare-number fallback.
    const money = findMoney(
      await detect("Estimated at $25 MILLIONS worldwide."),
    );
    expect(money.find((e) => e.text === "$25 MILLIONS")).toBeDefined();
  });

  test("'25 people' is not a monetary amount", async () => {
    const money = findMoney(await detect("Around 25 people attended."));
    expect(money).toHaveLength(0);
  });

  test("'$25 grapes' falls back to '$25' (unknown unit word)", async () => {
    const money = findMoney(await detect("She bought $25 grapes at market."));
    expect(money).toHaveLength(1);
    expect(money[0]!.text).toBe("$25");
  });

  test("preserves comma-grouped form '$1,000,000,000' (no suffix)", async () => {
    const money = findMoney(await detect("Paid $1,000,000,000 at signing."));
    expect(money.find((e) => e.text === "$1,000,000,000")).toBeDefined();
  });

  test("'$25 km' does not consume the unit (km is not a magnitude)", async () => {
    // Defensive: ensure the abbrev branch doesn't gobble
    // 'k' from a non-monetary trailing word.
    const money = findMoney(await detect("Race entry costs $25 km away."));
    expect(money).toHaveLength(1);
    expect(money[0]!.text).toBe("$25");
  });

  test("'$25 m cable' is not extended (lowercase m = metre, not million)", async () => {
    // Uppercase K/M are case-sensitive abbreviations. A
    // lowercase `m` separated by a space reads as metres
    // ("$25 m cable", "$10 m above sea level"), so it only
    // counts when attached to the digits.
    const money = findMoney(await detect("Need a $25 m cable for the rig."));
    expect(money).toHaveLength(1);
    expect(money[0]!.text).toBe("$25");
  });

  test("attached lowercase 'm' and 'k' are magnitudes ('$25m', '£250m', '€1.2m', '$500k')", async () => {
    const dollars = findMoney(await detect("Buyer shall pay $25m at Closing."));
    expect(dollars.map((e) => e.text)).toEqual(["$25m"]);

    const pounds = findMoney(
      await detect("A term loan of £250m and a revolver of £50m."),
    );
    expect(pounds.map((e) => e.text)).toEqual(["£250m", "£50m"]);

    const euros = findMoney(await detect("The fee is €1.2m."));
    expect(euros.map((e) => e.text)).toEqual(["€1.2m"]);

    const thousands = findMoney(await detect("Seed round of $500k closed."));
    expect(thousands.map((e) => e.text)).toEqual(["$500k"]);

    const trailingCode = findMoney(
      await detect("Consideration of approximately 640m EUR."),
    );
    expect(trailingCode.map((e) => e.text)).toEqual(["640m EUR"]);
  });

  test("attached abbreviations still require a word boundary ('$25km')", async () => {
    const km = findMoney(await detect("The site is $25km from town."));
    expect(km).toHaveLength(0);
  });

  test("'mm' and 'MM' are English million shorthand ('$25mm', '$25 MM')", async () => {
    const attached = findMoney(await detect("Valued at $25mm by the bank."));
    expect(attached.map((e) => e.text)).toEqual(["$25mm"]);

    const upper = findMoney(await detect("Valued at $25 MM by the bank."));
    expect(upper.map((e) => e.text)).toEqual(["$25 MM"]);

    // Spaced lowercase `mm` is a length unit.
    const length = findMoney(await detect("A $25 mm bolt."));
    expect(length.map((e) => e.text)).toEqual(["$25"]);
  });

  test("dash-joined ranges are one amount ('USD 10-15 million', '$10 – 15 million')", async () => {
    const tight = findMoney(await detect("The fee is USD 10-15 million."));
    expect(tight.map((e) => e.text)).toEqual(["USD 10-15 million"]);

    const spaced = findMoney(await detect("The fee is $10 – 15 million."));
    expect(spaced.map((e) => e.text)).toEqual(["$10 – 15 million"]);

    const trailing = findMoney(await detect("A fee of 10-15 million EUR."));
    expect(trailing.map((e) => e.text)).toEqual(["10-15 million EUR"]);

    // The Czech `,-` suffix is not a range dash.
    const czech = findMoney(await detect("Pokuta 500.000,- Kč je splatná."));
    expect(czech.map((e) => e.text)).toEqual(["500.000,- Kč"]);
  });

  test("free-standing written-out amounts before a currency name are amounts", async () => {
    const compound = findMoney(
      await detect(
        "A purchase price of twenty-five million dollars was agreed.",
      ),
    );
    expect(compound.map((e) => e.text)).toEqual([
      "twenty-five million dollars",
    ]);

    const joined = findMoney(
      await detect(
        "Damages of one hundred and fifty thousand euros were paid.",
      ),
    );
    expect(joined.map((e) => e.text)).toEqual([
      "one hundred and fifty thousand euros",
    ]);

    const article = findMoney(await detect("He owed a million dollars."));
    expect(article.map((e) => e.text)).toEqual(["a million dollars"]);

    // A magnitude word alone, or prose before the currency, is not enough.
    const bare = findMoney(
      await detect("Several million dollars changed hands."),
    );
    expect(bare).toHaveLength(0);
    const prose = findMoney(await detect("Payments in dollars and cents."));
    expect(prose).toHaveLength(0);
  });

  test("uppercase 'B' is an English billion abbreviation ('$1.5B')", async () => {
    const money = findMoney(
      await detect("Revenue was $1.5B and EBITDA $300M."),
    );
    expect(money.map((e) => e.text)).toEqual(["$1.5B", "$300M"]);
  });

  test("dotted abbreviations are explicit data ('12,5 Mio. Euro'), a sentence period is not", async () => {
    const dotted = findMoney(
      await detect("Die Gesellschaft wurde für 12,5 Mio. Euro übernommen."),
    );
    expect(dotted.map((e) => e.text)).toEqual(["12,5 Mio. Euro"]);

    const code = findMoney(await detect("Der Preis beträgt 25 Mio. EUR."));
    expect(code.map((e) => e.text)).toEqual(["25 Mio. EUR"]);

    // Abbreviations without a dotted form ('M', 'bn') and full words never
    // consume a sentence period before a currency token.
    const sentence = findMoney(
      await detect("It cost 25 million. EUR is the reporting currency."),
    );
    expect(sentence.map((e) => e.text)).not.toContain("25 million. EUR");
    const abbreviated = findMoney(
      await detect("The price was $25 M. EUR is the reporting currency."),
    );
    expect(abbreviated.map((e) => e.text)).toEqual(["$25 M"]);
  });

  test("magnitude vocabulary follows the content-language scope", async () => {
    // `B` and `mm` are English shorthand; a German-only scope does not
    // detect them, and an English-only scope does not know `Mio.`.
    const german = (
      await detectNative(
        { ...CONFIG, languages: ["de"] },
        "Umsatz von $1.5B und $25mm.",
      )
    )
      .filter((e) => e.label === "monetary amount")
      .map((e) => e.text);
    expect(german).toEqual([]);
    const englishGerman = (
      await detectNative(
        { ...CONFIG, languages: ["en"] },
        "Ein Preis von 25 Mio. EUR.",
      )
    )
      .filter((e) => e.label === "monetary amount")
      .map((e) => e.text);
    expect(englishGerman).toEqual([]);
    const english = (
      await detectNative(
        { ...CONFIG, languages: ["en"] },
        "Revenue of $1.5B and $25mm.",
      )
    )
      .filter((e) => e.label === "monetary amount")
      .map((e) => e.text);
    expect(english).toEqual(["$1.5B", "$25mm"]);
  });

  test("short PT-BR abbreviations do not apply globally", async () => {
    const distance = findMoney(await detect("The hotel is $25 mi away."));
    expect(distance).toHaveLength(1);
    expect(distance[0]!.text).toBe("$25");

    const schedule = findMoney(
      await detect("The service costs $10 bi-weekly."),
    );
    expect(schedule).toHaveLength(1);
    expect(schedule[0]!.text).toBe("$10");
  });

  test("ambiguous multilingual suffixes do not apply globally", async () => {
    const setAside = findMoney(await detect("We paid $25 set aside for fees."));
    expect(setAside).toHaveLength(1);
    expect(setAside[0]!.text).toBe("$25");

    const film = findMoney(
      await detect("The order includes $25 mil spec film."),
    );
    expect(film).toHaveLength(1);
    expect(film[0]!.text).toBe("$25");
  });

  test("share-quantity guard keeps ordinary English nouns", async () => {
    const money = findMoney(
      await detect("The estimate lists 100 USD parts and 50 USD labor."),
    );
    expect(money.map((entity) => entity.text)).toEqual(
      expect.arrayContaining(["100 USD", "50 USD"]),
    );
  });

  test("'$25M' uppercase abbreviation still captures as million", async () => {
    const money = findMoney(await detect("Round closed at $25M."));
    expect(money.find((e) => e.text === "$25M")).toBeDefined();
  });
});
