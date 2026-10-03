// parser-output-unchanged: Search query variant flag and policy; ingestion parsers never read them.
import { createHash } from "node:crypto";

export const CORPUS_INDEX_QUERY_VARIANTS = ["off", "provision-refs"] as const;

export type CorpusIndexQueryVariant =
  (typeof CORPUS_INDEX_QUERY_VARIANTS)[number];

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
