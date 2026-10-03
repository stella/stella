// parser-output-unchanged: Core stem query variants change search allocation only, not ingestion parser output.
import { createHash } from "node:crypto";

export const CORPUS_INDEX_QUERY_VARIANTS = [
  "off",
  "provision-refs",
  "sk-core-stems-first",
  "provision-refs-sk-core-stems-first",
] as const;

export type CorpusIndexQueryVariant =
  (typeof CORPUS_INDEX_QUERY_VARIANTS)[number];

// Explicit combined value keeps independent and combined evaluations selectable.
export const CORPUS_QUERY_VARIANT_POLICY = {
  off: { provisions: false, slovakCoreStemsFirst: false },
  "provision-refs": { provisions: true, slovakCoreStemsFirst: false },
  "sk-core-stems-first": { provisions: false, slovakCoreStemsFirst: true },
  "provision-refs-sk-core-stems-first": {
    provisions: true,
    slovakCoreStemsFirst: true,
  },
} as const satisfies Record<
  CorpusIndexQueryVariant,
  { provisions: boolean; slovakCoreStemsFirst: boolean }
>;

type CorpusQueryVariantOptions = {
  configuredVariant: CorpusIndexQueryVariant;
  verbatim: boolean;
};

export const corpusQueryVariant = ({
  configuredVariant,
  verbatim,
}: CorpusQueryVariantOptions): CorpusIndexQueryVariant =>
  verbatim ? "off" : configuredVariant;

export const corpusQueryVariantCursorTarget = (
  target: string | null,
  variant: CorpusIndexQueryVariant,
): string | null =>
  variant === "off"
    ? target
    : createHash("sha256")
        .update(JSON.stringify([target, variant]))
        .digest("hex")
        .slice(0, 32);
