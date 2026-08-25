import { Result } from "better-result";
import * as v from "valibot";

import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import { resolveCaching } from "@/api/lib/ai-config";
import {
  createTanStackAIAnalyticsCallbacks,
  type AIUsageMetering,
} from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import {
  REFERENCE_ASSESSMENTS,
  REFERENCE_CONSENSUS_VALUES,
  perspectivePartyPhrase,
  REFERENCE_IMPACTS,
  REFERENCE_SEVERITIES,
} from "@/api/lib/document-review/contract";
import type {
  DocumentReviewTopic,
  ReferenceAssessment,
  ReferenceConsensus,
  ReferenceImpact,
  ReferenceSeverity,
  ReviewPerspective,
} from "@/api/lib/document-review/contract";
import {
  buildReviewDocumentParts,
  reviewDocumentsScopeKey,
} from "@/api/lib/document-review/review-document-messages";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import {
  buildGroundedReviewFix,
  type GroundedReviewFix,
} from "@/api/lib/grounded-review-fix";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";

const REFERENCE_REVIEW_TIMEOUT_MS = 120_000;
const REFERENCE_REVIEW_ROLE = "pdf" as const;
const MAX_VERIFIED_CITATIONS_PER_FINDING = 8;

const rawCitationSchema = v.strictObject({
  sourceKey: v.string(),
  blockId: v.string(),
});

const rawFindingSchema = v.strictObject({
  topicId: v.string(),
  assessment: v.picklist(REFERENCE_ASSESSMENTS),
  consensus: v.picklist(REFERENCE_CONSENSUS_VALUES),
  rationale: v.string(),
  // What to change in the target, as one instruction; empty when nothing
  // should change.
  recommendation: v.string(),
  // Which way the difference cuts for the chosen side, and how much it
  // matters. `unknown` when no side was chosen or the direction is unclear.
  impact: v.picklist(REFERENCE_IMPACTS),
  severity: v.picklist(REFERENCE_SEVERITIES),
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

// Re-exported from the plain contract module so existing importers keep the
// `reference-compare` path while the persisted-run schema derives its CHECK
// constraint from the same source.
export type { ReferenceAssessment, ReferenceConsensus };

export type ReferenceCitation = {
  blockId: string;
  text: string;
};

export type ReferenceReviewFix = GroundedReviewFix;

export type ReferenceReviewFinding = {
  findingId: string;
  topicId: string;
  issue: string;
  assessment: ReferenceAssessment;
  consensus: ReferenceConsensus;
  explanation:
    | { type: "comparison"; text: string }
    | { type: "insufficient-evidence" };
  /** One instruction for the drafter: what to change in the target and in
   *  which direction, or `null` when the target needs no change. Optional
   *  only because findings persisted before it existed carry no value. */
  recommendation?: string | null;
  /** Direction and weight of the difference for the run's side. Optional
   *  only because findings persisted before they existed carry neither. */
  impact?: ReferenceImpact;
  severity?: ReferenceSeverity;
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
  hasReferenceCitation,
  targetCitations,
}: {
  assessment: ReferenceAssessment;
  proposedText: string | null;
  hasReferenceCitation: boolean;
  targetCitations: readonly ReferenceCitation[];
}): ReferenceReviewFix | null => {
  if (assessment === "different") {
    return buildGroundedReviewFix({
      kind: "replaceBlock",
      proposedText,
      supportingEvidenceVerified: hasReferenceCitation,
      targetAnchors: targetCitations,
    });
  }
  if (assessment === "missing-from-target") {
    return buildGroundedReviewFix({
      kind: "insertAfterBlock",
      proposedText,
      supportingEvidenceVerified: hasReferenceCitation,
      targetAnchors: targetCitations,
    });
  }
  return null;
};

const hasEvidenceForAssessment = ({
  assessment,
  hasTargetCitation,
  hasReferenceCitation,
}: {
  assessment: ReferenceAssessment;
  hasTargetCitation: boolean;
  hasReferenceCitation: boolean;
}): boolean => {
  switch (assessment) {
    case "aligned":
    case "different":
      return hasTargetCitation && hasReferenceCitation;
    case "missing-from-target":
      return hasReferenceCitation;
    case "additional-in-target":
    case "deal-specific":
      return hasTargetCitation;
    case "not-comparable":
      return false;
    default:
      assessment satisfies never;
      return false;
  }
};

const normalizeReferenceConsensus = (
  consensus: ReferenceConsensus,
  referenceCount: number,
): ReferenceConsensus => {
  if (referenceCount === 1) {
    return "single";
  }
  switch (consensus) {
    case "mixed":
      return "mixed";
    case "consistent":
    case "single":
      return "consistent";
    default:
      consensus satisfies never;
      return "consistent";
  }
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
  const findings: ReferenceReviewFinding[] = [];
  const topicById = new Map(topics.map((topic) => [topic.topicId, topic]));
  const rawFindingByTopicId = new Map<string, RawReferenceFinding>();
  for (const raw of rawFindings) {
    if (!topicById.has(raw.topicId) || rawFindingByTopicId.has(raw.topicId)) {
      continue;
    }
    rawFindingByTopicId.set(raw.topicId, raw);
  }

  for (const topic of topics) {
    const raw = rawFindingByTopicId.get(topic.topicId);
    if (!raw) {
      findings.push({
        findingId: `reference-${topic.topicId}`,
        topicId: topic.topicId,
        issue: topic.title,
        assessment: "not-comparable",
        consensus: references.length === 1 ? "single" : "consistent",
        explanation: { type: "insufficient-evidence" },
        targetCitations: [],
        referenceCitations: [],
        fix: null,
      });
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

    const hasTargetCitation = targetCitations.length > 0;
    const hasReferenceCitation = referenceCitations.length > 0;
    const hasGroundedEvidence = hasEvidenceForAssessment({
      assessment: raw.assessment,
      hasTargetCitation,
      hasReferenceCitation,
    });
    const assessment = hasGroundedEvidence ? raw.assessment : "not-comparable";

    findings.push({
      findingId: `reference-${topic.topicId}`,
      topicId: topic.topicId,
      issue: topic.title,
      assessment,
      consensus: normalizeReferenceConsensus(raw.consensus, references.length),
      explanation: hasGroundedEvidence
        ? { type: "comparison", text: raw.rationale.trim() }
        : { type: "insufficient-evidence" },
      recommendation:
        hasGroundedEvidence && raw.recommendation.trim().length > 0
          ? raw.recommendation.trim()
          : null,
      // An ungrounded finding cannot cut either way; a topic the target
      // handles the same way has nothing to weigh.
      impact: hasGroundedEvidence ? raw.impact : "unknown",
      ...(hasGroundedEvidence ? { severity: raw.severity } : {}),
      targetCitations,
      referenceCitations,
      fix: hasGroundedEvidence
        ? buildReferenceFix({
            assessment,
            proposedText: raw.proposedText,
            hasReferenceCitation,
            targetCitations,
          })
        : null,
    });
  }

  return findings;
};

const SYSTEM_PROMPT = `You compare one target legal document with one or more reference documents.

References are examples, not policy and not proof of market practice. Never call the target compliant, non-compliant, standard, or non-standard. Compare substantive drafting only.

Assess every supplied review topic exactly once. Preserve its topicId exactly. Classify the target as aligned, different, missing-from-target, additional-in-target, deal-specific, or not-comparable. Set consensus to mixed when the reference documents materially disagree with each other. Cite only exact block IDs supplied in the input. F0 is always the target; every other source is a reference. In rationale and recommendation, write "the target" and "the reference" (or "reference 1", "reference 2" when there are several); never write source keys such as F0 or F1. rationale states what each document does on the topic and how they differ, in plain drafting terms. recommendation is one imperative sentence telling the drafter what to change in the target and in which direction (which clause, what to add, tighten, or remove), grounded in the reference; it is an empty string when the target needs no change. The input names the side the drafter acts for. impact says which way the target's difference from the reference cuts for that side: unfavourable when the target leaves that side worse off than the reference does, favourable when better off, neutral when it makes no difference to that side, unknown when no side was named or the direction cannot be told. severity says how much the difference matters for that side: high for money, liability, or deal certainty at stake, medium for a material but bounded term, low for drafting or convenience. proposedText must be null unless the cited reference language directly supports a concrete target edit. For missing-from-target proposed text, the first target citation must identify the verified block after which the new text belongs; without a safe target anchor, proposedText must be null. Use not-comparable when the documents do not support a grounded conclusion.`;

// The topics come after the shared document region: they are what changes
// between calls, and anything placed before the documents would push them out
// of the cached prefix.
const NEUTRAL_PERSPECTIVE_LINE = "No side is named; report impact as unknown.";

const perspectiveLine = (perspective: ReviewPerspective): string => {
  switch (perspective.type) {
    case "party":
      return `The drafter acts for ${perspectivePartyPhrase(perspective)}, a party to the target. A reference may name that side differently; judge impact for the side that plays the same role there.`;
    case "neutral":
      return NEUTRAL_PERSPECTIVE_LINE;
    default:
      return perspective satisfies never;
  }
};

const buildTopicsPart = (
  topics: readonly DocumentReviewTopic[],
  perspective: ReviewPerspective,
): string => {
  const topicGuide = topics
    .map(
      (topic) =>
        `- topicId=${topic.topicId}\n  title=${topic.title}\n  reviewer context=${topic.context || "(none)"}`,
    )
    .join("\n");
  return `${perspectiveLine(perspective)}\n\nReview topics:\n${topicGuide}`;
};

type CompareReferenceDocumentsArgs = {
  target: PreparedDocxFile;
  references: readonly PreparedDocxFile[];
  topics: readonly DocumentReviewTopic[];
  perspective: ReviewPerspective;
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
  perspective,
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
  const caching = resolveCaching({
    promptCachingEnabled,
    role: REFERENCE_REVIEW_ROLE,
    scopeKey: reviewDocumentsScopeKey(
      targetEntityVersionId,
      referenceEntityVersionIds,
    ),
  });
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
        caching,
        serviceTier,
        tenantWorkspaceIds: [workspaceId],
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              ...buildReviewDocumentParts({ target, references, caching }),
              {
                type: "text",
                content: buildTopicsPart(topics, perspective),
              },
            ],
          },
        ],
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
