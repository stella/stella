import { describe, expect, test } from "bun:test";

import { cellCitationFields } from "./cell-citation-open.logic";

const main = { id: "main", propertyId: "file", content: { type: "file" } };
const annex = { id: "annex", propertyId: "file-2", content: { type: "file" } };
const cap = {
  id: "cap",
  propertyId: "liability-cap",
  content: { type: "text" },
};
const fields = [main, annex, cap];

describe("the fields a cited cell opens", () => {
  test("opens the file the cell's justification names", () => {
    expect(
      cellCitationFields({
        fields,
        justifications: [{ fieldId: "cap", fileFieldIds: ["annex"] }],
        propertyId: "liability-cap",
      }),
    ).toEqual({ cell: cap, file: annex });
  });

  test("falls back to the first file without a justification", () => {
    expect(
      cellCitationFields({
        fields,
        justifications: [],
        propertyId: "liability-cap",
      }),
    ).toEqual({ cell: cap, file: main });
  });

  test("is null once the document no longer has the cell", () => {
    expect(
      cellCitationFields({ fields, justifications: [], propertyId: "gone" }),
    ).toBeNull();
  });
});
