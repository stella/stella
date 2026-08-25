/**
 * Turning a reference document into positions.
 *
 * The proposal pass reads the reference documents and returns a draft position
 * per issue they make worth comparing, each carrying the passages that define
 * the standard for it. Every proposed passage is verified against the parsed
 * blocks before it is returned: a position may only quote text the reference
 * actually contains, because that quoted text is what the run — and any
 * playbook saved out of it — will grade against.
 */

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
  REVIEW_PARTIES_MAX,
  REVIEW_PARTY_NAME_MAX_LENGTH,
  REVIEW_PARTY_ROLE_MAX_LENGTH,
} from "@/api/lib/document-review/contract";
import type { ReviewParty } from "@/api/lib/document-review/contract";
import {
  buildReviewDocumentParts,
  reviewDocumentsScopeKey,
} from "@/api/lib/document-review/review-document-messages";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";
import { POSITION_SEVERITIES } from "@/api/lib/workflow/playbook-positions";
import type {
  Position,
  ReferencePassage,
} from "@/api/lib/workflow/playbook-positions";

const ROLE = "pdf" as const;
const TIMEOUT_MS = 120_000;

/** Matches `positionStandardSchema`'s `passages` bound. A position that needs
 *  more than this to state its standard is really several positions. */
const PASSAGES_PER_POSITION_MAX = 8;
const ISSUE_MAX_LENGTH = 256;
const GUIDANCE_MAX_LENGTH = 2000;

const proposedPositionSchema = v.strictObject({
  issue: v.pipe(v.string(), v.minLength(1), v.maxLength(ISSUE_MAX_LENGTH)),
  /** What the later comparison should examine; becomes the position's
   *  reviewer guidance. */
  guidance: v.pipe(v.string(), v.maxLength(GUIDANCE_MAX_LENGTH)),
  severity: v.picklist(POSITION_SEVERITIES),
  passages: v.array(
    v.strictObject({ sourceKey: v.string(), blockId: v.string() }),
  ),
});

// No transforms here: the schema is handed to the provider as JSON Schema,
// which cannot express them. Whitespace is normalized in `normalizeParties`.
const proposedPartySchema = v.strictObject({
  role: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(REVIEW_PARTY_ROLE_MAX_LENGTH),
  ),
  name: v.nullable(
    v.pipe(v.string(), v.maxLength(REVIEW_PARTY_NAME_MAX_LENGTH)),
  ),
});

type ProposedParty = v.InferOutput<typeof proposedPartySchema>;

/** Trims the model's text and drops entries left without a role. */
export const normalizeParties = (
  parties: readonly ProposedParty[],
): ReviewParty[] => {
  const normalized: ReviewParty[] = [];
  for (const party of parties.slice(0, REVIEW_PARTIES_MAX)) {
    const role = party.role.trim();
    if (role.length === 0) {
      continue;
    }
    const name = party.name?.trim() ?? "";
    normalized.push({ role, name: name.length === 0 ? null : name });
  }
  return normalized;
};

export const proposedPositionsSchema = v.strictObject({
  // Cardinality is normalized below. Providers do not reliably honor JSON
  // Schema array limits, so excess suggestions stay recoverable.
  positions: v.array(proposedPositionSchema),
  // The target's parties, so the lawyer can say which one they act for.
  parties: v.array(proposedPartySchema),
});

type ProposedPosition = v.InferOutput<typeof proposedPositionSchema>;

/** Where a prepared reference document came from, so a verified block can be
 *  pinned as a passage that outlives this request. */
export type ReferenceSource = {
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  file: PreparedDocxFile;
};

type SourceIndex = ReadonlyMap<
  string,
  { source: ReferenceSource; blocks: ReadonlyMap<string, string> }
>;

const indexSources = (sources: readonly ReferenceSource[]): SourceIndex =>
  new Map(
    sources.map((source) => [
      source.file.simplifiedName,
      {
        source,
        blocks: new Map(
          source.file.blocks.map((block) => [block.id, block.text]),
        ),
      },
    ]),
  );

/**
 * Verify the proposed passages against the documents they claim to quote. A
 * passage the reference does not contain is dropped, and a position left with
 * none is dropped with it: a standard nobody can quote is not a standard.
 */
const verifyPassages = (
  proposed: readonly ProposedPosition["passages"][number][],
  sources: SourceIndex,
): ReferencePassage[] => {
  const seen = new Set<string>();
  const passages: ReferencePassage[] = [];
  for (const { sourceKey, blockId } of proposed) {
    const entry = sources.get(sourceKey);
    const text = entry?.blocks.get(blockId);
    if (entry === undefined || text === undefined || text.trim().length === 0) {
      continue;
    }
    const key = `${entry.source.entityVersionId}:${blockId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    passages.push({
      workspaceId: entry.source.workspaceId,
      entityId: entry.source.entityId,
      fileFieldId: entry.source.file.fileFieldId,
      entityVersionId: entry.source.entityVersionId,
      blockId,
      text,
    });
    if (passages.length === PASSAGES_PER_POSITION_MAX) {
      break;
    }
  }
  return passages;
};

const normalizeIssue = (value: string): string =>
  value.trim().toLocaleLowerCase("und");

type NormalizeProposedPositionsArgs = {
  proposed: readonly ProposedPosition[];
  seededPositions: readonly Position[];
  sources: readonly ReferenceSource[];
  positionsMax: number;
};

/**
 * The confirmed list the reviewer edits: what they already had, then every
 * proposed position whose standard is grounded and whose issue is new.
 *
 * The ask is `auto` with nothing derived: a reference-standard position is
 * compared against the document's own blocks and never extracts a value, so
 * there is no question to derive.
 */
export const normalizeProposedPositions = ({
  proposed,
  seededPositions,
  sources,
  positionsMax,
}: NormalizeProposedPositionsArgs): Position[] => {
  const index = indexSources(sources);
  const merged = [...seededPositions];
  const seen = new Set(
    seededPositions.map((position) => normalizeIssue(position.issue)),
  );
  for (const candidate of proposed) {
    if (merged.length >= positionsMax) {
      break;
    }
    const issue = candidate.issue.trim();
    const normalized = normalizeIssue(issue);
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    const passages = verifyPassages(candidate.passages, index);
    if (passages.length === 0) {
      continue;
    }
    seen.add(normalized);
    const guidance = candidate.guidance.trim();
    merged.push({
      mode: "graded",
      sourceId: Bun.randomUUIDv7(),
      issue,
      severity: candidate.severity,
      standard: { source: "reference", passages },
      ask: { mode: "auto" },
      ...(guidance.length === 0 ? {} : { guidance }),
      enabled: true,
    });
  }
  return merged;
};

const SYSTEM_PROMPT = `You turn one or more reference legal documents into a checklist of positions for reviewing a new target document (F0).

A position is one material legal or commercial issue plus the passages of a reference document that state how it should be handled. Propose a concise, non-overlapping list of the positions the supplied documents make useful to compare. References are examples, not policy and not proof of market practice. Do not make findings about the target, score it, or propose wording yet. Do not repeat any position the reviewer already has.

For each position: issue is a short noun phrase naming the issue; guidance is a short note on what the later comparison should examine; severity is blocker, high, medium, or low, judged by how much the issue matters commercially or legally. passages are the reference blocks that state the standard for that issue: cite only exact block IDs supplied in the input, only from reference documents (never from F0, the target), and only blocks that actually state the position. One to eight passages, fewest that carry the point. A position whose standard you cannot quote must not be proposed.

Also list the parties to the target document only: role is the defined term the target uses for that side (for example Purchaser, Seller, Landlord, Licensee), name is the party's legal name when the target states it, otherwise null. One entry per side; omit guarantors, agents and notaries unless they are principal parties.`;

/** What the proposal pass hands back: the plan to confirm and the sides the
 *  lawyer can act for. */
export type ReviewPositionProposal = {
  positions: Position[];
  parties: ReviewParty[];
};

export type ProposeReferencePositionsArgs = {
  target: PreparedDocxFile;
  references: readonly ReferenceSource[];
  seededPositions: readonly Position[];
  positionsMax: number;
  targetEntityVersionId: SafeId<"entityVersion">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
  usageMetering: AIUsageMetering;
  abortSignal: AbortSignal;
};

export const proposeReferencePositions = async ({
  target,
  references,
  seededPositions,
  positionsMax,
  targetEntityVersionId,
  organizationId,
  workspaceId,
  orgAIConfig,
  promptCachingEnabled,
  serviceTier,
  usageMetering,
  abortSignal,
}: ProposeReferencePositionsArgs): Promise<
  Result<ReviewPositionProposal, WorkflowIntegrationError>
> => {
  const referenceFiles = references.map((reference) => reference.file);
  const caching = resolveCaching({
    promptCachingEnabled,
    role: ROLE,
    scopeKey: reviewDocumentsScopeKey(
      targetEntityVersionId,
      references.map((reference) => reference.entityVersionId),
    ),
  });
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    feature: "document-review.positions",
    modelRole: ROLE,
    orgAIConfig,
    properties: {
      file_count: references.length + 1,
      organization_id: organizationId,
      workspace_id: workspaceId,
    },
    traceId: Bun.randomUUIDv7(),
    usageMetering,
  });
  const seeded = seededPositions
    .map((position) => `- ${position.issue}`)
    .join("\n");

  return await Result.tryPromise({
    try: async () => {
      const output = await generateTanStackObjectForRole({
        role: ROLE,
        orgAIConfig,
        organizationId,
        analytics: aiAnalytics,
        caching,
        serviceTier,
        tenantWorkspaceIds: [workspaceId],
        system: SYSTEM_PROMPT,
        // Documents first (the shared, cached region), the seeds last.
        messages: [
          {
            role: "user",
            content: [
              ...buildReviewDocumentParts({
                target,
                references: referenceFiles,
                caching,
              }),
              {
                type: "text",
                content: `Positions the reviewer already has (do not repeat):\n${seeded || "(none)"}`,
              },
            ],
          },
        ],
        abortSignal: AbortSignal.any([
          abortSignal,
          AbortSignal.timeout(TIMEOUT_MS),
        ]),
        outputSchema: proposedPositionsSchema,
      });
      return {
        positions: normalizeProposedPositions({
          proposed: output.positions,
          seededPositions,
          sources: references,
          positionsMax,
        }),
        parties: normalizeParties(output.parties),
      };
    },
    catch: (cause) => {
      aiAnalytics.captureError(cause);
      return new WorkflowIntegrationError({
        message: "Review position proposal failed",
        cause,
      });
    },
  });
};
