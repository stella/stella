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
    expect(reasons?.text).toContain(`dlužníka ${debtor}`);
  });

  test("keeps the paragraphs and their emphasis", () => {
    const out = anonymised();
    expect(out).toHaveLength(DECISION.length);
    expect(out.map(({ bold }) => bold)).toEqual(
      DECISION.map(({ bold }) => bold),
    );
  });

  test("fails closed where a birth number survives the pipeline", () => {
    const leaky = {
      redactText: (text: string) => pipeline.redactText(text),
      redactTextWithCallerDetections: (text: string) => ({
        ...pipeline.redactText(""),
        redaction: {
          redactedText: text,
          redactionMap: new Map<string, string>(),
          operatorMap: new Map(),
          entityCount: 0,
        },
      }),
    };
    const result = anonymizeCzIsirParagraphs(leaky, [
      paragraph("Dlužník, r. č. 750403/1234, podal návrh."),
    ]);
    expect(Result.isError(result) && result.error.reason).toBe(
      CZ_ISIR_ANONYMIZATION_FAILURE.BIRTH_NUMBER_LEFT,
    );
  });
});
