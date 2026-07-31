#!/usr/bin/env bun
import { loadDemoEngine } from "../src/components/anonymize-demo-engine";
import {
  INITIAL_TEXT,
  PRECOMPUTED_SAMPLE_PAIRS,
} from "../src/components/react/AnonymizeLiveDemo";

// AnonymizeLiveDemo paints `PRECOMPUTED_SAMPLE_PAIRS` before the wasm engine
// and its dictionaries have downloaded, so those pairs have to be exactly what
// the engine returns for INITIAL_TEXT; if they drift, the highlights visibly
// rearrange the moment the engine answers. Running the shipped pipeline here
// (the same module the browser worker loads) is what keeps the two in step.
//
//   bun scripts/precompute-anonymize-demo-sample.ts            prints the constant
//   bun scripts/precompute-anonymize-demo-sample.ts --check    fails on drift
//
// Run from apps/landing. `--check` runs as part of `bun run test`.

const REGEN_COMMAND = "bun scripts/precompute-anonymize-demo-sample.ts";

type SamplePair = { original: string; label: string };

const strip = (pairs: readonly SamplePair[]): SamplePair[] =>
  pairs.map(({ original, label }) => ({ original, label }));

// Compared as canonical JSON rather than as source text: oxfmt re-wraps the
// literal once a line grows past the print width, so comparing the rendered
// source would report drift for formatting alone.
const canonical = (pairs: readonly SamplePair[]): string =>
  JSON.stringify(strip(pairs));

const render = (pairs: readonly SamplePair[]): string => {
  const body = strip(pairs)
    .map(
      ({ original, label }) =>
        `  { original: ${JSON.stringify(original)}, label: ${JSON.stringify(label)} },`,
    )
    .join("\n");
  return `const PRECOMPUTED_SAMPLE_PAIRS = [\n${body}\n] as const satisfies readonly HighlightPair[];\n`;
};

const engine = await loadDemoEngine();
const { pairs } = await engine.run(INITIAL_TEXT);

if (!process.argv.includes("--check")) {
  process.stdout.write(render(pairs));
  process.exit(0);
}

if (canonical(pairs) === canonical(PRECOMPUTED_SAMPLE_PAIRS)) {
  process.stdout.write(
    "AnonymizeLiveDemo: precomputed sample highlights match the engine\n",
  );
  process.exit(0);
}

process.stderr.write(
  [
    "AnonymizeLiveDemo: PRECOMPUTED_SAMPLE_PAIRS no longer matches what the",
    "engine detects in INITIAL_TEXT, so the demo's first paint would disagree",
    "with the live result it swaps to. Regenerate from apps/landing and paste",
    `over the constant:\n\n    ${REGEN_COMMAND}\n`,
    "committed:",
    render(PRECOMPUTED_SAMPLE_PAIRS),
    "engine:",
    render(pairs),
  ].join("\n"),
);
process.exit(1);
