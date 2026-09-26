/**
 * Test script: fills the SPA template with mock values
 * to verify the template filling flow.
 *
 * Run: bun apps/api/src/scripts/generate-spa-filled.ts
 */

import { Result } from "better-result";
import { tmpdir } from "node:os";
import path from "node:path";

import { fillTemplate } from "../lib/docx/patch-template";
import { scanUpload } from "../lib/file-scan/scan-upload";
import { DOCX_MIME_TYPE } from "../mime-types";

const TEMPLATE = new URL(
  "../lib/docx/fixtures/spa-template-with-placeholders.docx",
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
  const template = await scanUpload({
    bytes: await Bun.file(TEMPLATE).arrayBuffer(),
    declaredMimeType: DOCX_MIME_TYPE,
    fileName: path.basename(TEMPLATE),
  });
  if (Result.isError(template)) {
    throw template.error;
  }
  const { file } = await fillTemplate(template.value, MOCK_VALUES);
  const outputPath = path.join(tmpdir(), "stella-spa-filled.docx");
  await Bun.write(outputPath, file.bytes);
  console.log(`Wrote ${outputPath}`);
};

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
