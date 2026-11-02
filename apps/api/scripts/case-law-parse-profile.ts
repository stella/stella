import { mock } from "bun:test";

import { load as loadHtml } from "@stll/html";
import type { Block } from "@stll/legal-ast/document-ast";

import type { ValidateAstFixture } from "@/api/tests/helpers/validate-ast-inputs";

await mock.module("@/api/lib/observability/logger", () => ({
  logger: {
    child: () => ({
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    }),
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  },
}));

// Imported after the logger mock so the measured modules never log.
const { buildValidateAstFixtures } =
  await import("@/api/tests/helpers/validate-ast-inputs");
const {
  collapseValidationWhitespace,
  extractValidationWords,
  normalizeValidationText,
  separateValidationSkipMarkers,
  validateAst,
  validationInlineText,
  validationTextHoldsOnlyDecoration,
} = await import("@/api/lib/legal-search/parsers/validate-ast");
const { markupResidueIn } =
  await import("@/api/lib/legal-search/parsers/markup-residue");
const iterations = process.argv.includes("--quick") ? 5 : 30;
const fixtures = await buildValidateAstFixtures();

type Sample = { load: number; parse: number; validation: number; heap: number };
const STEP_NAMES = [
  "source normalization",
  "source skip markers",
  "source words",
  "AST normalization",
  "AST skip markers",
  "AST words",
  "decoration check",
  "retention comparison",
  "missing-word comparison",
  "empty AST check",
  "block type counts",
  "heading check",
  "block anomalies",
  "whitespace collapse + inline comparison",
] as const;
type StepName = (typeof STEP_NAMES)[number];

const median = (values: number[]) =>
  values.toSorted((left, right) => left - right)[
    Math.floor(values.length / 2)
  ] ?? 0;
const time = (operation: () => unknown): number => {
  const start = performance.now();
  operation();
  return performance.now() - start;
};

const profileValidation = (
  source: string,
  blocks: Block[],
): Record<StepName, number> => {
  const result = {
    "source normalization": 0,
    "source skip markers": 0,
    "source words": 0,
    "AST normalization": 0,
    "AST skip markers": 0,
    "AST words": 0,
    "decoration check": 0,
    "retention comparison": 0,
    "missing-word comparison": 0,
    "empty AST check": 0,
    "block type counts": 0,
    "heading check": 0,
    "block anomalies": 0,
    "whitespace collapse + inline comparison": 0,
  } satisfies Record<StepName, number>;
  let sourceText = "";
  result["source normalization"] = time(() => {
    sourceText = normalizeValidationText(loadHtml(source)("body").text());
  });
  result["source skip markers"] = time(() => {
    separateValidationSkipMarkers(sourceText);
  });
  let sourceWords = new Set<string>();
  result["source words"] = time(() => {
    sourceWords = extractValidationWords(sourceText);
  });
  let astText = "";
  result["AST normalization"] = time(() => {
    astText = normalizeValidationText(
      blocks
        .flatMap((block) => (block.plainText ? [block.plainText] : []))
        .join(" "),
    );
  });
  result["AST skip markers"] = time(() => {
    separateValidationSkipMarkers(astText);
  });
  let astWords = new Set<string>();
  result["AST words"] = time(() => {
    astWords = extractValidationWords(astText);
  });
  result["decoration check"] = time(() => {
    validationTextHoldsOnlyDecoration(sourceText);
  });
  result["retention comparison"] = time(
    () => (astText.length / sourceText.length) * 100,
  );
  result["missing-word comparison"] = time(
    () => [...sourceWords].filter((word) => !astWords.has(word)).length,
  );
  result["empty AST check"] = time(() => blocks.length === 0);
  result["block type counts"] = time(() => {
    const counts = new Map<string, number>();
    for (const block of blocks) {
      counts.set(block.type, (counts.get(block.type) ?? 0) + 1);
    }
  });
  result["heading check"] = time(() => {
    blocks.filter((block) => block.type === "heading");
  });
  result["block anomalies"] = time(() => {
    let previous = "";
    let anomalies = 0;
    for (const block of blocks) {
      const text = block.plainText.trim();
      anomalies += markupResidueIn(text) === undefined ? 0 : 1;
      anomalies += text.length > 0 && text.length < 5 ? 1 : 0;
      anomalies += text.length > 5000 ? 1 : 0;
      anomalies += text === previous && text.length > 10 ? 1 : 0;
      previous = text;
    }
    return anomalies;
  });
  result["whitespace collapse + inline comparison"] = time(() => {
    for (const block of blocks) {
      if (block.type === "heading" || block.type === "paragraph") {
        collapseValidationWhitespace(validationInlineText(block.inlines));
        collapseValidationWhitespace(block.plainText);
      }
    }
  });
  return result;
};

const measure = (fixture: ValidateAstFixture): Sample => {
  Bun.gc(true);
  const baseline = process.memoryUsage().heapUsed;
  let peak = baseline;
  const loadStart = performance.now();
  loadHtml(fixture.markup, fixture.xml ? { xml: true } : undefined);
  const load = performance.now() - loadStart;
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  const parseStart = performance.now();
  const ast = fixture.parse();
  const parse = performance.now() - parseStart;
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  const validationStart = performance.now();
  validateAst(fixture.validationMarkup ?? fixture.markup, ast.blocks);
  const validation = performance.now() - validationStart;
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  return { load, parse, validation, heap: Math.max(0, peak - baseline) };
};

console.log(`case-law parse profile: ${iterations} warm iterations`);
console.log("fixture\tsize KB\tload ms\twalk + AST ms\tvalidation ms\theap MB");
for (const fixture of fixtures) {
  fixture.parse();
  const samples = Array.from({ length: iterations }, () => measure(fixture));
  const load = median(samples.map((sample) => sample.load));
  const validation = median(samples.map((sample) => sample.validation));
  const combined = Math.max(
    0,
    median(samples.map((sample) => sample.parse)) - load - validation,
  );
  const heap = Math.max(...samples.map((sample) => sample.heap)) / 1024 / 1024;
  console.log(
    `${fixture.name}\t${(fixture.bytes.byteLength / 1024).toFixed(1)}\t${load.toFixed(2)}\t${combined.toFixed(2)}\t${validation.toFixed(2)}\t${heap.toFixed(2)}`,
  );
}
console.log("\nvalidation breakdown (median ms)");
console.log(["fixture", ...STEP_NAMES.map((name) => `${name} ms`)].join("\t"));
for (const fixture of fixtures) {
  const ast = fixture.parse();
  const samples = Array.from({ length: iterations }, () =>
    profileValidation(fixture.validationMarkup ?? fixture.markup, ast.blocks),
  );
  console.log(
    [
      fixture.name,
      ...STEP_NAMES.map((name) =>
        median(samples.map((sample) => sample[name])).toFixed(3),
      ),
    ].join("\t"),
  );
}
