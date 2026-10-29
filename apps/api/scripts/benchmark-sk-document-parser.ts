/**
 * Document-parser lower bound over one captured Slovak PDF, repeated 250 times.
 * The capture is from sk-us; sk-courts currently retains metadata raw only.
 * Run from apps/api with --preload ./src/tests/setup-env.ts. No database or S3.
 */
import { panic } from "better-result";

import { parseSkDecisionPdf } from "@/api/lib/legal-search/parsers/sk-courts";

const SAMPLE_COUNT = 250;
const WARMUP_COUNT = 10;
const fixture = new URL(
  "../src/handlers/case-law/ingestion/adapters/__fixtures__/sk-us-decision.pdf.gz",
  import.meta.url,
);
const pdfBytes = Bun.gunzipSync(await Bun.file(fixture).bytes());
const cpuMs: number[] = [];
const wallMs: number[] = [];
let samplesWithText = 0;
let samplesWithBlocks = 0;
const percentile = (values: readonly number[], fraction: number) =>
  values
    .toSorted((left, right) => left - right)
    .at(Math.ceil(values.length * fraction) - 1) ??
  panic("No document parser samples");

const refuseNetwork = () =>
  panic("Document parser benchmark attempted a network request");
globalThis.fetch = Object.assign(refuseNetwork, { preconnect: refuseNetwork });
for (let iteration = -WARMUP_COUNT; iteration < SAMPLE_COUNT; iteration += 1) {
  const wallStart = performance.now();
  const cpuStart = process.cpuUsage();
  const parsed = await parseSkDecisionPdf({
    pdfBytes,
    caseNumber: "PL. ÚS 11/2021",
    ecli: undefined,
    court: "Ústavný súd Slovenskej republiky",
    decisionDate: undefined,
    decisionType: undefined,
  });
  const cpu = process.cpuUsage(cpuStart);
  const wall = performance.now() - wallStart;
  if (iteration < 0) {
    continue;
  }
  cpuMs.push((cpu.user + cpu.system) / 1000);
  wallMs.push(wall);
  samplesWithText += Number(parsed.fulltext.trim().length > 0);
  samplesWithBlocks += Number(parsed.documentAst.blocks.length > 0);
}
const meanCpuMs = cpuMs.reduce((sum, value) => sum + value, 0) / cpuMs.length;
console.log(
  JSON.stringify({
    event: "sk_document_parser_lower_bound",
    parser: "parseSkDecisionPdf",
    fixtureSource: "sk-us",
    distinctFixtureRows: 1,
    samples: cpuMs.length,
    warmup: WARMUP_COUNT,
    bytes: pdfBytes.length,
    samplesWithText,
    samplesWithBlocks,
    cpuMs: {
      p50: percentile(cpuMs, 0.5),
      p95: percentile(cpuMs, 0.95),
      mean: meanCpuMs,
    },
    wallMs: { p50: percentile(wallMs, 0.5), p95: percentile(wallMs, 0.95) },
    coresAtRequiredRate: (meanCpuMs * 2.03) / 1000,
    runtimeArch: process.arch,
  }),
);
