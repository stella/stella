/**
 * One-off script: inserts {{placeholder}} tags into the SPA DOCX
 * for testing template filling. Replaces specific text patterns
 * (party names, prices, dates) with placeholder tags.
 *
 * Run: bun apps/api/src/handlers/docx/prepare-spa-template.ts
 */
/* eslint-disable no-console */

import JSZip from "jszip";

const INPUT = new URL("fixtures/spa-template.docx", import.meta.url).pathname;

const OUTPUT = new URL(
  "fixtures/spa-template-with-placeholders.docx",
  import.meta.url,
).pathname;

/**
 * Replacements: [search text, placeholder tag].
 * We pick a few representative ones across different parts
 * of the document to test the fill flow.
 */
// For text split across runs, we do sequential replacement:
// each "xxxxx" occurrence maps to a share price placeholder.
const SEQUENTIAL_REPLACEMENTS: [string, string[]][] = [
  [
    "xxxxx",
    [
      "{{price_share_1}}",
      "{{price_share_2}}",
      "{{price_share_3}}",
      "{{price_share_4}}",
      "{{price_share_5}}",
    ],
  ],
];

// Date might also be split. Let's check both patterns.
const SIMPLE_REPLACEMENTS: [string, string][] = [
  ["27. května 2022", "{{contract_date}}"],
  ["ENCAP s.r.o.", "{{seller_1_name}}"],
  ["Pražské služby, a.s.", "{{buyer_name}}"],
];

const run = async () => {
  const file = Bun.file(INPUT);
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const docEntry = zip.file("word/document.xml");
  if (!docEntry) {
    throw new Error("No word/document.xml found");
  }

  let xml = await docEntry.async("string");

  // DOCX XML splits text across <w:t> elements. A simple
  // string like "xxxxx" might be in one <w:t> or split
  // across multiple runs. For our test, we work on the raw
  // XML and hope the text is contiguous. If not, we'd need
  // a proper XML-aware replacement.
  // Simple full-text replacements
  for (const [search, replacement] of SIMPLE_REPLACEMENTS) {
    xml = xml.replaceAll(search, replacement);
  }

  // Sequential: replace each occurrence with a different tag
  for (const [search, tags] of SEQUENTIAL_REPLACEMENTS) {
    let idx = 0;
    xml = xml.replaceAll(search, () => {
      const tag = tags[idx] ?? search;
      idx++;
      return tag;
    });
  }

  zip.file("word/document.xml", xml);

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });

  await Bun.write(OUTPUT, buffer);
};

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
