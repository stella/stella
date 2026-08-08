import { Result } from "better-result";
import * as v from "valibot";

import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import { resolveCaching } from "@/api/lib/ai-config";
import {
  createTanStackAIAnalyticsCallbacks,
  type AIUsageMetering,
} from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import { buildDocxBlocksMessage } from "@/api/lib/workflow/ai-prompts";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";

const REFERENCE_REVIEW_TIMEOUT_MS = 120_000;
const REFERENCE_REVIEW_ROLE = "pdf" as const;
const MAX_CITATIONS_PER_FINDING = 8;

const assessmentValues = [
  "aligned",
  "different",
  "missing-from-target",
  "additional-in-target",
  "deal-specific",
  "not-comparable",
] as const;

const consensusValues = ["single", "consistent", "mixed"] as const;

const rawCitationSchema = v.strictObject({
  sourceKey: v.string(),
  blockId: v.string(),
});

const rawFindingSchema = v.strictObject({
  issue: v.string(),
  assessment: v.picklist(assessmentValues),
  consensus: v.picklist(consensusValues),
  rationale: v.string(),
  targetCitations: v.pipe(
    v.array(rawCitationSchema),
    v.maxLength(MAX_CITATIONS_PER_FINDING),
  ),
  referenceCitations: v.pipe(
    v.array(rawCitationSchema),
    v.maxLength(MAX_CITATIONS_PER_FINDING),
  ),
  proposedText: v.nullable(v.string()),
});

const referenceReviewSchema = v.strictObject({
  findings: v.pipe(
    v.array(rawFindingSchema),
    v.maxLength(LIMITS.documentReviewFindingsMax),
  ),
});

type RawReferenceFinding = v.InferOutput<typeof rawFindingSchema>;

export type ReferenceAssessment = (typeof assessmentValues)[number];
export type ReferenceConsensus = (typeof consensusValues)[number];

export type ReferenceCitation = {
  blockId: string;
  text: string;
};

export type ReferenceReviewFix = {
  kind: "replaceBlock" | "insertAfterBlock";
  blockId: string;
  text: string;
};

export type ReferenceReviewFinding = {
  findingId: string;
  issue: string;
  assessment: ReferenceAssessment;
  consensus: ReferenceConsensus;
  rationale: string;
  targetCitations: ReferenceCitation[];
  referenceCitations: {
    fileFieldId: SafeId<"field">;
    citations: ReferenceCitation[];
  }[];
  fix: ReferenceReviewFix | null;
};

type NormalizeReferenceReviewArgs = {
  rawFindings: readonly RawReferenceFinding[];
  target: PreparedDocxFile;
  references: readonly PreparedDocxFile[];
};

const verifiedCitation = (
  blockId: string,
  blocksById: ReadonlyMap<string, { text: string }>,
): ReferenceCitation | null => {
  const block = blocksById.get(blockId);
  return block ? { blockId, text: block.text } : null;
};

const collectVerifiedCitations = (
  citations: readonly { blockId: string }[],
  blocksById: ReadonlyMap<string, { text: string }>,
): ReferenceCitation[] => {
  const seen = new Set<string>();
  const verified: ReferenceCitation[] = [];
  for (const citation of citations) {
    if (seen.has(citation.blockId)) {
      continue;
    }
    const normalized = verifiedCitation(citation.blockId, blocksById);
    if (normalized === null) {
      continue;
    }
    seen.add(citation.blockId);
    verified.push(normalized);
  }
  return verified;
};

const buildReferenceFix = ({
  assessment,
  proposedText,
  targetCitations,
  targetLastBlockId,
}: {
  assessment: ReferenceAssessment;
  proposedText: string | null;
  targetCitations: readonly ReferenceCitation[];
  targetLastBlockId: string | null;
}): ReferenceReviewFix | null => {
  const text = proposedText?.trim();
  if (!text) {
    return null;
  }
  if (assessment === "different") {
    const targetBlockId = targetCitations.at(0)?.blockId;
    return targetBlockId
      ? { kind: "replaceBlock", blockId: targetBlockId, text }
      : null;
  }
  if (assessment === "missing-from-target" && targetLastBlockId !== null) {
    return { kind: "insertAfterBlock", blockId: targetLastBlockId, text };
  }
  return null;
};

export const normalizeReferenceReview = ({
  rawFindings,
  target,
  references,
}: NormalizeReferenceReviewArgs): ReferenceReviewFinding[] => {
  const targetBlocksById = new Map(
    target.blocks.map((block) => [block.id, { text: block.text }]),
  );
  const referenceBySourceKey = new Map(
    references.map((reference) => [reference.simplifiedName, reference]),
  );
  const referenceBlocksBySourceKey = new Map(
    references.map((reference) => [
      reference.simplifiedName,
      new Map(
        reference.blocks.map((block) => [block.id, { text: block.text }]),
      ),
    ]),
  );
  const targetLastBlockId = target.blocks.at(-1)?.id ?? null;
  const findings: ReferenceReviewFinding[] = [];

  for (const raw of rawFindings) {
    const targetCitations = collectVerifiedCitations(
      raw.targetCitations.filter(
        (citation) => citation.sourceKey === target.simplifiedName,
      ),
      targetBlocksById,
    );

    const citationsByFileFieldId = new Map<
      SafeId<"field">,
      ReferenceCitation[]
    >();
    for (const citation of raw.referenceCitations) {
      const reference = referenceBySourceKey.get(citation.sourceKey);
      if (!reference) {
        continue;
      }
      const blocksById = referenceBlocksBySourceKey.get(citation.sourceKey);
      if (!blocksById) {
        continue;
      }
      const normalized = verifiedCitation(citation.blockId, blocksById);
      if (normalized === null) {
        continue;
      }
      const existing = citationsByFileFieldId.get(reference.fileFieldId);
      if (existing?.some((item) => item.blockId === normalized.blockId)) {
        continue;
      }
      if (existing) {
        existing.push(normalized);
      } else {
        citationsByFileFieldId.set(reference.fileFieldId, [normalized]);
      }
    }

    const referenceCitations = references.flatMap((reference) => {
      const citations = citationsByFileFieldId.get(reference.fileFieldId);
      return citations
        ? [{ fileFieldId: reference.fileFieldId, citations }]
        : [];
    });

    if (targetCitations.length === 0 && referenceCitations.length === 0) {
      continue;
    }

    findings.push({
      findingId: `reference-${String(findings.length + 1)}`,
      issue: raw.issue.trim(),
      assessment: raw.assessment,
      consensus: references.length === 1 ? "single" : raw.consensus,
      rationale: raw.rationale.trim(),
      targetCitations,
      referenceCitations,
      fix: buildReferenceFix({
        assessment: raw.assessment,
        proposedText: raw.proposedText,
        targetCitations,
        targetLastBlockId,
      }),
    });
  }

  return findings;
};

const SYSTEM_PROMPT = `You compare one target legal document with one or more reference documents.

References are examples, not policy and not proof of market practice. Never call the target compliant, non-compliant, standard, or non-standard. Compare substantive drafting only.

For each material issue, classify the target as aligned, different, missing-from-target, additional-in-target, deal-specific, or not-comparable. Set consensus to mixed when the reference documents materially disagree with each other. Cite only exact block IDs supplied in the input. F0 is always the target; every other source is a reference. proposedText must be null unless the cited reference language directly supports a concrete target edit. Return no unsupported finding.`;

const buildReferencePrompt = (
  target: PreparedDocxFile,
  references: readonly PreparedDocxFile[],
): string => {
  const sourceGuide = [
    `${target.simplifiedName}: target document`,
    ...references.map(
      (reference, index) =>
        `${reference.simplifiedName}: reference document ${String(index + 1)}`,
    ),
  ].join("\n");
  const documents = [target, ...references]
    .map((file) =>
      buildDocxBlocksMessage({
        simplifiedName: file.simplifiedName,
        blocks: file.blocks,
      }),
    )
    .join("\n\n");
  return `Source roles:\n${sourceGuide}\n\n${documents}`;
};

type CompareReferenceDocumentsArgs = {
  target: PreparedDocxFile;
  references: readonly PreparedDocxFile[];
  targetEntityVersionId: SafeId<"entityVersion">;
  referenceEntityVersionIds: readonly SafeId<"entityVersion">[];
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
  usageMetering: AIUsageMetering;
  abortSignal: AbortSignal;
};

export const compareReferenceDocuments = async ({
  target,
  references,
  targetEntityVersionId,
  referenceEntityVersionIds,
  organizationId,
  workspaceId,
  orgAIConfig,
  promptCachingEnabled,
  serviceTier,
  usageMetering,
  abortSignal,
}: CompareReferenceDocumentsArgs): Promise<
  Result<ReferenceReviewFinding[], WorkflowIntegrationError>
> => {
  const scopeHasher = new Bun.CryptoHasher("sha256");
  scopeHasher.update(targetEntityVersionId);
  for (const versionId of referenceEntityVersionIds) {
    scopeHasher.update(versionId);
  }
  const scopeKey = `document-review:${scopeHasher.digest("hex")}`;
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    feature: "document-review.references",
    modelRole: REFERENCE_REVIEW_ROLE,
    orgAIConfig,
    properties: {
      file_count: references.length + 1,
      organization_id: organizationId,
      workspace_id: workspaceId,
    },
    traceId: Bun.randomUUIDv7(),
    usageMetering,
  });

  return await Result.tryPromise({
    try: async () => {
      const output = await generateTanStackObjectForRole({
        role: REFERENCE_REVIEW_ROLE,
        orgAIConfig,
        organizationId,
        analytics: aiAnalytics,
        caching: resolveCaching({
          promptCachingEnabled,
          role: REFERENCE_REVIEW_ROLE,
          scopeKey,
        }),
        serviceTier,
        tenantWorkspaceIds: [workspaceId],
        system: SYSTEM_PROMPT,
        prompt: buildReferencePrompt(target, references),
        abortSignal: AbortSignal.any([
          abortSignal,
          AbortSignal.timeout(REFERENCE_REVIEW_TIMEOUT_MS),
        ]),
        outputSchema: referenceReviewSchema,
      });

      return normalizeReferenceReview({
        rawFindings: output.findings,
        target,
        references,
      });
    },
    catch: (cause) => {
      aiAnalytics.captureError(cause);
      return new WorkflowIntegrationError({
        message: "Reference document comparison failed",
        cause,
      });
    },
  });
};
