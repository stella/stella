import { describe, expect, it } from "bun:test";

import { filterDocumentsByQuery } from "@/components/breadcrumbs/document-switcher.logic";

const documents = [
  { id: "letter", fileName: "Side Letter.pdf", name: null },
  { id: "smlouva", fileName: "Kupní smlouva.docx", name: null },
  { id: "renamed", fileName: "scan-0042.pdf", name: "Signed engagement" },
];

describe("filterDocumentsByQuery", () => {
  it("matches the file name without regard to case or accents", () => {
    expect(
      filterDocumentsByQuery(documents, "kupni").map(({ id }) => id),
    ).toEqual(["smlouva"]);
    expect(
      filterDocumentsByQuery(documents, "SIDE").map(({ id }) => id),
    ).toEqual(["letter"]);
  });

  it("matches the entity name when the file name does not carry it", () => {
    expect(
      filterDocumentsByQuery(documents, "engagement").map(({ id }) => id),
    ).toEqual(["renamed"]);
  });

  it("keeps every document in order for a blank query", () => {
    expect(filterDocumentsByQuery(documents, "  ")).toEqual(documents);
  });
});
