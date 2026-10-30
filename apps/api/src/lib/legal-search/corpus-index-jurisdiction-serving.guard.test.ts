/**
 * Every path that decides which index or which generation answers for a
 * case-law jurisdiction goes through the jurisdiction-serving pointer.
 *
 * The pointer only means something if nothing routes around it, so this
 * enumerates the modules that touch each routing primitive and fails when a
 * new one appears: a new read path has to resolve its target through
 * `readServingCorpusIndexTargetTx` (or be added here with a reason), and the
 * static group map is read by the declaration and the write side alone.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

const SRC = nodePath.resolve(import.meta.dir, "../..");

const sourceFiles = (): string[] => {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = nodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "node_modules" ? [] : walk(full);
      }
      return entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".gen.ts")
        ? [full.slice(SRC.length + 1)]
        : [];
    });
  return walk(SRC);
};

const FILES = sourceFiles().map((file) => ({
  file,
  text: readFileSync(nodePath.join(SRC, file), "utf-8"),
}));

/** The non-test modules whose text matches, sorted. */
const modulesMatching = (pattern: RegExp): string[] =>
  FILES.filter(({ text }) => pattern.test(text))
    .map(({ file }) => file)
    .toSorted();

test("the modules that resolve an index for a read are the pointer's and the declaration's", () => {
  // Read paths: each resolves its target through the pointer.
  expect(modulesMatching(/\breadServingCorpusIndexTargetTx\b/u)).toEqual([
    "handlers/case-law/decisions/search.ts",
    "lib/case-law/research-answer-runner.ts",
    "lib/legal-search/corpus-index-facets.ts",
    "lib/legal-search/corpus-index-group-enrollment-store.ts",
    "lib/legal-search/corpus-index-provider.ts",
  ]);
  // The serving generation of a family, read without the pointer: the store
  // that applies the pointer, the operator tools, and legislation, which has
  // no pointer.
  expect(modulesMatching(/\breadServingCorpusIndexGenerationTx\b/u)).toEqual([
    "handlers/legislation/search.ts",
    "lib/legal-search/case-law-serving-flip.ts",
    "lib/legal-search/corpus-index-generation-store.ts",
    "lib/legal-search/corpus-index-group-enrollment-store.ts",
    "scripts/corpus-snippet-compare.ts",
  ]);
  // The generations readers are served from, pointer applied: the read path's
  // store and what measures those readers' freshness.
  expect(modulesMatching(/\breadServedCorpusIndexGenerationsTx\b/u)).toEqual([
    "lib/legal-search/corpus-index-group-enrollment-store.ts",
    "lib/observability/case-law-freshness-metrics.ts",
  ]);
});

test("the routing primitives are called by the declaration, the write side, the pointer and operator tools only", () => {
  expect(modulesMatching(/\bcorpusIndexRoute\(/u)).toEqual([
    "lib/case-law/research-answer-runner.ts",
    "lib/legal-search/case-law-serving-flip.ts",
    "lib/legal-search/corpus-index-group-contract.ts",
    "scripts/corpus-index-query-diff-report.ts",
  ]);
  expect(modulesMatching(/\bcorpusIndexIdFromManifest\(/u)).toEqual([
    "lib/legal-search/corpus-index-group-contract.ts",
    "lib/legal-search/corpus-index-manifest.ts",
    "lib/legal-search/corpus-index-projection-descriptor.ts",
    "scripts/corpus-generation.ts",
  ]);
  expect(modulesMatching(/\bcaseLawIndexIdSql\(/u)).toEqual([
    "lib/legal-search/case-law-corpus-projection.ts",
    "lib/legal-search/corpus-index-route-sql.ts",
  ]);
  expect(modulesMatching(/\bcaseLawIndexGroupAt\(/u)).toEqual([
    "lib/legal-search/corpus-index-group-contract.ts",
    "lib/legal-search/index-naming.ts",
  ]);
});

test("the static group map is read by its declaration and the type of a manifest's record", () => {
  expect(modulesMatching(/\bCASE_LAW_INDEX_GROUP_OF\b/u)).toEqual([
    "lib/legal-search/case-law-index-groups.ts",
    "lib/legal-search/corpus-index-manifest.ts",
    "lib/legal-search/index-naming.ts",
  ]);
  // In the manifest it is a type, never a value; in the naming module it is
  // only named in prose.
  const manifest =
    FILES.find(
      ({ file }) => file === "lib/legal-search/corpus-index-manifest.ts",
    )?.text ?? "";
  expect(manifest).toContain("type CASE_LAW_INDEX_GROUP_OF");
  expect(manifest).not.toMatch(/\bCASE_LAW_INDEX_GROUP_OF\[/u);
  expect(manifest).not.toMatch(/Object\.\w+\(CASE_LAW_INDEX_GROUP_OF/u);
  const naming =
    FILES.find(({ file }) => file === "lib/legal-search/index-naming.ts")
      ?.text ?? "";
  expect(naming).not.toMatch(/import[^;]*CASE_LAW_INDEX_GROUP_OF/su);
});

test("the SQL acceptance of an indexed hit resolves its generation through the pointer table", () => {
  const acceptance =
    FILES.find(
      ({ file }) => file === "lib/legal-search/case-law-corpus-projection.ts",
    )?.text ?? "";
  expect(acceptance).toContain("corpusIndexJurisdictionServing");
  // Every state lookup of the module goes through the pointer expression: the
  // bare generation is never compared to a state's generation column.
  expect(acceptance).not.toMatch(/generation = \$\{generation\}/u);
  expect(acceptance).not.toMatch(/\.generation\} = \$\{generation\}/u);
  // The one helper that compares a state's generation takes the resolved
  // expression, and every call hands it the pointer's COALESCE.
  const callArguments = [
    ...acceptance.matchAll(/acceptedCaseLawProjectionStateAt\(([^\n]*)/gu),
  ].map((match) => match[1] ?? "");
  expect(callArguments.length).toBeGreaterThan(0);
  for (const argument of callArguments) {
    expect(argument).toContain("COALESCE(pointer.");
  }
  // And the callers hand it the serving generation, never a route of their own.
  expect(modulesMatching(/\bcurrentCaseLawCorpusProjection\(/u)).toEqual([
    "handlers/case-law/decisions/search.ts",
    "lib/case-law/research-answer-runner.ts",
    "lib/legal-search/corpus-index-provider.ts",
  ]);
});

test("the pointer is written only by the gated flip and cleared only by a promotion", () => {
  expect(
    modulesMatching(/\.insert\(corpusIndexJurisdictionServing\)/u),
  ).toEqual(["lib/legal-search/case-law-serving-flip.ts"]);
  expect(
    modulesMatching(/\.delete\(corpusIndexJurisdictionServing\)/u),
  ).toEqual(["lib/legal-search/corpus-index-jurisdiction-serving-store.ts"]);
  expect(modulesMatching(/\bclearJurisdictionServingTx\(/u)).toEqual([
    "lib/legal-search/corpus-index-generation-store.ts",
  ]);
  expect(
    modulesMatching(/\.update\(corpusIndexJurisdictionServing\)/u),
  ).toEqual([]);
});
