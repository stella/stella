import { describe, expect, test } from "bun:test";

import { selectHouseStyleTemplate } from "@/api/lib/templates/reformat-into-template";

const candidate = (
  id: string,
  name: string,
  guidance: { whenToUse?: string; whenNotToUse?: string } = {},
) => ({
  id,
  name,
  tags: ["house-style"],
  whenToUse: guidance.whenToUse ?? null,
  whenNotToUse: guidance.whenNotToUse ?? null,
});

describe("selectHouseStyleTemplate", () => {
  test("takes the only candidate", () => {
    expect(
      selectHouseStyleTemplate({
        candidates: [candidate("a", "Letter")],
        documentName: "Lease agreement.docx",
      }),
    ).toEqual({ status: "selected", template: candidate("a", "Letter") });
  });

  test("takes the candidate whose name and guidance share the most words", () => {
    const selection = selectHouseStyleTemplate({
      candidates: [
        candidate("a", "Letter", { whenToUse: "Letters to clients" }),
        candidate("b", "Contract", { whenToUse: "Smlouvy a dohody" }),
      ],
      documentName: "Smlouva o dílo - dohody.docx",
    });
    expect(selection).toMatchObject({ template: { id: "b" } });
  });

  test("leaves out a candidate whose guidance excludes the document", () => {
    const selection = selectHouseStyleTemplate({
      candidates: [
        candidate("a", "Agreement", { whenNotToUse: "Bilingual agreements" }),
        candidate("b", "Memo"),
      ],
      documentName: "Bilingual agreement.docx",
    });
    expect(selection).toMatchObject({ template: { id: "b" } });
  });

  test("answers with the candidates on a tie and with none when nothing is tagged", () => {
    expect(
      selectHouseStyleTemplate({
        candidates: [candidate("a", "First"), candidate("b", "Second")],
        documentName: "Agreement.docx",
      }),
    ).toMatchObject({ status: "ambiguous" });
    expect(
      selectHouseStyleTemplate({ candidates: [], documentName: "Agreement" }),
    ).toEqual({ status: "none" });
  });
});
