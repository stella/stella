import { panic, Result } from "better-result";
import { and, asc, eq, isNull } from "drizzle-orm";
import * as v from "valibot";

import { rootDb } from "@/api/db/root";
import {
  aiMemories,
  chatThreadCompactions,
  chatThreads,
  organizationSettings,
} from "@/api/db/schema";
import { resolveCaching } from "@/api/lib/ai-config";
import {
  loadOrgAIConfig,
  loadPromptCachingPreference,
} from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { errorTag } from "@/api/lib/errors/utils";
import { sanitizeMemoryContent } from "@/api/lib/memory/memory-content-safety";
import { createRootSafeDb } from "@/api/lib/root-scoped-db";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";

export const MEMORY_EXTRACTOR_TASK = "memory.extractor" as const;

const EXTRACTION_BATCH_SIZE = 25;
const EXTRACTION_TIMEOUT_MS = 30_000;
const MAX_CANDIDATES = 3;
const MAX_CONTENT_LENGTH = 4000;
const SUMMARY_MAX_CHARS = 12_000;
const MEMORY_MAX_OUTPUT_TOKENS = 1024;

// Matter-specific kinds carry facts about one matter, so the DB rejects
// them anywhere but scope='workspace'. The extractor mirrors that split:
// these become workspace memories, everything else becomes user memories.
const MATTER_KINDS = ["fact", "decision", "relationship"] as const;
const CANDIDATE_KINDS = [
  "fact",
  "decision",
  "relationship",
  "preference",
  "instruction",
] as const;
type CandidateKind = (typeof CANDIDATE_KINDS)[number];

const MATTER_KIND_SET: ReadonlySet<string> = new Set(MATTER_KINDS);

// Suggested-first: the model proposes a kind and content; scope is then
// derived from the kind (never trusted from the model) so a matter fact
// can never be promoted to user/firm scope.
const candidateSchema = v.strictObject({
  kind: v.picklist(CANDIDATE_KINDS),
  content: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

const extractionSchema = v.strictObject({
  candidates: v.array(candidateSchema),
});

const EXTRACTION_SYSTEM_PROMPT = `You extract durable, reusable memories from a summarized legal chat.

Return 0 to ${MAX_CANDIDATES} candidate memories. Prefer returning none over a weak one.
Only extract information worth recalling in future conversations: stable user preferences, standing instructions, or matter-specific facts, decisions, and relationships.
Choose a kind for each candidate:
- preference: a stable preference of the user (tone, format, working style).
- instruction: a standing instruction the user wants followed.
- fact: a durable fact about this specific matter.
- decision: a decision made within this specific matter.
- relationship: a relationship between parties in this specific matter.
Use fact, decision, or relationship ONLY for information tied to this one matter.
Do not extract transient details, one-off questions, or anything you are unsure about.
Do not invent information that is not in the summary.`;

type CompactionRow = {
  compactionId: SafeId<"chatThreadCompaction">;
  summaryMarkdown: string;
  threadUserId: SafeId<"user">;
  threadWorkspaceId: SafeId<"workspace"> | null;
  threadOrganizationId: SafeId<"organization">;
  threadDataWorkspaceIds: SafeId<"workspace">[];
};

/**
 * Suggest-first memory extraction. Reads chat-thread compactions that have
 * not been mined yet, asks the cheap model for up to three candidate
 * memories per summary, and inserts each as status='suggested' so a human
 * confirms before it influences the assistant. Each compaction is stamped
 * with `memoryExtractedAt` afterwards for idempotency.
 *
 * Runs on the root connection: it spans every tenant, so every insert
 * carries the originating thread's own organization/user/workspace ids and
 * never widens scope.
 */
export const extractMemoriesFromCompactions: SchedulerTask = async ({
  logger,
  signal,
}) => {
  const compactions = await loadUnminedCompactions();

  let processed = 0;
  let failed = 0;
  let suggested = 0;

  for (const compaction of compactions) {
    if (signal.aborted) {
      break;
    }

    // eslint-disable-next-line no-await-in-loop -- sequential by design: one background model call at a time keeps provider load bounded and the abort check between calls meaningful
    const candidatesResult = await extractCandidates(compaction, signal);

    if (Result.isError(candidatesResult)) {
      failed += 1;
      captureError(candidatesResult.error, {
        feature: "memory.extractor",
        compactionId: compaction.compactionId,
      });
      logger.warn("scheduler.memory_extractor_failed", {
        "error.type": errorTag(candidatesResult.error),
        "compaction.id": compaction.compactionId,
      });
      continue;
    }

    // An abort while the model call was in flight must not stamp the
    // compaction as mined: leave it for the next run.
    if (signal.aborted) {
      break;
    }

    // eslint-disable-next-line no-await-in-loop -- persistence is ordered after its own model call; the compaction must be stamped before the next one is mined
    suggested += await persistSuggestions({
      candidates: candidatesResult.value,
      compaction,
    });
    processed += 1;
  }

  logger.info("scheduler.memory_extractor", {
    "compaction.processed": processed,
    "compaction.failed": failed,
    "memory.suggested": suggested,
  });

  if (signal.aborted) {
    panic("SchedulerAborted");
  }
};

const loadUnminedCompactions = async (): Promise<CompactionRow[]> => {
  const rows = await rootDb
    .select({
      compactionId: chatThreadCompactions.id,
      summaryMarkdown: chatThreadCompactions.summaryMarkdown,
      threadUserId: chatThreads.userId,
      threadWorkspaceId: chatThreads.workspaceId,
      threadOrganizationId: chatThreads.organizationId,
      threadDataWorkspaceIds: chatThreads.dataWorkspaceIds,
    })
    .from(chatThreadCompactions)
    .innerJoin(chatThreads, eq(chatThreads.id, chatThreadCompactions.threadId))
    // Background extraction is opt-in per organization. The inner join to
    // organization_settings skips any org whose settings row is missing,
    // and the flag filter skips orgs that left it off, so background AI
    // spend on an org's own provider key stays explicit (cost attribution).
    .innerJoin(
      organizationSettings,
      eq(organizationSettings.organizationId, chatThreads.organizationId),
    )
    .where(
      and(
        isNull(chatThreadCompactions.memoryExtractedAt),
        eq(organizationSettings.memoryExtractionEnabled, true),
      ),
    )
    .orderBy(asc(chatThreadCompactions.createdAt))
    .limit(EXTRACTION_BATCH_SIZE);

  return rows.map((row) => ({
    compactionId: row.compactionId,
    summaryMarkdown: row.summaryMarkdown,
    // chatThreads.userId is a bare text FK to user.id (not branded in the
    // schema); brand it at this boundary so downstream inserts stay typed.
    threadUserId: brandPersistedUserId(row.threadUserId),
    threadWorkspaceId: row.threadWorkspaceId,
    threadOrganizationId: row.threadOrganizationId,
    threadDataWorkspaceIds: row.threadDataWorkspaceIds,
  }));
};

type ExtractedCandidate = {
  kind: CandidateKind;
  content: string;
};

const extractCandidates = async (
  compaction: CompactionRow,
  schedulerSignal: AbortSignal,
): Promise<Result<ExtractedCandidate[], unknown>> => {
  const summary = compaction.summaryMarkdown.slice(0, SUMMARY_MAX_CHARS);

  // Background extraction spends on the originating org's own provider key,
  // so it routes through that org's BYOK config and prompt-caching
  // preference and meters the call as background usage for cost attribution.
  const [orgAIConfig, promptCachingEnabled] = await Promise.all([
    loadOrgAIConfig(compaction.threadOrganizationId),
    loadPromptCachingPreference(compaction.threadOrganizationId),
  ]);

  const analytics = createTanStackAIAnalyticsCallbacks({
    feature: "memory.extractor",
    modelRole: "fast",
    orgAIConfig,
    traceId: Bun.randomUUIDv7(),
    usageMetering: {
      actionType: "background",
      organizationId: compaction.threadOrganizationId,
      // The scheduler runs on the root connection; scope a SafeDb to the
      // originating tenant so the usage-event write lands under RLS.
      safeDb: createRootSafeDb({
        organizationId: compaction.threadOrganizationId,
        userId: compaction.threadUserId,
        workspaceIds: compaction.threadWorkspaceId
          ? [compaction.threadWorkspaceId]
          : [],
      }),
      serviceTier: "batch",
      userId: compaction.threadUserId,
      workspaceId: compaction.threadWorkspaceId,
    },
  });

  const result = await Result.tryPromise({
    try: async () =>
      await generateTanStackObjectForRole({
        role: "fast",
        serviceTier: "batch",
        organizationId: compaction.threadOrganizationId,
        orgAIConfig,
        analytics,
        caching: resolveCaching({
          promptCachingEnabled,
          role: "fast",
          scopeKey: compaction.compactionId,
        }),
        system: EXTRACTION_SYSTEM_PROMPT,
        prompt: summary,
        outputSchema: extractionSchema,
        maxOutputTokens: MEMORY_MAX_OUTPUT_TOKENS,
        // Combine the per-call timeout with the scheduler's shutdown signal
        // so a graceful stop cancels an in-flight model call immediately.
        abortSignal: AbortSignal.any([
          AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
          schedulerSignal,
        ]),
      }),
    catch: (error: unknown) => error,
  });

  if (Result.isError(result)) {
    analytics.captureError(result.error);
    return Result.err(result.error);
  }

  return Result.ok(normalizeCandidates(result.value.candidates));
};

const normalizeCandidates = (
  candidates: readonly { kind: CandidateKind; content: string }[],
): ExtractedCandidate[] => {
  const normalized: ExtractedCandidate[] = [];
  for (const candidate of candidates) {
    if (normalized.length >= MAX_CANDIDATES) {
      break;
    }
    // These candidates were produced from untrusted matter/chat text, so
    // drop any that carry an injection signal before they reach the
    // suggestions queue; the sanitizer also trims and flattens.
    const sanitized = sanitizeMemoryContent(candidate.content);
    if (Result.isError(sanitized)) {
      continue;
    }
    normalized.push({
      kind: candidate.kind,
      content: sanitized.value.slice(0, MAX_CONTENT_LENGTH),
    });
  }
  return normalized;
};

type SuggestionInsert = typeof aiMemories.$inferInsert;

type PersistSuggestionsOptions = {
  candidates: ExtractedCandidate[];
  compaction: CompactionRow;
};

const persistSuggestions = async ({
  candidates,
  compaction,
}: PersistSuggestionsOptions): Promise<number> => {
  const rows = candidates.flatMap((candidate) =>
    buildSuggestionRow({ candidate, compaction }),
  );

  await rootDb.transaction(async (tx) => {
    if (rows.length > 0) {
      await tx.insert(aiMemories).values(rows);
    }

    await tx
      .update(chatThreadCompactions)
      .set({ memoryExtractedAt: new Date() })
      .where(eq(chatThreadCompactions.id, compaction.compactionId));
  });

  return rows.length;
};

type BuildSuggestionRowOptions = {
  candidate: ExtractedCandidate;
  compaction: CompactionRow;
};

const resolveSourceDataWorkspaceIds = (
  compaction: CompactionRow,
): SafeId<"workspace">[] => {
  if (compaction.threadDataWorkspaceIds.length > 0) {
    return compaction.threadDataWorkspaceIds;
  }
  if (compaction.threadWorkspaceId) {
    return [compaction.threadWorkspaceId];
  }
  return [];
};

const buildSuggestionRow = ({
  candidate,
  compaction,
}: BuildSuggestionRowOptions): SuggestionInsert[] => {
  const sourceDataWorkspaceIds = resolveSourceDataWorkspaceIds(compaction);

  // Scope is derived from the kind, never trusted from the model, so a
  // matter-specific kind can only ever land at scope='workspace' (matching
  // the DB CHECK) and a user-preference kind can only land at scope='user'.
  if (MATTER_KIND_SET.has(candidate.kind)) {
    if (!compaction.threadWorkspaceId) {
      // Matter kind without a matter to attach it to: drop it rather than
      // mis-scope it. A user/firm fact is exactly what we must never create.
      return [];
    }
    return [
      {
        organizationId: compaction.threadOrganizationId,
        scope: "workspace",
        workspaceId: compaction.threadWorkspaceId,
        userId: null,
        kind: candidate.kind,
        content: candidate.content,
        status: "suggested",
        source: "extracted",
        createdBy: null,
        sourceDataWorkspaceIds,
      },
    ];
  }

  return [
    {
      organizationId: compaction.threadOrganizationId,
      scope: "user",
      userId: compaction.threadUserId,
      workspaceId: null,
      kind: candidate.kind,
      content: candidate.content,
      status: "suggested",
      source: "extracted",
      createdBy: null,
      // User preferences/instructions are matter-agnostic and must stay
      // portable across the lawyer's matters, so they carry no source
      // matter gating. Only workspace-scoped memories above track the
      // matters whose data informed them.
      sourceDataWorkspaceIds: [],
    },
  ];
};
