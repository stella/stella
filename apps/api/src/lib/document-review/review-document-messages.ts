import type { TextPart } from "@tanstack/ai";
import type { AnthropicTextMetadata } from "@tanstack/ai-anthropic";
import { panic, Result } from "better-result";

import { createSha256 } from "@stll/sha256/bun";

import type { CachingDecision } from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { markTanStackCacheBreakpoint } from "@/api/lib/tanstack-ai-caching";
import { buildDocxBlocksMessage } from "@/api/lib/workflow/ai-prompts";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";
import {
  fitDocxFilesToRequestBudget,
  logRequestFit,
} from "@/api/lib/workflow/request-budget";

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

type FitReviewDocumentsOptions = {
  target: PreparedDocxFile;
  references: readonly PreparedDocxFile[];
  budgetBytes: number;
};

type FittedReviewDocuments = {
  target: PreparedDocxFile;
  references: readonly PreparedDocxFile[];
};

/**
 * The documents of one review call, cut to fit its model. The budget depends
 * only on the model and the cut only on the documents, so calls over the same
 * documents under the same model send the same bytes.
 */
export const fitReviewDocuments = ({
  target,
  references,
  budgetBytes,
}: FitReviewDocumentsOptions): Result<
  FittedReviewDocuments,
  WorkflowIntegrationError
> => {
  const fit = fitDocxFilesToRequestBudget({
    files: [target, ...references],
    budgetBytes,
  });
  if (Result.isError(fit)) {
    return Result.err(
      new WorkflowIntegrationError({
        message: fit.error.message,
        cause: fit.error,
      }),
    );
  }
  logRequestFit(fit.value);
  const [fittedTarget, ...fittedReferences] = fit.value.files;
  return Result.ok({
    target: fittedTarget ?? panic("The fit dropped the review target"),
    references: fittedReferences,
  });
};

/** One cache scope for every call over the same pinned documents, so the
 *  topic proposal and the comparison land in the same provider cache shard. */
export const reviewDocumentsScopeKey = (
  targetEntityVersionId: SafeId<"entityVersion">,
  referenceEntityVersionIds: readonly SafeId<"entityVersion">[],
): string => {
  const hasher = createSha256();
  hasher.update(targetEntityVersionId);
  for (const versionId of referenceEntityVersionIds) {
    hasher.update(versionId);
  }
  return `document-review:${hasher.digest("hex")}`;
};
