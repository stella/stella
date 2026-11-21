/**
 * Writes the synthetic ZFO the image smoke probe (src/scripts/image-smoke.ts)
 * reads. The API Dockerfile runs it in the builder stage, where the fixtures
 * exist; the runner stage only receives the written file.
 *
 * Usage: bun src/tests/fixtures/write-image-smoke-zfo.ts <output.zfo>
 */
import { panic } from "better-result";

import { zfoFile } from "@/api/tests/fixtures/zfo";

const output =
  process.argv.at(2) ??
  panic("Usage: write-image-smoke-zfo.ts <output.zfo>");
await Bun.write(output, await zfoFile());
