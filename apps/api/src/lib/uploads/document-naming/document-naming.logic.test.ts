import { expect, test } from "bun:test";

import { extensionOf } from "@/api/lib/uploads/document-naming/document-naming.logic";

test("a file extension is kept with its dot", () => {
  expect(extensionOf("scan 0042.pdf")).toBe(".pdf");
  expect(extensionOf("Smlouva.docx")).toBe(".docx");
});

test("a name without a file extension has none", () => {
  expect(extensionOf("Smlouva č. 5")).toBe("");
  expect(extensionOf(".env")).toBe("");
  expect(extensionOf("draft.")).toBe("");
});
