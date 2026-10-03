// parser-output-unchanged: Search query variant flag and policy; ingestion parsers never read them.
import { createHash } from "node:crypto";

export const CORPUS_INDEX_QUERY_VARIANTS = [
  "off",
  "provision-refs",
  "sk-faithful-reserve",
  "provision-refs-sk-faithful-reserve",
] as const;

export type CorpusIndexQueryVariant =
  (typeof CORPUS_INDEX_QUERY_VARIANTS)[number];

// Explicit combined value keeps independent and combined evaluations selectable.
export const CORPUS_QUERY_VARIANT_POLICY = {
  off: { provisions: false, slovakFaithfulReserve: false },
  "provision-refs": { provisions: true, slovakFaithfulReserve: false },
  "sk-faithful-reserve": { provisions: false, slovakFaithfulReserve: true },
  "provision-refs-sk-faithful-reserve": {
    provisions: true,
    slovakFaithfulReserve: true,
  },
} as const satisfies Record<
  CorpusIndexQueryVariant,
  { provisions: boolean; slovakFaithfulReserve: boolean }
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
