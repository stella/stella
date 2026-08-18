# Redacting deal sizes and other monetary amounts

Deal values, purchase prices, round sizes, fees, and caps are detected under
the `monetary amount` label by the default pipeline. This page shows what the
shipped detector does with such text and how to censor the figures while the
surrounding sentence, the parties, and the cross-references stay readable.

The examples below are output of the default pipeline (`getDefaultNativePipeline`
with the `en` package, or the all-language package for the other languages).
Every input is synthetic.

## What is detected

The `monetary amount` detector anchors on currency symbols (`$`, `€`, `£`,
`Kč`, …), ISO 4217 codes (`USD`, `EUR`, `CHF`, …), and language-specific
currency names (`euros`, `korun českých`, …). Around the anchor it reads
grouped and decimal numbers in the common conventions (`45,000,000`,
`3.750.000,00`, `1 250 000 000`, `500.000,-`), magnitude words and
abbreviations from per-language data (`million`, `bn`, `B`, `M`, `Mio.`,
`mld`, and the attached shorthand `$25m` / `£500k`), and written-out amounts
introduced by a keyword (`(slovy: …)`, `(in Worten: …)`, `(in words: …)`).
Trigger phrases such as `in the amount of`, `ve výši`, or `in Höhe von` add
amounts without a currency token. Percentages and interest rates carry the
same label so that a rate can be censored together with the principal.

| Input                                                                                      | Output                                                                                                     | Monetary amounts                 |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `Acme Holdings Ltd. acquired Beta Systems GmbH for $1.2 billion in cash and stock.`        | `[ORGANIZATION_1] acquired [ORGANIZATION_2] for [MONETARY_AMOUNT_1] in cash and stock.`                    | `$1.2 billion`                   |
| `The Series B round of USD 45,000,000 was led by Northwind Ventures on 14 March 2025.`     | `The Series B round of [MONETARY_AMOUNT_1] was led by Northwind Ventures on [DATE_1].`                     | `USD 45,000,000`                 |
| `Purchase price: EUR 12.5 million, of which €2,500,000 is held in escrow for 18 months.`   | `Purchase price: [MONETARY_AMOUNT_1], of which [MONETARY_AMOUNT_2] is held in escrow for 18 months.`       | `EUR 12.5 million`, `€2,500,000` |
| `The aggregate Earn-Out Payments shall not exceed $10,000,000 (the "Earn-Out Cap").`       | `The aggregate Earn-Out Payments shall not exceed [MONETARY_AMOUNT_1] (the "Earn-Out Cap").`               | `$10,000,000`                    |
| `The Company raised a $7.5M seed round and a Series A of $32M.`                            | `The Company raised a [MONETARY_AMOUNT_1] seed round and a Series A of [MONETARY_AMOUNT_2].`               | `$7.5M`, `$32M`                  |
| `The deal values the company at $3.4bn, or $52.50 per share.`                              | `The deal values the company at [MONETARY_AMOUNT_1], or [MONETARY_AMOUNT_2] per share.`                    | `$3.4bn`, `$52.50`               |
| `The facility comprises a term loan of £250m and a revolver of £50m.`                      | `The facility comprises a term loan of [MONETARY_AMOUNT_1] and a revolver of [MONETARY_AMOUNT_2].`         | `£250m`, `£50m`                  |
| `Revenue was $1.5B and EBITDA was $300M.`                                                  | `Revenue was [MONETARY_AMOUNT_1] and EBITDA was [MONETARY_AMOUNT_2].`                                      | `$1.5B`, `$300M`                 |
| `The fee is USD 10-15 million, or $25mm at the option of the lender.`                      | `The fee is [MONETARY_AMOUNT_1], or [MONETARY_AMOUNT_2] at the option of the lender.`                      | `USD 10-15 million`, `$25mm`     |
| `The parties agreed a purchase price of twenty-five million dollars.`                      | `The parties agreed a purchase price of [MONETARY_AMOUNT_1].`                                              | `twenty-five million dollars`    |
| `Northwind Ventures LLC invested USD 45,000,000 in Acme Holdings Ltd.`                     | `[ORGANIZATION_1] invested [MONETARY_AMOUNT_1] in [ORGANIZATION_2]`                                        | `USD 45,000,000`                 |
| `A fee in the amount of USD 500,000 is payable within 30 days.`                            | `A fee in the amount of [MONETARY_AMOUNT_1] is payable within 30 days.`                                    | `USD 500,000`                    |
| `Consideration: 40,000,000 shares plus cash of $60 million and a $15 million vendor note.` | `Consideration: 40,000,000 shares plus cash of [MONETARY_AMOUNT_1] and a [MONETARY_AMOUNT_2] vendor note.` | `$60 million`, `$15 million`     |
| `The rent is USD 12,500 per month; the deposit equals three months' rent (USD 37,500).`    | `The rent is [MONETARY_AMOUNT_1] per month; the deposit equals three months' rent ([MONETARY_AMOUNT_2]).`  | `USD 12,500`, `USD 37,500`       |
| `Damages are capped at 1,000,000 euros; liability for fraud is uncapped.`                  | `Damages are capped at [MONETARY_AMOUNT_1]; liability for fraud is uncapped.`                              | `1,000,000 euros`                |
| `The loan bears interest at 6.25% per annum on a principal of CHF 8,000,000.`              | `The loan bears interest at [MONETARY_AMOUNT_1] per annum on a principal of [MONETARY_AMOUNT_2].`          | `6.25%`, `CHF 8,000,000`         |
| `The termination fee is 3.5% of the equity value, approximately $85 million.`              | `The termination fee is [MONETARY_AMOUNT_1] of the equity value, approximately [MONETARY_AMOUNT_2].`       | `3.5%`, `$85 million`            |
| `Seller sold 100 million AMD shares and 2,000,000 ordinary shares of the Company.`         | `Seller sold 100 million AMD shares and 2,000,000 ordinary shares of the Company.`                         | none                             |
| `The lease runs for 25 months from 1 January 2026; see Article 12.5 and Schedule 3.`       | `The lease runs for 25 months from [DATE_1]; see Article 12.5 and Schedule 3.`                             | none                             |

Share counts and bare numbers are not amounts: `100 million AMD shares`,
`2,000,000 ordinary shares`, `25 months`, and `Article 12.5` are left alone.

The same detector runs for every bundled language; the anchor and number
conventions come from per-language data:

| Language | Input                                                                                                  | Output                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| cs       | `Kupní cena činí 1 250 000 000 Kč (slovy: jedna miliarda dvě stě padesát milionů korun českých).`      | `Kupní cena činí [MONETARY_AMOUNT_1].`                                         |
| cs       | `Pokuta činí 500.000,- Kč. Je splatná do 30 dnů.`                                                      | `Pokuta činí [MONETARY_AMOUNT_1]. Je splatná do 30 dnů.`                       |
| de       | `Der Kaufpreis beträgt EUR 3.750.000,00 (in Worten: drei Millionen siebenhundertfünfzigtausend Euro).` | `Der Kaufpreis beträgt [MONETARY_AMOUNT_1].`                                   |
| de       | `Die Gesellschaft wurde für 12,5 Mio. Euro übernommen.`                                                | `Die Gesellschaft wurde für [MONETARY_AMOUNT_1] übernommen.`                   |
| fr       | `Le prix d'acquisition s'élève à 4 500 000 euros, payable à la signature.`                             | `Le prix d'acquisition s'élève à [MONETARY_AMOUNT_1], payable à la signature.` |

## Keeping the context

### Placeholders keep the sentence and the cross-references

Replacement is positional: only the amount is swapped for a placeholder, so
defined terms, clause structure, and every word around the figure survive. The
same normalized amount gets the same placeholder within a document, so a reader
(or a model) can still tell that the closing payment equals the Purchase Price
and that the escrow amount is a different figure. The redaction map restores
the original text.

```text
The Purchase Price is $25,000,000 (the "Purchase Price").
At Closing, Buyer shall pay $25,000,000 less the Escrow Amount of $2,500,000.
The Escrow Amount of $2,500,000 is released 18 months after Closing.
```

becomes

```text
The Purchase Price is [MONETARY_AMOUNT_1] (the "Purchase Price").
At Closing, Buyer shall pay [MONETARY_AMOUNT_1] less the Escrow Amount of [MONETARY_AMOUNT_2].
The Escrow Amount of [MONETARY_AMOUNT_2] is released 18 months after Closing.
```

`deanonymise(redactedText, redactionMap)` returns the original text: verified.

### Censor only the amounts

Per-label operators decide what happens to each entity type. `keep` leaves an
entity in place while still recording that it was processed, so a document can
have its deal sizes censored and nothing else:

```ts
import { DEFAULT_ENTITY_LABELS } from "@stll/anonymize/constants";
import { getDefaultNativePipeline } from "@stll/anonymize";

const pipeline = getDefaultNativePipeline({ language: "en" });
const operators = Object.fromEntries(
  DEFAULT_ENTITY_LABELS.filter((label) => label !== "monetary amount").map(
    (label) => [label, "keep"],
  ),
);
const { redaction } = pipeline.redactText(text, { operators });
```

```text
On 14 March 2025 Alice Smith (alice@example.com) wired the purchase price of USD 45,000,000 to IBAN DE89 3704 0044 0532 0130 00 and a deposit of EUR 250,000 to the notary.
```

Default operators (every default label replaced):

```text
On [DATE_1] [PERSON_1] ([EMAIL_ADDRESS_1]) wired the purchase price of [MONETARY_AMOUNT_1] to IBAN [IBAN_1] and a deposit of [MONETARY_AMOUNT_2] to the notary.
```

With `keep` for every label except `monetary amount`:

```text
On 14 March 2025 Alice Smith (alice@example.com) wired the purchase price of [MONETARY_AMOUNT_1] to IBAN DE89 3704 0044 0532 0130 00 and a deposit of [MONETARY_AMOUNT_2] to the notary.
```

The CLI exposes the same selection through `--labels`:

```bash
anonymize --labels "monetary amount" -k deal.key.json term-sheet.txt
anonymize --labels "monetary amount" -m redact --redact-string "[AMOUNT]" term-sheet.txt
```

### Same placeholders across related documents

A redaction session reuses placeholders for the same normalized entity across
documents, so a term sheet, the subscription agreement, and a later memo all
refer to the round size by one placeholder. `restoreText()` maps them back.

```ts
const session = pipeline.createRedactionSession("deal1");
const termSheet = session.redactText(termSheetText);
const subscription = session.redactText(subscriptionText);
```

```text
Term sheet: Northwind Ventures invests [MONETARY_AMOUNT_deal1_1] at a pre-money valuation of [MONETARY_AMOUNT_deal1_2].
Subscription agreement: the aggregate subscription price is [MONETARY_AMOUNT_deal1_1].
```

`session.restoreText()` on the second output returns the original text: verified.

The placeholder embeds the session id, so placeholders from different sessions
cannot collide and `restoreText()` refuses placeholders it does not own.

### Keep the currency, censor the figure

`resolvedEntities` carries offsets and text for every detected amount, so a
caller can apply its own replacement policy instead of the built-in
placeholder: keep the currency token and drop the number, bucket the amount
into a range, or round it. The rows below apply the first policy with a short
regular expression over each detected span (`$`, `€`, ISO codes, and a few
currency words are kept; the number and any magnitude word are replaced):

```ts
const CURRENCY_TOKEN =
  /^(?<lead>\p{Sc}|[A-Z]{3}\s)?(?<figure>.*?)(?<trail>\s?(?:\p{Sc}|[A-Z]{3}|Kč|euros?|dollars?))?$/u;

const keepCurrency = (text: string, index: number) => {
  const groups = CURRENCY_TOKEN.exec(text)?.groups;
  if (groups === undefined) {
    return `[AMOUNT_${index}]`;
  }
  return `${groups.lead ?? ""}[AMOUNT_${index}]${groups.trail ?? ""}`;
};

const { resolvedEntities } = pipeline.redactText(text);
let output = "";
let cursor = 0;
resolvedEntities
  .filter((entity) => entity.label === "monetary amount")
  .forEach((entity, i) => {
    output +=
      text.slice(cursor, entity.start) + keepCurrency(entity.text, i + 1);
    cursor = entity.end;
  });
output += text.slice(cursor);
```

| Input                                                                                    | Caller-side output                                                                      |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `Acme Holdings Ltd. acquired Beta Systems GmbH for $1.2 billion in cash and stock.`      | `Acme Holdings Ltd. acquired Beta Systems GmbH for $[AMOUNT_1] in cash and stock.`      |
| `The Series B round of USD 45,000,000 was led by Northwind Ventures on 14 March 2025.`   | `The Series B round of USD [AMOUNT_1] was led by Northwind Ventures on 14 March 2025.`  |
| `Purchase price: EUR 12.5 million, of which €2,500,000 is held in escrow for 18 months.` | `Purchase price: EUR [AMOUNT_1], of which €[AMOUNT_2] is held in escrow for 18 months.` |
| `The aggregate Earn-Out Payments shall not exceed $10,000,000 (the "Earn-Out Cap").`     | `The aggregate Earn-Out Payments shall not exceed $[AMOUNT_1] (the "Earn-Out Cap").`    |
| `The Company raised a $7.5M seed round and a Series A of $32M.`                          | `The Company raised a $[AMOUNT_1] seed round and a Series A of $[AMOUNT_2].`            |

The library does not parse amounts into numeric values; bucketing or rounding
is a caller-side step over the detected span.

## Known limits

The rows below are current output for shapes the detector does not handle
well.

| Input                                                  | Output                                                            | Monetary amounts     |
| ------------------------------------------------------ | ----------------------------------------------------------------- | -------------------- |
| `The fee is between $10 and $20 million.`              | `The fee is between [MONETARY_AMOUNT_1] and [MONETARY_AMOUNT_2].` | `$10`, `$20 million` |
| `Der Kaufpreis beträgt fünfundzwanzig Millionen Euro.` | `Der Kaufpreis beträgt fünfundzwanzig Millionen Euro.`            | none                 |

- Free-standing written-out amounts (`twenty-five million dollars`,
  `a million dollars`) are captured for English number words. Other
  languages write compound numerals as inflected single words and are covered
  through the keyword forms (`in Worten:`, `slovy:`, `en lettres:`).
- Lowercase magnitude shorthand counts only when attached to the digits
  (`$25m`, `£500k`, `$25mm`); `$25 m` and `$25 mm` read as length units.
- `between $10 and $20 million` yields two amounts; the shared magnitude is
  not distributed to the first figure.
- Consistency is by normalized surface form: `$25,000,000`, `USD 25,000,000`,
  and `$25m` are three placeholders, not one.
- With the all-language package an organization name may absorb prose between
  two capitalized words (`Northwind Ventures LLC invested in Acme Holdings
Ltd.` becomes one organization) because languages such as Czech or French
  capitalize only the first word of a name. The `en` package closes that
  bridge to a connector set (`of`, `the`, `and`, `for`, `&`, `de`, `von`, …),
  so English prose between two organizations is left in place.
- No detector catches everything. Review the entity list when a missed figure
  would matter, and use `redactTextWithCallerDetections()` to add spans from a
  model or a document-specific rule.
