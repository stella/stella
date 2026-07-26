// Regressions reported from a real Czech share-purchase
// agreement: five recall / precision misses on canonical
// Czech contract shapes (demonstrative pronouns flagged
// as people, titled and untitled persons missed, a.s.
// joint-stock organisations missed, commercial-register
// references not emitted).

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";

setDefaultTimeout(15_000);

const CONFIG: PipelineConfig = {
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
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "test",
};

const detect = async (text: string) => detectNative(CONFIG, text);

// ── Case 1: demonstrative pronouns must not be persons ──

describe("Czech demonstrative pronouns are never persons", () => {
  // "Tato" collides with a rare given name in the
  // first-name corpus, so deny-list / name-corpus paths
  // emit it as a person unless person-stopwords reject
  // it at filter time.
  test("Tato smlouva is not a person", async () => {
    const entities = await detect(
      'Tato smlouva (dále jen "Smlouva") byla uzavřena.',
    );
    const persons = entities.filter((e) => e.label === "person");
    expect(persons.map((p) => p.text)).not.toContain("Tato");
  });

  test("Tato as sole token never emits a person", async () => {
    const entities = await detect("Tato Smlouva");
    expect(entities.filter((e) => e.label === "person")).toEqual([]);
  });

  test("Tento, Tito, Tyto, Toto are not persons", async () => {
    for (const pronoun of ["Tento", "Tito", "Tyto", "Toto"]) {
      const entities = await detect(`${pronoun} dokument byl podepsán.`);
      expect(entities.some((e) => e.label === "person")).toBe(false);
    }
  });
});

// ── Case 2: "Ing." title separators (tabs, NBSPs, …) ────

describe("Czech engineering title 'Ing.' captures the full name", () => {
  test("Ing. <space> Name", async () => {
    const entities = await detect("Ing. Stanislav Braňka");
    const person = entities.find((e) => e.label === "person");
    expect(person).toBeDefined();
    expect(person!.text).toBe("Ing. Stanislav Braňka");
  });

  // DOCX exports commonly place a TAB between the title
  // and the name. The titled-person regex must accept
  // tabs as an inter-token separator alongside spaces.
  test("Ing. <tab> Name keeps title in the span", async () => {
    const entities = await detect("Ing.\tStanislav Braňka");
    const person = entities.find((e) => e.label === "person");
    expect(person).toBeDefined();
    expect(person!.text).toBe("Ing.\tStanislav Braňka");
  });

  test("Ing. <NBSP> Name keeps title in the span", async () => {
    const entities = await detect("Ing. Stanislav Braňka");
    const person = entities.find((e) => e.label === "person");
    expect(person).toBeDefined();
    expect(person!.text).toBe("Ing. Stanislav Braňka");
  });

  test("Ing. Name in a representation clause", async () => {
    const entities = await detect(
      "zastoupená Ing. Stanislav Braňka, předseda představenstva",
    );
    expect(
      entities.some(
        (e) => e.label === "person" && e.text === "Ing. Stanislav Braňka",
      ),
    ).toBe(true);
  });
});

// ── Case 3: untitled person + birthdate / address ──────

describe("Untitled Czech person anchored by birth-date label", () => {
  // "Miroslav Braňka" has a known first name + plausible
  // surname but no title, so the deny-list path emits
  // it at score 0.5. With a "dat. nar." birth-date label
  // adjacent, the hotword layer must boost it past the
  // default 0.5 threshold (the user's pipeline runs at
  // 0.5).
  test("name + dat. nar. <date> is emitted at threshold 0.5", async () => {
    const entities = await detectNative(
      { ...CONFIG, threshold: 0.5 },
      "Miroslav Braňka, dat. nar. 26. října 1972, Bydliště: č.p. 208, 289 14 Chrást",
    );
    expect(
      entities.some(
        (e) => e.label === "person" && e.text === "Miroslav Braňka",
      ),
    ).toBe(true);
  });

  test("name + Bydliště <address> is emitted at threshold 0.5", async () => {
    const entities = await detectNative(
      { ...CONFIG, threshold: 0.5 },
      "Miroslav Braňka, Bydliště: Pod Šancemi 444/1, 180 00 Praha 9",
    );
    expect(
      entities.some(
        (e) => e.label === "person" && e.text === "Miroslav Braňka",
      ),
    ).toBe(true);
  });
});

// ── Case 4: a.s. joint-stock organisations ────────────

describe("Czech a.s. organisations land as one organization entity", () => {
  test("Pražské služby, a.s. (compact form)", async () => {
    const entities = await detect("Pražské služby, a.s.");
    expect(
      entities.some(
        (e) => e.label === "organization" && e.text === "Pražské služby, a.s.",
      ),
    ).toBe(true);
  });

  test("Pražské služby, a. s. (spaced form)", async () => {
    const entities = await detect("Pražské služby, a. s.");
    expect(
      entities.some(
        (e) => e.label === "organization" && e.text === "Pražské služby, a. s.",
      ),
    ).toBe(true);
  });

  test("Pražské služby, a. s. inside party-block sentence", async () => {
    const entities = await detect(
      "(1) Pražské služby, a. s., IČO: 60194120, se sídlem Pod Šancemi 444/1, 180 00 Praha 9",
    );
    expect(
      entities.some(
        (e) => e.label === "organization" && e.text === "Pražské služby, a. s.",
      ),
    ).toBe(true);
  });
});

// ── Case 5: Czech commercial-register references ──────

describe("Czech commercial-register reference (oddíl X, vložka NNN)", () => {
  // The full phrase uniquely identifies the company in
  // the Czech business registry. Emit it as a single
  // registration-number entity rather than only
  // capturing the trailing digits.
  test("compact form: oddíl C, vložka 334648", async () => {
    const entities = await detect("oddíl C, vložka 334648");
    expect(
      entities.some(
        (e) =>
          e.label === "registration number" &&
          e.text === "oddíl C, vložka 334648",
      ),
    ).toBe(true);
  });

  test("inside a contract clause", async () => {
    const entities = await detect(
      "zapsaná v obchodním rejstříku vedeném Městským soudem v Praze, oddíl C, vložka 334648, IČO: 25712345",
    );
    expect(
      entities.some(
        (e) =>
          e.label === "registration number" &&
          e.text === "oddíl C, vložka 334648",
      ),
    ).toBe(true);
  });

  test("section B (banks / a.s.) with whitespace variants", async () => {
    const entities = await detect("oddíl B, vložka  2432");
    expect(
      entities.some(
        (e) =>
          e.label === "registration number" &&
          /^oddíl B,\s+vložka\s+2432$/u.test(e.text),
      ),
    ).toBe(true);
  });

  // NATIVE-GAP: when the vložka number is followed by a trailing period,
  // the native trigger detector captures "12345." (including the period) at
  // that offset and, via one-match-per-offset priority, shadows the
  // commercial-register regex that would emit the full "oddíl C, vložka 12345"
  // phrase. The same inputs without a trailing period match correctly (see the
  // passing cases above). The sensitive value is still redacted, but the span
  // over-captures punctuation and misses the documented full-phrase capture.
  test("lowercase 'oddíl' (mid-sentence usage)", async () => {
    const entities = await detect(
      "vedená v obchodním rejstříku, oddíl C, vložka 12345.",
    );
    expect(
      entities.some(
        (e) =>
          e.label === "registration number" &&
          e.text === "oddíl C, vložka 12345",
      ),
    ).toBe(true);
  });

  test("uppercase registry cue with lowercase section", async () => {
    const entities = await detect("ODDÍL c, VLOŽKA 12345");
    expect(
      entities.some(
        (e) =>
          e.label === "registration number" &&
          e.text === "ODDÍL c, VLOŽKA 12345",
      ),
    ).toBe(true);
  });
});

// ── Case: title + first name + uppercase surname ─────────

describe("Title-led uppercase surnames without dictionary evidence", () => {
  test("requires an adjacent vocabulary title", async () => {
    for (const [text, expected] of [
      ["Ing. Ctibor WURTZEL podepsal smlouvu.", "Ctibor WURTZEL"],
      ["Ing. Ctibor WURTZEL-VL projekt", "Ctibor WURTZEL-VL"],
      ["Ctibor WURTZEL podepsal smlouvu.", undefined],
    ] as const) {
      const people = (await detect(text)).filter(
        (entity) => entity.label === "person",
      );
      expect(people.some((entity) => entity.text.includes("WURTZEL"))).toBe(
        expected !== undefined,
      );
      if (expected !== undefined) {
        expect(people.some((entity) => entity.text.includes(expected))).toBe(
          true,
        );
      }
    }
  });
});

// ── Case: party-role triggers must not force sole traders to org ──

describe("Czech zhotovitel/objednatel person-shaped parties", () => {
  test("titled sole trader after Zhotovitel is a person", async () => {
    const entities = await detect("Zhotovitel:\nIng. Jan Novák\n");
    expect(
      entities.some((e) => e.label === "person" && e.text === "Ing. Jan Novák"),
    ).toBe(true);
    expect(
      entities.some(
        (e) => e.label === "organization" && e.text.includes("Jan Novák"),
      ),
    ).toBe(false);
  });

  test("untitled sole trader after Zhotovitel is a person", async () => {
    const entities = await detect("Zhotovitel:\nPetr Novák\n");
    expect(
      entities.some((e) => e.label === "person" && e.text === "Petr Novák"),
    ).toBe(true);
    expect(
      entities.some(
        (e) => e.label === "organization" && e.text === "Petr Novák",
      ),
    ).toBe(false);
  });

  test("institutional objednatel stays an organization", async () => {
    const entities = await detect(
      "Objednatel:\nSpráva a údržba silnic Plzeňského kraje\n",
    );
    expect(
      entities.some(
        (e) =>
          e.label === "organization" &&
          e.text === "Správa a údržba silnic Plzeňského kraje",
      ),
    ).toBe(true);
  });
});
