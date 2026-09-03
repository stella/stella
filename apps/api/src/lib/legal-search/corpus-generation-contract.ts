import { panic } from "better-result";

import type { CorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";

/** Document families sharing the corpus storage and search substrate. */
export const CORPUS_FAMILIES = ["case_law", "legislation"] as const;
export type CorpusFamily = (typeof CORPUS_FAMILIES)[number];

export const QUICKWIT_CLUSTERS = ["q08", "q09"] as const;
export type QuickwitCluster = (typeof QUICKWIT_CLUSTERS)[number];

/** Shared persistence bound for generation names and derived physical ids. */
export const CORPUS_INDEX_GENERATION_MAX_LENGTH = 32;

export const CORPUS_INDEX_GENERATION_STATUSES = [
  "building",
  "serving",
  "retiring",
  "retired",
] as const;
export type CorpusIndexGenerationStatus =
  (typeof CORPUS_INDEX_GENERATION_STATUSES)[number];

const memberOf = <T extends string>(
  values: readonly T[],
  value: unknown,
): T | null => values.find((candidate) => candidate === value) ?? null;

export const parseCorpusFamily = (value: unknown): CorpusFamily | null =>
  memberOf(CORPUS_FAMILIES, value);

export const parseQuickwitCluster = (value: unknown): QuickwitCluster | null =>
  memberOf(QUICKWIT_CLUSTERS, value);

const LEGACY_Q08_GENERATIONS = {
  case_law: ["case_law_v1", "case_law_v2", "case_law_v3", "case_law_v4"],
  legislation: ["legislation_v1"],
} as const satisfies Record<CorpusFamily, readonly string[]>;

type FinalManifestGenerationByFamily = {
  [Family in CorpusFamily]: Extract<
    CorpusIndexManifest,
    { family: Family; cluster: "q09" }
  >["generation"];
};

const FINAL_Q09_GENERATIONS = {
  case_law: ["case_law_v5", "case_law_v6"],
  legislation: ["legislation_v2"],
} as const satisfies {
  [Family in CorpusFamily]: readonly FinalManifestGenerationByFamily[Family][];
};

type DeclaredFinalManifestGeneration =
  (typeof FINAL_Q09_GENERATIONS)[CorpusFamily][number];
type MissingFinalManifestGeneration = Exclude<
  CorpusIndexManifest["generation"],
  DeclaredFinalManifestGeneration
>;
type UnexpectedFinalManifestGeneration = Exclude<
  DeclaredFinalManifestGeneration,
  CorpusIndexManifest["generation"]
>;

/**
 * Keep the explicit legacy boundary below, but make every final manifest
 * generation require a corresponding cluster declaration here. The manifest
 * contract currently restricts final generations to q09.
 */
true satisfies MissingFinalManifestGeneration extends never
  ? UnexpectedFinalManifestGeneration extends never
    ? true
    : never
  : never;

export const parseCorpusIndexClusterForGeneration = (
  family: CorpusFamily,
  generation: string,
): QuickwitCluster | null => {
  if (FINAL_Q09_GENERATIONS[family].some((value) => value === generation)) {
    return "q09";
  }
  if (LEGACY_Q08_GENERATIONS[family].some((value) => value === generation)) {
    return "q08";
  }
  return null;
};

export const corpusIndexClusterForGeneration = (
  family: CorpusFamily,
  generation: string,
): QuickwitCluster =>
  parseCorpusIndexClusterForGeneration(family, generation) ??
  panic(`Unknown ${family} corpus index generation: ${generation}`);

export const requireQuickwitCluster = (value: unknown): QuickwitCluster =>
  parseQuickwitCluster(value) ??
  panic(`Unknown Quickwit cluster reference: ${String(value)}`);

export const parseCorpusIndexGenerationStatus = (
  value: unknown,
): CorpusIndexGenerationStatus | null =>
  memberOf(CORPUS_INDEX_GENERATION_STATUSES, value);

const GENERATION_PATTERNS = {
  case_law: /^case_law_v[1-9][0-9]*$/u,
  legislation: /^legislation_v[1-9][0-9]*$/u,
} as const satisfies Record<CorpusFamily, RegExp>;

export const isCorpusGeneration = (
  family: CorpusFamily,
  generation: string,
): boolean =>
  generation.length <= CORPUS_INDEX_GENERATION_MAX_LENGTH &&
  GENERATION_PATTERNS[family].test(generation);
