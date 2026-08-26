/**
 * Turning a reference document into positions.
 *
 * One position is ONE reviewable term, typed by the kind of term it is: a
 * quantity, a list, a protection that exists or does not, or a standard of
 * wording. That type is what grading answers with, so a clause-level position
 * ("the warranty framework") is not a position at all — it is several, and it
 * is what produces whole-block rewrites downstream.
 *
 * Every proposed passage is verified against the parsed blocks before it is
 * returned: a position may only quote text the reference actually contains,
 * because that quoted text is what the run — and any playbook saved out of it
 * — will grade against. What the pass deliberately did not turn into a
 * position comes back as `skipped`, so the reviewer sees the size of what was
 * left out instead of assuming the checklist is exhaustive.
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
  REVIEW_SKIP_REASON_MAX_LENGTH,
  REVIEW_SKIP_SUBJECT_MAX_LENGTH,
  REVIEW_SKIPPED_MAX,
} from "@/api/lib/document-review/contract";
import type {
  ReviewParty,
  ReviewSkippedTerm,
} from "@/api/lib/document-review/contract";
import {
  buildReviewDocumentParts,
  reviewDocumentsScopeKey,
} from "@/api/lib/document-review/review-document-messages";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";
import {
  POSITION_SEVERITIES,
  POSITION_TERM_KINDS,
} from "@/api/lib/workflow/playbook-positions";
import type {
  Position,
  PositionSeverity,
  PositionTermKind,
  ReferencePassage,
} from "@/api/lib/workflow/playbook-positions";

const ROLE = "pdf" as const;
const TIMEOUT_MS = 120_000;

/** Matches `positionStandardSchema`'s `passages` bound. A position that needs
 *  more than this to state its standard is not one term. */
const PASSAGES_PER_POSITION_MAX = 12;
const ISSUE_MAX_LENGTH = 256;
const GUIDANCE_MAX_LENGTH = 2000;

const proposedPositionSchema = v.strictObject({
  /** What shape of term this is. Decides how the comparison is expressed and
   *  edited, so it is chosen here, once, rather than per grading. */
  termKind: v.picklist(POSITION_TERM_KINDS),
  issue: v.pipe(v.string(), v.minLength(1), v.maxLength(ISSUE_MAX_LENGTH)),
  /** What the later comparison should examine, and why the severity is what
   *  it is; becomes the position's reviewer guidance. */
  guidance: v.pipe(v.string(), v.maxLength(GUIDANCE_MAX_LENGTH)),
  severity: v.picklist(POSITION_SEVERITIES),
  passages: v.array(
    v.strictObject({ sourceKey: v.string(), blockId: v.string() }),
  ),
});

const skippedTermSchema = v.strictObject({
  subject: v.pipe(v.string(), v.maxLength(REVIEW_SKIP_SUBJECT_MAX_LENGTH)),
  reason: v.pipe(v.string(), v.maxLength(REVIEW_SKIP_REASON_MAX_LENGTH)),
});

type ProposedSkippedTerm = v.InferOutput<typeof skippedTermSchema>;

/** Trims the model's text, drops half-stated entries, and reports each
 *  subject once. */
export const normalizeSkipped = (
  skipped: readonly ProposedSkippedTerm[],
): ReviewSkippedTerm[] => {
  const seen = new Set<string>();
  const normalized: ReviewSkippedTerm[] = [];
  for (const entry of skipped) {
    const subject = entry.subject.trim();
    const reason = entry.reason.trim();
    if (subject.length === 0 || reason.length === 0) {
      continue;
    }
    const key = subject.toLocaleLowerCase("und");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ subject, reason });
    if (normalized.length === REVIEW_SKIPPED_MAX) {
      break;
    }
  }
  return normalized;
};

/**
 * Severity, held to what the term can carry. `blocker` is the walk-away tier,
 * and only a stated quantity — money, a liability cap, a time bar — walks a
 * deal away on its own. A protection or a wording standard may still be `high`,
 * but calling every clause a blocker is what turns a review into a list nobody
 * can triage.
 */
export const cappedSeverity = (
  severity: PositionSeverity,
  termKind: PositionTermKind,
): PositionSeverity =>
  severity === "blocker" && termKind !== "parameter" ? "high" : severity;

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
  // What was read and deliberately not compared.
  skipped: v.array(skippedTermSchema),
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
      severity: cappedSeverity(candidate.severity, candidate.termKind),
      standard: {
        source: "reference",
        termKind: candidate.termKind,
        passages,
      },
      ask: { mode: "auto" },
      ...(guidance.length === 0 ? {} : { guidance }),
      enabled: true,
    });
  }
  return merged;
};

const SYSTEM_PROMPT = `You turn reference legal documents into a review checklist for a new target document (F0). References are examples, not policy and not proof of market practice.

One position is ONE reviewable term, never a clause, a section or a framework. Split anything larger into its terms. termKind says which shape it is:
- parameter: one stated quantity — a time bar, a liability cap, de minimis, a basket, a notice period, a long-stop date, a rate. The issue names the term and what it applies to: "Time-bar: leakage claims", "Cap: title warranties".
- enumeration: one list-shaped definition or set of heads — Leakage limbs, Permitted Leakage items, warranty categories, the components of Losses. One position per list, and quote the block of every limb.
- presence: a defined term or protection that should exist — a "Losses" definition, a W&I policy, a MAC condition, a gross-up.
- language: a standard of wording with no parameter behind it — the "Fairly Disclosed" standard, a knowledge qualifier, sandbagging.

issue is a short noun phrase naming the term. guidance is one line: what the later comparison should examine, and why the severity is what it is. severity is blocker only for money, liability-cap and time-bar terms; everything else is high, medium or low.

passages are the reference blocks that state the term. Cite only exact block IDs supplied in the input, only from reference documents, never from F0. Fewest that carry the term, up to twelve; for an enumeration, every limb. A term you cannot quote is not a position.

Put in skipped, and do not propose, anything deal-specific or structural: signing and closing sequence, the difference between a preliminary and a final agreement, party names and addresses, schedule and annex lists, execution mechanics, and pricing particular to one deal. subject names it; reason says in a few words why it is not comparable.

Do not judge the target, score it, or propose wording. Do not repeat a position the reviewer already has.

parties lists the target's sides only: role is the defined term the target uses (Purchaser, Seller, Landlord, Licensee), name is the legal name when the target states it, otherwise null. Omit guarantors, agents and notaries unless they are principal parties.`;

/** What the proposal pass hands back: the plan to confirm, what it left
 *  uncompared, and the sides the lawyer can act for. */
export type ReviewPositionProposal = {
  positions: Position[];
  skipped: ReviewSkippedTerm[];
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
        skipped: normalizeSkipped(output.skipped),
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
