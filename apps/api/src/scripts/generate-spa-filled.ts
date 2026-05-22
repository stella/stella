/**
 * Test script: fills the SPA template with mock values
 * to verify the template filling flow.
 *
 * Run: bun apps/api/src/scripts/generate-spa-filled.ts
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { fillTemplate } from "../handlers/docx/patch-template";

const TEMPLATE = new URL(
  "../handlers/docx/fixtures/spa-template-with-placeholders.docx",
  import.meta.url,
).pathname;

const MOCK_VALUES = {
  price_share_1: "1 250 000",
  price_share_2: "875 000",
  price_share_3: "2 100 000",
  price_share_4: "450 000",
  price_share_5: "3 750 000",
  contract_date: "15. ledna 2026",
  seller_1_name: "Novák Holdings s.r.o.",
  buyer_name: "Stella Legal a.s.",
};

const run = async () => {
  const { buffer } = await fillTemplate(TEMPLATE, MOCK_VALUES);
  const outputPath = join(tmpdir(), "stella-spa-filled.docx");
  await Bun.write(outputPath, buffer);
  console.log(`Wrote ${outputPath}`);
};

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
