import type { TextPart } from "@tanstack/ai";
import type { AnthropicTextMetadata } from "@tanstack/ai-anthropic";

import type { CachingDecision } from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import { markTanStackCacheBreakpoint } from "@/api/lib/tanstack-ai-caching";
import { buildDocxBlocksMessage } from "@/api/lib/workflow/ai-prompts";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";

/**
 * The document region every reference-review call shares: the source roles,
 * then the target and each reference serialised as folio blocks, with the
 * cache breakpoint on the last document. Byte-identical across the topic
 * proposal and the comparison for the same documents, and placed before
 * anything that varies per call, so the second call (and every re-run) reads
 * the documents from the prompt cache.
 */
export const buildReviewDocumentParts = ({
  target,
  references,
  caching,
}: {
  target: PreparedDocxFile;
  references: readonly PreparedDocxFile[];
  caching: CachingDecision;
}): TextPart<AnthropicTextMetadata>[] => {
  const sourceGuide = [
    `${target.simplifiedName}: target document`,
    ...references.map(
      (reference, index) =>
        `${reference.simplifiedName}: reference document ${String(index + 1)}`,
    ),
  ].join("\n");
  const parts: TextPart<AnthropicTextMetadata>[] = [
    { type: "text", content: `Source roles:\n${sourceGuide}` },
    ...[target, ...references].map((file): TextPart<AnthropicTextMetadata> => ({
      type: "text",
      content: buildDocxBlocksMessage({
        simplifiedName: file.simplifiedName,
        blocks: file.blocks,
      }),
    })),
  ];
  const lastIndex = parts.length - 1;
  const last = parts[lastIndex];
  if (last !== undefined) {
    parts[lastIndex] = markTanStackCacheBreakpoint(last, {
      decision: caching,
    });
  }
  return parts;
};

/** One cache scope for every call over the same pinned documents, so the
 *  topic proposal and the comparison land in the same provider cache shard. */
export const reviewDocumentsScopeKey = (
  targetEntityVersionId: SafeId<"entityVersion">,
  referenceEntityVersionIds: readonly SafeId<"entityVersion">[],
): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(targetEntityVersionId);
  for (const versionId of referenceEntityVersionIds) {
    hasher.update(versionId);
  }
  return `document-review:${hasher.digest("hex")}`;
};
