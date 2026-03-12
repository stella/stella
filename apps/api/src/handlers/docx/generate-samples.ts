/* eslint-disable no-console */
/**
 * Generate sample DOCX files for manual verification in Word.
 *
 * Run: bun apps/api/src/handlers/docx/generate-samples.ts
 *
 * Outputs to ~/Downloads/:
 *   - sample-tracked-changes.docx   (mode c: edits only)
 *   - sample-with-comments.docx     (mode c: edits + comments)
 *   - sample-filled-template.docx   (mode b: rich patch values)
 */

import { Result } from "better-result";

import { diffParagraphs } from "./diff-paragraphs";
import { editWithTracking } from "./edit-with-tracking";
import { extractText } from "./extract-text";
import { markdownToDocx } from "./markdown-to-docx";
import { fillTemplate } from "./patch-template";
import type { DocxEditSet } from "./types";

const OUT = "/Users/sok0/Downloads";

const AUTHOR = {
  name: "Stella AI",
  date: new Date().toISOString(),
};

// ── Sample 1: Tracked changes ─────────────────────────────

const generateTrackedChanges = async () => {
  // Start with a markdown-generated DOCX as the base document
  const base = await markdownToDocx(`# Share Purchase Agreement

## Article 1 — Definitions

In this Agreement, the following terms shall have the meanings assigned to them below.

### 1.1 Purchase Price

The Purchase Price shall be one million Czech crowns (CZK 1,000,000).

### 1.2 Closing Date

The Closing Date shall be 31 March 2026.

## Article 2 — Representations

The Seller represents and warrants that the Shares are free from all encumbrances.

The Buyer acknowledges that it has conducted its own due diligence.
`);

  // Extract text to see paragraph indices
  const extracted = await extractText(base);
  console.log("Paragraphs in base document:");
  for (const p of extracted.paragraphs) {
    console.log(`  [${p.index}] "${p.text}" (style: ${p.style ?? "—"})`);
  }

  // ── Diff-based approach: AI just rewrites paragraph text ──
  const { edits } = diffParagraphs(extracted, [
    {
      // [4] "The Purchase Price shall be one million Czech crowns (CZK 1,000,000)."
      paragraphIndex: 4,
      newText:
        "The Purchase Price shall be two million Czech crowns (CZK 2,000,000).",
    },
    {
      // [6] "The Closing Date shall be 31 March 2026."
      paragraphIndex: 6,
      newText: "The Closing Date shall be 30 June 2026.",
    },
    {
      // [8] "The Seller represents and warrants..."
      paragraphIndex: 8,
      newText:
        "The Seller represents and warrants that the Shares are free from all encumbrances. The Seller further represents that no litigation is pending.",
    },
  ]);

  console.log("  Diff-generated edits:", edits.length);

  const editSet: DocxEditSet = {
    edits,
    comments: [],
    author: AUTHOR,
  };

  const result = await editWithTracking(base, editSet);
  if (Result.isError(result)) {
    throw result.error;
  }
  await Bun.write(`${OUT}/sample-tracked-changes.docx`, result.value.buffer);
  console.log("✓ sample-tracked-changes.docx");
};

// ── Sample 2: Tracked changes + comments ──────────────────

const generateWithComments = async () => {
  const base = await markdownToDocx(`# Non-Disclosure Agreement

## 1. Definitions

Confidential Information means any information disclosed by the Disclosing Party to the Receiving Party.

## 2. Obligations

The Receiving Party shall hold all Confidential Information in strict confidence.

The Receiving Party shall not disclose any Confidential Information to third parties without prior written consent.

## 3. Term

This Agreement shall remain in effect for a period of two (2) years from the Effective Date.
`);

  const extracted = await extractText(base);
  console.log("\nParagraphs in NDA document:");
  for (const p of extracted.paragraphs) {
    console.log(`  [${p.index}] "${p.text}" (style: ${p.style ?? "—"})`);
  }

  // ── Diff-based approach: AI just rewrites paragraph text ──
  // No manual charOffset/length counting needed.
  const { edits } = diffParagraphs(extracted, [
    {
      paragraphIndex: 5,
      newText:
        "The Receiving Party shall not disclose any Confidential Information to third parties.",
    },
    {
      paragraphIndex: 7,
      newText:
        "This Agreement shall remain in effect for a period of three (3) years from the Effective Date.",
    },
  ]);

  console.log("  Diff-generated edits:", edits.length);

  const editSet: DocxEditSet = {
    edits,
    comments: [
      {
        paragraphIndex: 2,
        charOffset: 0,
        length: 24,
        text: "Consider narrowing this definition to exclude publicly available information.",
      },
      {
        paragraphIndex: 4,
        charOffset: 0,
        length: 20,
        text: "Add carve-outs for legally required disclosures.",
      },
      {
        // Highlights "three (3) years" after the edit
        paragraphIndex: 7,
        charOffset: 54,
        length: 15,
        text: "Client prefers a longer term. Changed from 2 to 3 years.",
      },
    ],
    author: AUTHOR,
  };

  const result = await editWithTracking(base, editSet);
  if (Result.isError(result)) {
    throw result.error;
  }
  await Bun.write(`${OUT}/sample-with-comments.docx`, result.value.buffer);
  console.log("✓ sample-with-comments.docx");
};

// ── Sample 3: Filled template with rich values ────────────

const generateFilledTemplate = async () => {
  const SPA_FIXTURE = new URL(
    "fixtures/spa-template-with-placeholders.docx",
    import.meta.url,
  ).pathname;

  const { buffer, unmatchedPlaceholders, unusedValues } = await fillTemplate(
    SPA_FIXTURE,
    {
      price_share_1: "1 250 000",
      price_share_2: "875 000",
      price_share_3: "2 100 000",
      price_share_4: "450 000",
      price_share_5: "3 750 000",
      contract_date: "15. ledna 2026",
      seller_1_name: {
        paragraphs: [
          {
            runs: [
              { text: "Novák Holdings s.r.o.", bold: true },
              { text: " (IČO: 12345678)", italic: true },
            ],
          },
        ],
      },
      buyer_name: "Stella Legal a.s.",
    },
  );

  console.log("\nTemplate fill diagnostics:");
  console.log("  Unmatched:", unmatchedPlaceholders);
  console.log("  Unused:", unusedValues);

  await Bun.write(`${OUT}/sample-filled-template.docx`, buffer);
  console.log("✓ sample-filled-template.docx");
};

// ── Run all ───────────────────────────────────────────────

const run = async () => {
  console.log(`Output directory: ${OUT}\n`);
  await generateTrackedChanges();
  await generateWithComments();
  await generateFilledTemplate();
  console.log("\nDone. Open the files in Word to verify.");
};

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
