import { panic } from "better-result";

/** Document families sharing the corpus storage and search substrate. */
export const CORPUS_FAMILIES = ["case_law", "legislation"] as const;
export type CorpusFamily = (typeof CORPUS_FAMILIES)[number];

export const QUICKWIT_CLUSTERS = ["quickwit_08", "quickwit_09"] as const;
export type QuickwitCluster = (typeof QUICKWIT_CLUSTERS)[number];

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

export const parseQuickwitCluster = (
  value: unknown,
): QuickwitCluster | null => memberOf(QUICKWIT_CLUSTERS, value);

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
): boolean => GENERATION_PATTERNS[family].test(generation);
