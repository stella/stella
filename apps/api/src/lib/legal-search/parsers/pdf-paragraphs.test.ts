import { PDF } from "@libpdf/core";
import { expect, test } from "bun:test";

import {
  assemblePdfParagraphs,
  extractPdfParagraphLines,
} from "@/api/lib/legal-search/parsers/pdf-paragraphs";
import type { PdfParagraphLine } from "@/api/lib/legal-search/parsers/pdf-paragraphs";

test("note boundaries preserve body text, note identity and caller-owned runs", () => {
  const note = { type: "footnote", label: "1", noteId: "note-1" } as const;
  const lines = [
    { type: "text", indented: false, runs: [{ text: "Body", bold: false }] },
    {
      type: "text",
      indented: false,
      note,
      runs: [{ text: "1 Foot-", bold: false }],
    },
    {
      type: "text",
      indented: false,
      note,
      runs: [{ text: "note", bold: false }],
    },
    {
      type: "text",
      indented: false,
      runs: [{ text: "Body resumes", bold: false }],
    },
  ] satisfies PdfParagraphLine[];
  const before = structuredClone(lines);
  expect(assemblePdfParagraphs(lines)).toEqual([
    { runs: [{ text: "Body", bold: false }] },
    { runs: [{ text: "1 Footnote", bold: false }], note },
    { runs: [{ text: "Body resumes", bold: false }] },
  ]);
  expect(lines).toEqual(before);
});

test("PDF footnote detection is opt-in and retains source fonts and geometry", async () => {
  const pdf = PDF.create();
  const page = pdf.addPage({ size: "letter" });
  page.drawText("Heading", { x: 70, y: 720, size: 18 });
  for (let index = 0; index < 2; index++) {
    page.drawText(`Body line ${index}`, {
      x: 70,
      y: 680 - index * 40,
      size: 12,
    });
  }
  page.drawText("1 Footnote", { x: 70, y: 100, size: 8 });
  page.drawText("continues here", { x: 70, y: 88, size: 8 });
  const bytes = await pdf.save();
  const ordinary = await extractPdfParagraphLines(bytes);
  expect(
    ordinary.every((line) => line.type === "blank" || line.note === undefined),
  ).toBe(true);
  const detected = await extractPdfParagraphLines(bytes, {
    footnotes: "detect",
  });
  const notes = detected
    .filter((line) => line.type === "text")
    .filter((line) => line.note !== undefined);
  expect(notes).toHaveLength(2);
  expect(notes.at(0)).toMatchObject({
    note: { type: "footnote", label: "1" },
    source: { pageIndex: 0, bbox: { x: 70 }, spans: [{ fontSize: 8 }] },
  });
  expect(notes.at(0)?.note).toEqual(notes.at(1)?.note);
});
