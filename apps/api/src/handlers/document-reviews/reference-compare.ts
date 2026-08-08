import { Result } from "better-result";
import * as v from "valibot";

import type { DocumentReviewTopic } from "@/api/handlers/document-reviews/schemas";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import { resolveCaching } from "@/api/lib/ai-config";
import {
  createTanStackAIAnalyticsCallbacks,
  type AIUsageMetering,
} from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import { buildDocxBlocksMessage } from "@/api/lib/workflow/ai-prompts";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";

const REFERENCE_REVIEW_TIMEOUT_MS = 120_000;
const REFERENCE_REVIEW_ROLE = "pdf" as const;
const MAX_VERIFIED_CITATIONS_PER_FINDING = 8;

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
  topicId: v.string(),
  assessment: v.picklist(assessmentValues),
  consensus: v.picklist(consensusValues),
  rationale: v.string(),
  // Model-owned arrays are normalized below. A provider may ignore JSON Schema
  // cardinality constraints; rejecting the whole run would discard valid output.
  targetCitations: v.array(rawCitationSchema),
  referenceCitations: v.array(rawCitationSchema),
  proposedText: v.nullable(v.string()),
});

export const referenceReviewSchema = v.strictObject({
  findings: v.array(rawFindingSchema),
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
  topicId: string;
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
  topics: readonly DocumentReviewTopic[];
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
    if (verified.length === MAX_VERIFIED_CITATIONS_PER_FINDING) {
      break;
    }
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
  topics,
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
  const topicById = new Map(topics.map((topic) => [topic.topicId, topic]));
  const seenTopicIds = new Set<string>();

  for (const raw of rawFindings) {
    const topic = topicById.get(raw.topicId);
    if (!topic || seenTopicIds.has(topic.topicId)) {
      continue;
    }
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
    let verifiedReferenceCitationCount = 0;
    for (const citation of raw.referenceCitations) {
      if (
        verifiedReferenceCitationCount === MAX_VERIFIED_CITATIONS_PER_FINDING
      ) {
        break;
      }
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
      verifiedReferenceCitationCount += 1;
    }

    const referenceCitations = references.flatMap((reference) => {
      const citations = citationsByFileFieldId.get(reference.fileFieldId);
      return citations
        ? [{ fileFieldId: reference.fileFieldId, citations }]
        : [];
    });

    const hasGroundedEvidence =
      targetCitations.length > 0 || referenceCitations.length > 0;

    findings.push({
      findingId: `reference-${topic.topicId}`,
      topicId: topic.topicId,
      issue: topic.title,
      assessment: hasGroundedEvidence ? raw.assessment : "not-comparable",
      consensus: references.length === 1 ? "single" : raw.consensus,
      rationale: hasGroundedEvidence
        ? raw.rationale.trim()
        : "The supplied documents do not provide grounded evidence for this topic.",
      targetCitations,
      referenceCitations,
      fix: hasGroundedEvidence
        ? buildReferenceFix({
            assessment: raw.assessment,
            proposedText: raw.proposedText,
            targetCitations,
            targetLastBlockId,
          })
        : null,
    });
    seenTopicIds.add(topic.topicId);
  }

  for (const topic of topics) {
    if (seenTopicIds.has(topic.topicId)) {
      continue;
    }
    findings.push({
      findingId: `reference-${topic.topicId}`,
      topicId: topic.topicId,
      issue: topic.title,
      assessment: "not-comparable",
      consensus: references.length === 1 ? "single" : "consistent",
      rationale:
        "The supplied documents do not provide grounded evidence for this topic.",
      targetCitations: [],
      referenceCitations: [],
      fix: null,
    });
  }

  return findings;
};

const SYSTEM_PROMPT = `You compare one target legal document with one or more reference documents.

References are examples, not policy and not proof of market practice. Never call the target compliant, non-compliant, standard, or non-standard. Compare substantive drafting only.

Assess every supplied review topic exactly once. Preserve its topicId exactly. Classify the target as aligned, different, missing-from-target, additional-in-target, deal-specific, or not-comparable. Set consensus to mixed when the reference documents materially disagree with each other. Cite only exact block IDs supplied in the input. F0 is always the target; every other source is a reference. proposedText must be null unless the cited reference language directly supports a concrete target edit. Use not-comparable when the documents do not support a grounded conclusion.`;

const buildReferencePrompt = (
  target: PreparedDocxFile,
  references: readonly PreparedDocxFile[],
  topics: readonly DocumentReviewTopic[],
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
  const topicGuide = topics
    .map(
      (topic) =>
        `- topicId=${topic.topicId}\n  title=${topic.title}\n  reviewer context=${topic.context || "(none)"}`,
    )
    .join("\n");
  return `Review topics:\n${topicGuide}\n\nSource roles:\n${sourceGuide}\n\n${documents}`;
};

type CompareReferenceDocumentsArgs = {
  target: PreparedDocxFile;
  references: readonly PreparedDocxFile[];
  topics: readonly DocumentReviewTopic[];
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
  topics,
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
        prompt: buildReferencePrompt(target, references, topics),
        abortSignal: AbortSignal.any([
          abortSignal,
          AbortSignal.timeout(REFERENCE_REVIEW_TIMEOUT_MS),
        ]),
        outputSchema: referenceReviewSchema,
      });

      return normalizeReferenceReview({
        rawFindings: output.findings,
        topics,
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
