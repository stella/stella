// parser-output-unchanged: SHA-256 owner preserves the UTF-8 JSON cursor identity, hexadecimal encoding and 32-character prefix; pinned vectors cover equality.
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";
// parser-output-unchanged: Core stem query variants change search allocation only, not ingestion parser output.

export const CORPUS_INDEX_QUERY_VARIANTS = [
  "off",
  "provision-refs",
  "core-stems-first",
  "provision-refs-core-stems-first",
] as const;

export type CorpusIndexQueryVariant =
  (typeof CORPUS_INDEX_QUERY_VARIANTS)[number];

// Explicit combined value keeps independent and combined evaluations selectable.
export const CORPUS_QUERY_VARIANT_POLICY = {
  off: { provisions: false, coreStemsFirst: false },
  "provision-refs": { provisions: true, coreStemsFirst: false },
  "core-stems-first": { provisions: false, coreStemsFirst: true },
  "provision-refs-core-stems-first": {
    provisions: true,
    coreStemsFirst: true,
  },
} as const satisfies Record<
  CorpusIndexQueryVariant,
  { provisions: boolean; coreStemsFirst: boolean }
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
    : hashSha256Hex(JSON.stringify([target, variant])).slice(0, 32);
