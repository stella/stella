import { panic, Result } from "better-result";

import type { CaseLawResearchAnswerType } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import { resolveCaching } from "@/api/lib/ai-config";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { aiHandlerError } from "@/api/lib/ai-error";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";

/**
 * Drafting a column's prompt with the model, for either set of columns that
 * has one.
 *
 * The reader types the same thing wherever they add a column — a heading, a
 * kind of value, an adjustment to make — and only what the column is asked OF
 * differs: a matter's documents, or the court decisions a search returned.
 * That difference is the context union below, and it is the only thing either
 * caller supplies beyond the draft.
 */

/** One decision the columns will be asked of, as grounding for the wording. */
export type SuggestPromptDecisionSample = {
  caseNumber: string;
  court: string;
  decisionDate: string | null;
  /** The publisher's summary; null when the row carries none. */
  headnote: string | null;
};

/** The search's narrowing, in the fields the search body names them by. */
export type SuggestPromptCaseLawFilters = {
  court: string | undefined;
  decisionType: string | undefined;
  dateFrom: string | undefined;
  dateTo: string | undefined;
  language: string | undefined;
};

/**
 * What the column is asked of.
 *
 * The matter branch carries the workspace, which is both the tenancy the model
 * call runs under and the framing the prompt is written for. The case-law
 * branch carries the search the columns are being added to, so a suggestion
 * targets those decisions rather than court decisions in general. `country`
 * and `query` are absent where the listing has none — a matter's linked
 * decisions span jurisdictions and were never searched for.
 */
export type SuggestPromptContext =
  | { kind: "workspace"; workspaceId: SafeId<"workspace"> }
  | {
      kind: "case-law";
      country: string | undefined;
      query: string | undefined;
      filters: SuggestPromptCaseLawFilters;
      samples: readonly SuggestPromptDecisionSample[];
    };

const WORKSPACE_SYSTEM_PROMPT = `You write extraction prompts for a legal-document AI tool.
Given a column name (and optionally the user's current prompt draft), produce
ONE direct, imperative sentence telling the AI what to extract from the
document. Rules:
- Output the prompt only. No preamble, no quotes, no markdown.
- Single sentence, plain text, ends with a period.
- Write in the same language as the current draft when one is supplied;
  otherwise, write in the same language as the column name. Do not default to
  English merely because these instructions are in English.
- If the user supplied a current draft, REFINE it: keep their intent and
  vocabulary, fix grammar, tighten wording, and align with the result type.
  Do not invent constraints they didn't ask for.
- Follow the separate requested adjustment when it does not conflict with the
  result type or the factual constraints above.
- If no draft, write a fresh prompt grounded in the column name.
- Match the result type:
  - text → ask for the value as a short string.
  - int → ask for a number.
  - date → ask for a date in ISO 8601 (YYYY-MM-DD).
  - single-select → ask the AI to choose exactly one of the listed options.
  - multi-select → ask for all matching options from the list.
- Reference the document implicitly when natural ("from the contract").
- Stay under 280 characters.`;

const CASE_LAW_SYSTEM_PROMPT = `You write the questions a legal-research tool asks of COURT DECISIONS.
Each question becomes one column of a results table, and the tool answers it
once per decision by reading that decision's text. Rules:
- Output the question only. No preamble, no quotes, no markdown.
- Single sentence, plain text, ends with a period or a question mark.
- Write in the same language as the column name. Do not default to English
  merely because these instructions are in English.
- The column name is the question as it stands. REFINE it: keep the user's
  intent and vocabulary, fix grammar, tighten wording, and align with the
  answer type. Do not invent constraints they didn't ask for.
- The question is asked of the jurisdiction and the search named below. Use
  that court practice's own terminology; do not translate it into another
  legal system's vocabulary.
- The listed decisions are a sample of what the search returned. Ground the
  wording in what such decisions actually settle; never ask about one of them
  in particular, and never assume a fact only the sample shows.
- Follow the separate requested adjustment when it does not conflict with the
  answer type or the factual constraints above.
- Match the answer type:
  - text → ask for the answer as a short string.
  - int → ask for a number.
  - date → ask for a date in ISO 8601 (YYYY-MM-DD).
  - single-select → ask the tool to choose exactly one of the listed options.
  - multi-select → ask for all matching options from the list.
- A decision that does not settle the point is an answer in itself; do not ask
  for a value every decision must have.
- Stay under 280 characters.`;

const suggestPromptSystemPrompt = (context: SuggestPromptContext): string => {
  switch (context.kind) {
    case "workspace":
      return WORKSPACE_SYSTEM_PROMPT;
    case "case-law":
      return CASE_LAW_SYSTEM_PROMPT;
    default:
      context satisfies never;
      return panic(`Unhandled suggestion context: ${String(context)}`);
  }
};

const filterLine = (filters: SuggestPromptCaseLawFilters): string | null => {
  const parts: string[] = [];
  if (filters.court !== undefined) {
    parts.push(`court ${filters.court}`);
  }
  if (filters.decisionType !== undefined) {
    parts.push(`decision type ${filters.decisionType}`);
  }
  if (filters.dateFrom !== undefined) {
    parts.push(`decided on or after ${filters.dateFrom}`);
  }
  if (filters.dateTo !== undefined) {
    parts.push(`decided on or before ${filters.dateTo}`);
  }
  if (filters.language !== undefined) {
    parts.push(`language ${filters.language}`);
  }
  return parts.length === 0 ? null : `Active filters: ${parts.join("; ")}`;
};

const sampleLine = (sample: SuggestPromptDecisionSample): string => {
  const identity = [sample.caseNumber, sample.court, sample.decisionDate]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(", ");
  return sample.headnote === null
    ? `- ${identity}`
    : `- ${identity}: ${sample.headnote}`;
};

const contextLines = (context: SuggestPromptContext): string[] => {
  switch (context.kind) {
    case "workspace":
      return [];
    case "case-law": {
      const lines = [
        context.country === undefined
          ? "Asked of: court decisions."
          : `Asked of: court decisions of the jurisdiction with country code ${context.country}.`,
      ];
      if (context.query !== undefined) {
        lines.push(`Current search: ${context.query}`);
      }
      const filters = filterLine(context.filters);
      if (filters !== null) {
        lines.push(filters);
      }
      if (context.samples.length > 0) {
        lines.push("Decisions this search returned:");
        for (const sample of context.samples) {
          lines.push(sampleLine(sample));
        }
      }
      return lines;
    }
    default:
      context satisfies never;
      return panic(`Unhandled suggestion context: ${String(context)}`);
  }
};

/** What the reader has typed into the composer, whichever target it serves. */
type ColumnPromptDraft = {
  /** The column's heading; a question column's heading is its question. */
  name: string;
  contentType: CaseLawResearchAnswerType;
  options: readonly string[] | undefined;
  currentPrompt: string | undefined;
  instruction: string;
};

type BuildSuggestPromptUserMessageOptions = ColumnPromptDraft & {
  context: SuggestPromptContext;
};

export const buildSuggestPromptUserMessage = ({
  context,
  contentType,
  currentPrompt,
  instruction,
  name,
  options,
}: BuildSuggestPromptUserMessageOptions): string => {
  const lines = [
    ...contextLines(context),
    `Column name: ${name}`,
    `Result type: ${contentType}`,
  ];
  if (options && options.length > 0) {
    lines.push(`Allowed options: ${options.join(", ")}`);
  }
  if (currentPrompt && currentPrompt.length > 0) {
    lines.push(`Current draft (refine, don't replace): ${currentPrompt}`);
    lines.push("Output language: Match the current draft's language.");
  } else {
    lines.push("Output language: Match the column name's language.");
  }
  lines.push(`Requested adjustment: ${instruction}`);
  lines.push(closingLine(context));
  return lines.join("\n");
};

const closingLine = (context: SuggestPromptContext): string => {
  switch (context.kind) {
    case "workspace":
      return "Write the extraction prompt:";
    case "case-law":
      return "Write the question:";
    default:
      context satisfies never;
      return panic(`Unhandled suggestion context: ${String(context)}`);
  }
};

const SUGGEST_TIMEOUT_MS = 20_000;
const MAX_PROMPT_LENGTH = 280;

const QUOTE_CHARS = new Set(['"', "'", "“", "”", "‘", "’"]);

const stripWrappingQuotes = (input: string): string => {
  let start = 0;
  let end = input.length;
  while (start < end && QUOTE_CHARS.has(input[start] ?? "")) {
    start += 1;
  }
  while (end > start && QUOTE_CHARS.has(input[end - 1] ?? "")) {
    end -= 1;
  }
  return input.slice(start, end);
};

export const sanitizeSuggestion = (raw: string): string => {
  const trimmed = stripWrappingQuotes(raw.trim())
    // Collapse any whitespace runs (incl. newlines) into single spaces so the
    // suggestion fits on one TipTap paragraph.
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .join(" ");

  if (trimmed.length <= MAX_PROMPT_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_PROMPT_LENGTH - 1).trimEnd()}…`;
};

/**
 * Where the model call is metered and which tenant rows it may touch. A matter
 * column runs under its own workspace; a question column has none — the corpus
 * is global and the columns belong to the organization.
 */
type SuggestionScope = {
  feature: string;
  tenantWorkspaceIds: SafeId<"workspace">[];
  workspaceId: SafeId<"workspace"> | null;
  properties: Record<string, string>;
};

const suggestionScope = (context: SuggestPromptContext): SuggestionScope => {
  switch (context.kind) {
    case "workspace":
      return {
        feature: "properties.prompt.suggest",
        tenantWorkspaceIds: [context.workspaceId],
        workspaceId: context.workspaceId,
        properties: {},
      };
    case "case-law":
      return {
        feature: "case-law.suggest-question",
        tenantWorkspaceIds: [],
        workspaceId: null,
        properties:
          context.country === undefined
            ? {}
            : { jurisdiction: context.country },
      };
    default:
      context satisfies never;
      return panic(`Unhandled suggestion context: ${String(context)}`);
  }
};

type SuggestColumnPromptOptions = {
  draft: ColumnPromptDraft;
  context: SuggestPromptContext;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  safeDb: SafeDb;
  abortSignal: AbortSignal;
};

/**
 * One suggestion, from the draft and what the column is asked of. Stores
 * nothing; consumes AI usage against the scope the context names.
 */
export const suggestColumnPrompt = async ({
  abortSignal,
  context,
  draft,
  orgAIConfig,
  organizationId,
  promptCachingEnabled,
  safeDb,
  userId,
}: SuggestColumnPromptOptions) => {
  const name = draft.name.trim();
  const instruction = draft.instruction.trim();
  if (name.length === 0 || instruction.length === 0) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Column name and rewrite instruction are required",
      }),
    );
  }

  const scope = suggestionScope(context);
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    usageMetering: {
      actionType: "chat",
      organizationId,
      safeDb,
      serviceTier: "standard",
      userId,
      workspaceId: scope.workspaceId,
    },
    feature: scope.feature,
    modelRole: "fast",
    orgAIConfig,
    properties: {
      organization_id: organizationId,
      content_type: draft.contentType,
      ...scope.properties,
    },
    traceId: Bun.randomUUIDv7(),
  });

  const generateResult = await Result.tryPromise({
    try: async () =>
      await generateTanStackTextForRole({
        finishPolicy: "require-complete",
        role: "fast",
        serviceTier: "standard",
        orgAIConfig,
        organizationId,
        tenantWorkspaceIds: scope.tenantWorkspaceIds,
        analytics: aiAnalytics,
        caching: resolveCaching({
          promptCachingEnabled,
          role: "fast",
          scopeKey: null,
        }),
        system: suggestPromptSystemPrompt(context),
        messages: [
          {
            role: "user",
            content: buildSuggestPromptUserMessage({
              name,
              contentType: draft.contentType,
              options: draft.options,
              currentPrompt: draft.currentPrompt?.trim() || undefined,
              instruction,
              context,
            }),
          },
        ],
        abortSignal: AbortSignal.any([
          abortSignal,
          AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
        ]),
      }),
    catch: (error) => {
      aiAnalytics.captureError(error);
      return error;
    },
  });

  if (Result.isError(generateResult)) {
    return Result.err(
      aiHandlerError(generateResult.error, {
        status: 502,
        message: "Suggest prompt failed",
      }),
    );
  }

  const prompt = sanitizeSuggestion(generateResult.value);
  if (prompt.length === 0) {
    return Result.err(
      new HandlerError({ status: 502, message: "Empty suggestion" }),
    );
  }

  return Result.ok({ prompt });
};
