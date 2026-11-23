import { Result } from "better-result";
import { expect, test } from "bun:test";

import { inspectDocxPackage } from "@stll/folio-core/server";

import {
  cleanedTranscriptDocx,
  markdownText,
  transcriptDocx,
  transcriptMarkdown,
  transcriptTimestamp,
} from "./transcript";

const xmlPart = async (bytes: ArrayBuffer, path: string) => {
  const inspection = await inspectDocxPackage(bytes, { xmlParts: [path] });
  return inspection.xmlParts.find((part) => part.path === path)?.text ?? "";
};

test("the document leads each paragraph with its time and keeps spoken words literal", () => {
  expect(transcriptTimestamp(0)).toBe("0:00");
  expect(transcriptTimestamp(102_000)).toBe("1:42");
  expect(transcriptTimestamp(3_725_000)).toBe("1:02:05");
  expect(markdownText("a *b* [c] `d` ~e~ \\f")).toBe(
    "a \\*b\\* \\[c\\] \\`d\\` \\~e\\~ \\\\f",
  );
  expect(markdownText("snake_case stays, _this_ is escaped")).toBe(
    "snake_case stays, \\_this\\_ is escaped",
  );
  expect(markdownText("a <b> tag\nand\ttabs")).toBe("a \\<b> tag and tabs");
  expect(
    transcriptMarkdown({
      title: "Memo",
      paragraphs: [
        { startMs: 0, text: "First." },
        { startMs: 5000, text: "   " },
        { startMs: 65_000, text: "Second." },
      ],
    }),
  ).toBe("# Memo\n\n**0:00** First.\n\n**1:05** Second.");
});

test("the transcript is a Word document with a heading and bold timestamps", async () => {
  const bytes = Result.unwrap(
    await transcriptDocx({
      title: "Memo",
      paragraphs: [{ startMs: 65_000, text: "They propose a joint *expert*." }],
    }),
  );
  const documentXml = await xmlPart(bytes, "word/document.xml");
  expect(documentXml).toContain('w:val="Heading1"');
  expect(documentXml).toContain("1:05");
  // Spoken asterisks stay literal text, never emphasis.
  expect(documentXml).toContain("<w:t>*</w:t>");
  expect(documentXml).not.toContain("<w:i/>");
});

test("the cleaned-up text becomes Word headings, emphasis and lists under a grey note of the instructions", async () => {
  const bytes = Result.unwrap(
    await cleanedTranscriptDocx({
      markdown: [
        "# Odpověď",
        "## Shrnutí",
        "### Detail",
        "Dobrý den, **děkuji** za *zprávu*.",
        "- první\n- druhý",
        "1. jedna\n2. dvě",
      ].join("\n\n"),
      instructions: ["Udělej z toho e-mail.", "Formálně."],
      instructionsLabel: "Pokyny k diktátu:",
    }),
  );
  const documentXml = await xmlPart(bytes, "word/document.xml");
  for (const style of ["Heading1", "Heading2", "Heading3"]) {
    expect(documentXml).toContain(`w:val="${style}"`);
  }
  expect(documentXml).toContain("<w:b/>");
  expect(documentXml).toContain("<w:i/>");
  expect(documentXml).toContain("<w:numPr>");
  expect(documentXml).not.toContain("**");
  expect(documentXml).not.toContain("- první");
  // The note comes first, in grey italics, each instruction on its own line.
  const note = documentXml.indexOf("Pokyny k diktátu:");
  expect(note).toBeGreaterThan(-1);
  expect(note).toBeLessThan(documentXml.indexOf("Odpověď"));
  expect(documentXml).toContain('w:color w:val="737373"');
  expect(documentXml).toContain("Formálně.");

  const plain = Result.unwrap(
    await cleanedTranscriptDocx({
      markdown: "Text.",
      instructions: [],
      instructionsLabel: "Pokyny k diktátu:",
    }),
  );
  expect(await xmlPart(plain, "word/document.xml")).not.toContain(
    "Pokyny k diktátu:",
  );
});
