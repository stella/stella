/**
 * The register's documents anonymised before storage, through the real
 * Czech pipeline. Every person, birth date, birth number and address here is
 * invented; the party block and reasons follow the shape a high court's
 * decision prints.
 */
import { Result } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";

import { createPipeline } from "@stll/anonymize";

import {
  anonymizeCzIsirParagraphs,
  createCzIsirAnonymizer,
  CZ_ISIR_ANONYMIZATION_FAILURE,
} from "@/api/handlers/case-law/ingestion/adapters/cz-isir-anonymization";
import type { CzIsirParagraph } from "@/api/handlers/case-law/ingestion/parsers/cz-isir";

let pipeline: Awaited<ReturnType<typeof createPipeline>>;
beforeAll(async () => {
  pipeline = await createPipeline({ language: "cs" });
});

const paragraph = (text: string, bold = false): CzIsirParagraph => ({
  text,
  bold,
});

const DECISION: CzIsirParagraph[] = [
  paragraph("č. j. KSPH 38 INS 1234/2021 2 VSPH 500/2023-B-31", true),
  paragraph("USNESENÍ", true),
  paragraph(
    "Vrchní soud v Praze jako soud odvolací rozhodl v senátě složeném z předsedy JUDr. Karla Vzorného a soudců Mgr. Evy Pokusné a JUDr. Oldřicha Zkušebního v insolvenční věci dlužníka: Pavel Vrábek, narozený 3. 4. 1975, bytem Dlouhá 12, 110 00 Praha 1, o odvolání věřitele Beta finance s.r.o., IČO 12345678, sídlem Krátká 5, 602 00 Brno, zastoupeného advokátem Mgr. Tomášem Ukázkovým, proti usnesení Krajského soudu v Praze ze dne 6. listopadu 2023, č. j. KSPH 38 INS 1234/2021-B-20,",
  ),
  paragraph("takto:", true),
  paragraph(
    "Usnesení Krajského soudu v Praze ze dne 6. listopadu 2023, č. j. KSPH 38 INS 1234/2021-B-20, se potvrzuje.",
  ),
  paragraph("Odůvodnění:", true),
  paragraph(
    "1. Soud prvního stupně schválil oddlužení dlužníka Pavla Vrábka plněním splátkového kalendáře; dlužník má platit 4 500 Kč měsíčně. Vrábka v řízení zastupoval jeho bratr, který je rovněž dlužníkem věřitele.",
  ),
  paragraph("Praha 22. února 2024"),
  paragraph("JUDr. Karel Vzorný v. r. předseda senátu"),
];

/**
 * The real pipeline's detection, with the redaction scripted per masked
 * paragraph (`[redacted text, placeholder → original]`); a paragraph with
 * no script comes back unchanged, as from a redactor that missed everything.
 */
const scripted = (
  script: Record<string, [string, Record<string, string>]> = {},
) => ({
  redactText: (text: string) => pipeline.redactText(text),
  redactTextWithCallerDetections: (text: string) => {
    const [redactedText, originals] = script[text] ?? [text, {}];
    return {
      ...pipeline.redactText(""),
      redaction: {
        redactedText,
        redactionMap: new Map(Object.entries(originals)),
        operatorMap: new Map(),
        entityCount: 0,
      },
    };
  },
});

const texts = (
  redactor: ReturnType<typeof scripted>,
  ...lines: string[]
): string[] => {
  const result = anonymizeCzIsirParagraphs(
    redactor,
    lines.map((line) => paragraph(line)),
  );
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value.map(({ text }) => text);
};

const anonymised = () => {
  const result = anonymizeCzIsirParagraphs(pipeline, DECISION);
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

describe("anonymizeCzIsirParagraphs", () => {
  test("replaces every natural person's name, birth date and residence", () => {
    const text = anonymised()
      .map(({ text: line }) => line)
      .join("\n");
    for (const personal of [
      "Vrábek",
      "Vrábka",
      "Pavel",
      "3. 4. 1975",
      "Dlouhá 12",
      "110 00",
      "Vzorn",
      "Pokusn",
      "Zkušebn",
      "Ukázkov",
    ]) {
      expect(text).not.toContain(personal);
    }
  });

  test("keeps the court, dockets, dates, amounts and companies", () => {
    const text = anonymised()
      .map(({ text: line }) => line)
      .join("\n");
    for (const kept of [
      "Vrchní soud v Praze",
      "2 VSPH 500/2023-B-31",
      "KSPH 38 INS 1234/2021-B-20",
      "6. listopadu 2023",
      "4 500 Kč",
      "Beta finance s.r.o.",
      "Praha 22. února 2024",
    ]) {
      expect(text).toContain(kept);
    }
  });

  test("names one person with one placeholder across paragraphs and cases", () => {
    const out = anonymised();
    const header = out[2];
    const reasons = out[6];
    const debtor = /dlužníka: (?<placeholder>\[PERSON_\d+\])/u.exec(
      header?.text ?? "",
    )?.groups?.["placeholder"];
    expect(debtor).toBeDefined();
    expect(reasons?.text).toContain(`dlužníka ${String(debtor)}`);
  });

  test("keeps the paragraphs and their emphasis", () => {
    const out = anonymised();
    expect(out).toHaveLength(DECISION.length);
    expect(out.map(({ bold }) => bold)).toEqual(
      DECISION.map(({ bold }) => bold),
    );
  });

  test("fails closed where a birth number survives the pipeline", () => {
    for (const text of [
      "Dlužník, r. č. 750403/1234, podal návrh.",
      "Dlužník, r. č. 7504031234, podal návrh.",
      "Dlužník, rodné číslo: 7504031234, podal návrh.",
    ]) {
      const result = anonymizeCzIsirParagraphs(scripted(), [paragraph(text)]);
      expect(Result.isError(result) && result.error.reason).toBe(
        CZ_ISIR_ANONYMIZATION_FAILURE.BIRTH_NUMBER_LEFT,
      );
    }
  });

  test("replaces an ISO birth date and keeps an ISO date of anything else", () => {
    expect(
      texts(
        scripted(),
        "dlužník narozený 1975-04-03 podal dne 2023-11-06 návrh.",
      ),
    ).toEqual([
      "dlužník narozený [DATE_OF_BIRTH_1] podal dne 2023-11-06 návrh.",
    ]);
  });

  test("replaces a birth date that opens the paragraph after its trigger", () => {
    expect(
      texts(scripted(), "dlužník, narozený", "3. 4. 1975, podal návrh."),
    ).toEqual(["dlužník, narozený", "[DATE_OF_BIRTH_1], podal návrh."]);
  });

  test("sweeps a short name word wherever it stands alone", () => {
    const out = texts(
      scripted(),
      "dlužník Jan Novák, narozený 3. 4. 1975, podal návrh.",
      "Jan to doložil.",
    ).join("\n");
    expect(out).not.toContain("Jan");
    expect(out).not.toContain("Novák");
  });

  test("fails closed where a residence the pipeline missed still stands", () => {
    const result = anonymizeCzIsirParagraphs(scripted(), [
      paragraph(
        "dlužník, adresou trvalého pobytu Vzorová 12, Vzorov, podal návrh.",
      ),
    ]);
    expect(Result.isError(result) && result.error.reason).toBe(
      CZ_ISIR_ANONYMIZATION_FAILURE.RESIDENCE_LEFT,
    );
  });

  test("keeps two people of one surname apart, and a bare surname from both", () => {
    const out = texts(
      scripted({
        "Martin Novák a Marek Novák podali odvolání.": [
          "[PERSON_1] a [PERSON_2] podali odvolání.",
          { "[PERSON_1]": "Martin Novák", "[PERSON_2]": "Marek Novák" },
        ],
        "Martina Nováka zastupuje advokát.": [
          "[PERSON_1] zastupuje advokát.",
          { "[PERSON_1]": "Martina Nováka" },
        ],
        "Novák nesouhlasí.": [
          "[PERSON_1] nesouhlasí.",
          { "[PERSON_1]": "Novák" },
        ],
      }),
      "Martin Novák a Marek Novák podali odvolání.",
      "Martina Nováka zastupuje advokát.",
      "Novák nesouhlasí.",
    );
    expect(out).toEqual([
      "[PERSON_1] a [PERSON_2] podali odvolání.",
      "[PERSON_1] zastupuje advokát.",
      "[PERSON_3] nesouhlasí.",
    ]);
  });

  test("fails closed where a replaced span takes a docket with it", () => {
    const result = anonymizeCzIsirParagraphs(
      scripted({
        "Pavel ⟦D0⟧ podal odvolání.": [
          "[PERSON_1] podal odvolání.",
          { "[PERSON_1]": "Pavel ⟦D0⟧" },
        ],
      }),
      [paragraph("Pavel MSPH 60 INS 10782/2023 podal odvolání.")],
    );
    expect(Result.isError(result) && result.error.reason).toBe(
      CZ_ISIR_ANONYMIZATION_FAILURE.STRUCTURE_LOST,
    );
  });
});

describe("createCzIsirAnonymizer", () => {
  test("prepares again after a failed preparation", async () => {
    let calls = 0;
    const anonymizer = createCzIsirAnonymizer(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("not ready");
      }
      return scripted();
    });
    const [failed] = await Promise.allSettled([anonymizer.load()]);
    expect(failed.status).toBe("rejected");
    await anonymizer.load();
    await anonymizer.load();
    expect(calls).toBe(2);
  });
});
