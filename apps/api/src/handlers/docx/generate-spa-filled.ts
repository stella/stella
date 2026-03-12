/* eslint-disable no-console */
/**
 * Test script: fills the SPA template with mock values
 * using patchDocument to verify the template filling flow.
 *
 * Run: bun apps/api/src/handlers/docx/generate-spa-filled.ts
 */

import { fillTemplate } from "./patch-template";

const TEMPLATE = new URL(
  "fixtures/spa-template-with-placeholders.docx",
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
  const outputPath = "/Users/sok0/Downloads/stella-spa-filled.docx";
  await Bun.write(outputPath, buffer);
};

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
