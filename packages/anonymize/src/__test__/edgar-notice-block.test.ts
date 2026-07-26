/**
 * Regressions from EDGAR EX-10 material contracts:
 * - Jasper Therapeutics registration-rights (2026-07-17): counsel
 *   notice-block names, "represented by Shares" person FPs, and
 *   jurisdiction soft-wrap across a single line break.
 * - Cadrenal Therapeutics separation agreement (2026-07-17):
 *   notice-paren person + email, generational suffix vs city
 *   district, and Dodd-Frank statute person FP.
 * - PEDEVCO separation agreement (2026-07-17): middle-initial
 *   honorific/notice names and dual `/s/` signatures on one line.
 * - Lightwave Logic employment agreement (2026-07-20): Attn given
 *   name corpus gap and middle-initial counsel vs US city tokens.
 * - Twenty One Capital employment agreement (2026-07-21): soft-wrapped
 *   Skadden (UK) LLP counsel block.
 * - Utz Brands voting agreement (2026-07-22): notice-block counsel
 *   given names missing from the scoped English first-name corpus.
 * - Kingfish Holding employment agreement (2026-07-24): job-description
 *   heading person FP and Independence Day city-list address FP.
 * - Sidus Space employment agreement (2026-07-24): soft-wrapped `/s/`
 *   surname, mid-name issuer wrap before Inc., and soft-wrapped city
 *   headword labeled as a person.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative, redactNative } from "./native-detect";
import { loadTestDictionaries } from "./load-dictionaries";

const baseConfig: Omit<PipelineConfig, "dictionaries"> = {
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
  workspaceId: "edgar-notice-block-test",
  languages: ["en"],
  denyListCountries: ["US"],
  nameCorpusLanguages: ["en"],
};

const detect = async (
  text: string,
  overrides: Partial<Omit<PipelineConfig, "dictionaries">> = {},
): Promise<NativePipelineEntity[]> => {
  const dictionaries = await loadTestDictionaries({
    denyListCountries: ["US"],
    nameCorpusLanguages: ["en"],
  });
  return detectNative({ ...baseConfig, ...overrides, dictionaries }, text);
};

describe("EDGAR notice-block and securities-clause regressions", () => {
  test("counsel name above law-firm contact block is a person", async () => {
    const text = `PLEASE EMAIL OR FAX A COPY OF THE COMPLETED AND EXECUTED NOTICE
AND QUESTIONNAIRE, AND RETURN THE ORIGINAL BY OVERNIGHT MAIL, TO:

Dylan Caplan

DLA Piper LLP (US)

Fax +1 215 606 2168

ProjectComplement-DLACore@us.dlapiper.com`;
    const entities = await detect(text);
    const person = entities.find(
      (entity) => entity.label === "person" && entity.text === "Dylan Caplan",
    );
    expect(person).toBeDefined();
    expect(
      entities.some(
        (entity) =>
          entity.label === "organization" &&
          entity.text.includes("DLA Piper LLP"),
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) =>
          entity.label === "email address" &&
          entity.text === "ProjectComplement-DLACore@us.dlapiper.com",
      ),
    ).toBe(true);
  });

  test("represented by Shares is not a person", async () => {
    const text =
      "any Registrable Securities represented by Shares applied to the Holders on a pro rata basis";
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) => entity.label === "person" && entity.text === "Shares",
      ),
    ).toBe(false);
  });

  test("State of New York survives a single EDGAR line wrap", async () => {
    const text =
      "exclusive jurisdiction of the courts of the State of New\nYork for the purposes of any suit";
    const entities = await detect(text);
    const juris = entities.find(
      (entity) =>
        entity.label === "address" && entity.text.startsWith("State of"),
    );
    expect(juris?.text.replaceAll(/\s+/g, " ")).toBe("State of New York");
    expect(
      entities.some(
        (entity) => entity.label === "address" && entity.text === "York",
      ),
    ).toBe(false);
  });

  test("notice-paren contact name before title and email is a person", async () => {
    const text = `You may revoke this Agreement by giving notice in writing
to the Company (Quang Pham, Chief Executive Officer, quang.pham@cadrenal.com)
by 5:00 p.m. ET on the seventh day.`;
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) => entity.label === "person" && entity.text === "Quang Pham",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) =>
          entity.label === "email address" &&
          entity.text === "quang.pham@cadrenal.com",
      ),
    ).toBe(true);
  });

  test("generational suffix is not a city district after a person prefix", async () => {
    const text =
      "the “Company”), and James J. Ferguson III (hereinafter referred to as “you”)";
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" &&
          (entity.text === "James J. Ferguson III" ||
            entity.text === "James J. Ferguson"),
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) =>
          entity.label === "address" && entity.text === "Ferguson III",
      ),
    ).toBe(false);
  });

  test("Dodd-Frank Wall Street Reform is not a person", async () => {
    const text = `claims that you may have under the Dodd-Frank Wall Street
Reform and Consumer Protection Act.`;
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" &&
          (entity.text === "Frank Wall Street" ||
            entity.text === "Frank" ||
            entity.text.includes("Wall Street")),
      ),
    ).toBe(false);
  });

  test("middle initial after honorific stays in the person span", async () => {
    const text =
      "I must give written notice to Mr. Clark R. Moore of the Company";
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text === "Mr. Clark R. Moore",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) => entity.label === "address" && entity.text === "Moore",
      ),
    ).toBe(false);
  });

  test("middle initial between given name and surname is a person", async () => {
    const text =
      'between Paul A. Pinkston ("I" or "Employee"), and PEDEVCO Corp.';
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text === "Paul A. Pinkston",
      ),
    ).toBe(true);
  });

  test("two slash-s signatures on one line are both people", async () => {
    const text = "/s/ Paul A. Pinkston /s/ Clark R. Moore";
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text === "Paul A. Pinkston",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text === "Clark R. Moore",
      ),
    ).toBe(true);
  });

  test("Attn given name and surname are both a person", async () => {
    const text = `Attn: Clint Calli

Email: clint.calli@example.com`;
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) => entity.label === "person" && entity.text === "Clint Calli",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) => entity.label === "person" && entity.text === "Calli",
      ),
    ).toBe(false);
  });

  test("Attn middle-initial counsel name beats nested city addresses", async () => {
    const text = `Attn: Clayton E. Parker, Esq.

Email: Clayton.Parker@example.com`;
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text === "Clayton E. Parker",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) =>
          entity.label === "address" &&
          (entity.text === "Clayton" || entity.text === "Parker"),
      ),
    ).toBe(false);
  });

  test("soft-wrapped Skadden UK LLP counsel block is an organization", async () => {
    // Twenty One Capital EX-10.2 (2026-07-21): jurisdiction parenthetical
    // before LLP plus an EDGAR comma soft-wrap dropped the firm entirely.
    const text = `with a copy (which will not constitute
notice) to:

Skadden, Arps, Slate,
Meagher & Flom (UK) LLP

22 Bishopsgate,

EC2N 4BQ London

Attn: Lorenzo Corte`;
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "organization" &&
          entity.text
            .replaceAll(/\s+/g, " ")
            .includes("Skadden, Arps, Slate, Meagher & Flom (UK) LLP"),
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text === "Lorenzo Corte",
      ),
    ).toBe(true);
  });

  test("counsel name on a line after Attention is a person", async () => {
    // Utz Brands EX-10.1 voting agreement (2026-07-22): a co-counsel line
    // under Attention was left intact when the given name was absent from
    // names/first/en.json.
    const text = `Attention: Neil Stronski

Marissa Spalding

Email: neil.stronski@example.com`;
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text === "Marissa Spalding",
      ),
    ).toBe(true);
  });

  test("month-led legal terms are not people", async () => {
    const entities = await detect(
      "The June Effective Date and June Payment remain unchanged.",
    );
    expect(
      entities.some(
        (entity) => entity.label === "person" && entity.text.startsWith("June"),
      ),
    ).toBe(false);
  });

  test("Attention middle-initial counsel name is a person", async () => {
    const text = `Attention: Larry P. Laubach

Email: llaubach@example.com`;
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text === "Larry P. Laubach",
      ),
    ).toBe(true);
  });

  test("Attention co-addressee before title is a person", async () => {
    const text = `Attention: Howard Friedman, Chief Executive Officer;

Theresa Shea, Executive Vice President, Chief Legal

Officer and Corporate Secretary`;
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) => entity.label === "person" && entity.text === "Theresa Shea",
      ),
    ).toBe(true);
  });

  test("three-token counsel name after Attention stays whole", async () => {
    const text = `Attention: Scott R. Williams

Anika Hermann Bargfrede
Email: abargfrede@example.com`;
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" &&
          entity.text === "Anika Hermann Bargfrede",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text === "Hermann Bargfrede",
      ),
    ).toBe(false);
  });
  test("address stops at a contextual notice-prose boundary", async () => {
    // MVW Services separation agreement (2026-07-21): right-expansion walked
    // the return address into the notice sentence ("..., or emailed to").
    const text = `one executed original of this Agreement must be
mailed to 7812 Palm Parkway, Orlando, Florida 32836, or emailed to
Denise Haeggberg before the close of business.`;
    const entities = await detect(text);
    const addresses = entities.filter((entity) => entity.label === "address");
    expect(
      addresses.some(
        (entity) => entity.text === "7812 Palm Parkway, Orlando, Florida 32836",
      ),
    ).toBe(true);
    expect(addresses.some((entity) => entity.text.includes("emailed"))).toBe(
      false,
    );
  });

  test("address exits tolerate wrapped and repeated whitespace", async () => {
    for (const whitespace of ["\n", "\r\n", "\t", "  \t "]) {
      const text =
        "one executed original must be mailed to 7812 Palm Parkway, Orlando, Florida 32836, or" +
        whitespace +
        "emailed" +
        whitespace +
        "to Denise Haeggberg.";
      const entities = await detect(text);
      const addresses = entities.filter((entity) => entity.label === "address");
      expect(
        addresses.some(
          (entity) =>
            entity.text === "7812 Palm Parkway, Orlando, Florida 32836",
        ),
      ).toBe(true);
      expect(addresses.some((entity) => entity.text.includes("emailed"))).toBe(
        false,
      );
    }
  });

  test("address stops before participle-led delivery methods", async () => {
    for (const delivery of [
      "or sent by email to legal@example.com",
      "or sent by facsimile to the recipient",
      "and delivered via courier to the recipient",
    ]) {
      const text =
        "Notices must be mailed to 123 Main Street, Boston, Massachusetts 02110, " +
        delivery +
        ".";
      const entities = await detect(text);
      const addresses = entities.filter((entity) => entity.label === "address");
      expect(addresses.map((entity) => entity.text)).toContain(
        "123 Main Street, Boston, Massachusetts 02110",
      );
      expect(addresses.some((entity) => entity.text.includes(delivery))).toBe(
        false,
      );
    }
  });

  test("address stops before contextual provide prose", async () => {
    const text =
      "Notices must be mailed to 123 Main Street, Boston, Massachusetts 02110, and provide a copy to the Company.";
    const entities = await detect(text);
    const addresses = entities.filter((entity) => entity.label === "address");
    expect(
      addresses.some(
        (entity) =>
          entity.text === "123 Main Street, Boston, Massachusetts 02110",
      ),
    ).toBe(true);
    expect(addresses.some((entity) => entity.text.includes("provide"))).toBe(
      false,
    );
  });

  test("address keeps a conjunction that joins unit components", async () => {
    const text =
      "Notices must be mailed to 123 Main Street, Boston, Massachusetts 02110, Suite A and B.";
    const entities = await detect(text);
    const addresses = entities.filter((entity) => entity.label === "address");
    expect(
      addresses.some(
        (entity) =>
          entity.text ===
          "123 Main Street, Boston, Massachusetts 02110, Suite A and B",
      ),
    ).toBe(true);
  });

  test("address stops before an alternative-address notice clause", async () => {
    const text =
      "Notices must be mailed to 123 Main Street, Boston, Massachusetts 02110, or at such other address as the Company designates.";
    const entities = await detect(text);
    const addresses = entities.filter((entity) => entity.label === "address");
    expect(
      addresses.some(
        (entity) =>
          entity.text === "123 Main Street, Boston, Massachusetts 02110",
      ),
    ).toBe(true);
    expect(
      addresses.some((entity) => entity.text.includes("other address")),
    ).toBe(false);
  });

  test("address stops before an alternative email delivery clause", async () => {
    const text =
      "Notices must be mailed to 123 Main Street, Boston, Massachusetts 02110, or by email to legal@example.com.";
    const entities = await detect(text);
    const addresses = entities.filter((entity) => entity.label === "address");
    expect(
      addresses.some(
        (entity) =>
          entity.text === "123 Main Street, Boston, Massachusetts 02110",
      ),
    ).toBe(true);
    expect(addresses.some((entity) => entity.text.includes("by email"))).toBe(
      false,
    );
  });

  test("address stops before an alternative-address recipient clause", async () => {
    const text =
      "Notices must be mailed to 123 Main Street, Boston, Massachusetts 02110, or to such other address as the Company designates.";
    const entities = await detect(text);
    const addresses = entities.filter((entity) => entity.label === "address");
    expect(
      addresses.some(
        (entity) =>
          entity.text === "123 Main Street, Boston, Massachusetts 02110",
      ),
    ).toBe(true);
    expect(
      addresses.some((entity) => entity.text.includes("other address")),
    ).toBe(false);
  });

  test("address stops before an alternative email channel clause", async () => {
    const text =
      "Notices must be mailed to 123 Main Street, Boston, Massachusetts 02110, or via email to legal@example.com.";
    const entities = await detect(text);
    const addresses = entities.filter((entity) => entity.label === "address");
    expect(
      addresses.some(
        (entity) =>
          entity.text === "123 Main Street, Boston, Massachusetts 02110",
      ),
    ).toBe(true);
    expect(addresses.some((entity) => entity.text.includes("via email"))).toBe(
      false,
    );
  });

  test("address stops before an additional fax delivery clause", async () => {
    const text =
      "Notices must be mailed to 123 Main Street, Boston, Massachusetts 02110, and by fax to +1 617 555 0199.";
    const entities = await detect(text);
    const addresses = entities.filter((entity) => entity.label === "address");
    expect(
      addresses.some(
        (entity) =>
          entity.text === "123 Main Street, Boston, Massachusetts 02110",
      ),
    ).toBe(true);
    expect(addresses.some((entity) => entity.text.includes("by fax"))).toBe(
      false,
    );
  });

  test("address keeps an alternative unit component", async () => {
    const text =
      "Notices must be mailed to 123 Main Street, Boston, Massachusetts 02110, Suite A or B.";
    const entities = await detect(text);
    const addresses = entities.filter((entity) => entity.label === "address");
    expect(
      addresses.some(
        (entity) =>
          entity.text ===
          "123 Main Street, Boston, Massachusetts 02110, Suite A or B",
      ),
    ).toBe(true);
  });

  test("job description exhibit heading is not a person", async () => {
    const text = `Exhibit B

Chief Operating Officer Job Description

Manage daily operations of the scrap yard.`;
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text === "Job Description",
      ),
    ).toBe(false);
  });

  test("independence day holiday is not an address", async () => {
    const text =
      "Company-observed holidays consist of New Years Day, Memorial Day, Independence Day, Labor Day, Thanksgiving Day, Christmas Eve, and Christmas Day.";
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "address" && entity.text === "Independence Day",
      ),
    ).toBe(false);
  });

  test("day surname remains a person", async () => {
    const entities = await detect("Dorothy Day signed the agreement.");
    expect(
      entities.some(
        (entity) => entity.label === "person" && entity.text === "Dorothy Day",
      ),
    ).toBe(true);
  });

  test("soft-wrapped slash-s surname stays one person", async () => {
    // Sidus Space EX-10.1 (2026-07-24): `/s/ Alan\nKhalili` left Khalili.
    const text = `EXECUTIVE

/s/ Alan
Khalili
`;
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" &&
          entity.text.replaceAll(/\s+/g, " ") === "Alan Khalili",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) => entity.label === "person" && entity.text === "Alan",
      ),
    ).toBe(false);
  });

  test("soft-wrapped title-case issuer before Inc is an organization", async () => {
    // Sidus Space EX-10.1 (2026-07-24): `Sidus\nSpace, Inc.` left Sidus.
    const text = `If to the Company:

Sidus
Space, Inc.

150 N Example Ave`;
    const entities = await detect(text, { labels: ["organization"] });
    expect(
      entities.some(
        (entity) =>
          entity.label === "organization" &&
          entity.text.replaceAll(/\s+/g, " ") === "Sidus Space, Inc.",
      ),
    ).toBe(true);
  });

  test("field label is not absorbed into a wrapped organization", async () => {
    for (const enableTriggerPhrases of [true, false]) {
      const entities = await detect(
        `Attention
Acme Inc.`,
        { enableTriggerPhrases },
      );
      expect(
        entities.some(
          (entity) =>
            entity.label === "organization" && entity.text === "Acme Inc.",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "organization" &&
            entity.text.includes("Attention"),
        ),
      ).toBe(false);
    }
  });

  test("organization wrap boundaries follow the configured language", async () => {
    const entities = await detect(
      `If to the Company:

Bank
America, Inc.`,
      { enableTriggerPhrases: false },
    );
    expect(
      entities.some(
        (entity) =>
          entity.label === "organization" &&
          entity.text === "Bank America, Inc.",
      ),
    ).toBe(true);
  });

  test("only configured person fields authorize a name wrap", async () => {
    for (const [label, expected] of [
      ["Name", true],
      ["Invoice", false],
    ] as const) {
      const entities = await detect(`${label}:
Alice
Zephyr`);
      expect(
        entities.some(
          (entity) =>
            entity.label === "person" && entity.text === "Alice Zephyr",
        ),
      ).toBe(expected);
    }
  });

  test("soft-wrapped US city headword is an address not a person", async () => {
    // Sidus Space EX-10.1 (2026-07-24): `Merritt\nIsland, FL 32953`.
    const text = `Merritt
Island, FL 32953`;
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) => entity.label === "person" && entity.text === "Merritt",
      ),
    ).toBe(false);
    expect(
      entities.some(
        (entity) =>
          entity.label === "address" &&
          entity.text.replaceAll(/\s+/g, " ").includes("Merritt Island"),
      ),
    ).toBe(true);
  });

  test("soft-wrapped US city address variants resolve as one span", async () => {
    const dictionaries = await loadTestDictionaries({
      denyListCountries: ["AS", "US"],
      nameCorpusLanguages: [],
    });
    const texts = ["\n", "\r", "\r\n", "\u2028"].map(
      (separator) => `Merritt${separator}Island, FL 32953-1234`,
    );
    texts.push(`Bonita
Springs, CO 80903`);
    texts.push(`Fair
Oaks, CA 95628`);
    texts.push(`Coeur
d'Alene, ID 83814`);
    texts.push(`Pago
Pago, AS 96799`);
    texts.push(`Merritt
Island, FL 32953—Attention:`);
    const unscopedConfig = { ...baseConfig };
    delete unscopedConfig.languages;
    delete unscopedConfig.nameCorpusLanguages;
    for (const text of texts) {
      const expectedEnd = text.indexOf("—");
      const { redaction, resolvedEntities } = await redactNative(
        {
          ...unscopedConfig,
          dictionaries,
          denyListCountries: ["AS", "US"],
          labels: ["address"],
          threshold: 0.7,
        },
        text,
      );
      expect(redaction.redactedText).toBe(
        expectedEnd === -1 ? "[ADDRESS_1]" : "[ADDRESS_1]—Attention:",
      );
      expect(resolvedEntities).toHaveLength(1);
      expect(resolvedEntities[0]?.start).toBe(0);
      expect(resolvedEntities[0]?.end).toBe(
        expectedEnd === -1 ? text.length : expectedEnd,
      );
    }
  });

  test("person boundaries survive person-only selection", async () => {
    const dictionaries = await loadTestDictionaries({
      denyListCountries: ["US"],
      nameCorpusLanguages: ["en"],
    });
    for (const [text, expected] of [
      [
        `Alice
Boston, MA 02110`,
        "Alice",
      ],
      [
        `Name:
Alice Smith
Boston, MA 02110`,
        "Alice Smith",
      ],
    ]) {
      const entities = await detectNative(
        { ...baseConfig, dictionaries, labels: ["person"] },
        text,
      );
      expect(
        entities.some(
          (entity) => entity.label === "person" && entity.text === expected,
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "person" && entity.text.includes("Boston"),
        ),
      ).toBe(false);
    }
  });
});
