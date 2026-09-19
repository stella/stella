import type { DocumentPart, TextPart } from "@tanstack/ai";
import type {
  AnthropicDocumentMetadata,
  AnthropicTextMetadata,
} from "@tanstack/ai-anthropic";
import { panic, Result } from "better-result";

import { resolveCaching } from "@/api/lib/ai-config";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import {
  decodeSystemOneAnswers,
  planSystemOneAnswers,
} from "@/api/lib/decisions/answer-questions";
import { decideMany } from "@/api/lib/decisions/decide";
import type { DecisionModel } from "@/api/lib/decisions/decision-model";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { sanitizeForPrompt, untrustedText } from "@/api/lib/prompt-safety";
import { splitPropertiesForBudget } from "@/api/lib/structured-output-budget";
import { markTanStackCacheBreakpoint } from "@/api/lib/tanstack-ai-caching";
import {
  resolveTanStackTextModel,
  streamTanStackObjectForRole,
  structuredOutputWireJsonSchema,
} from "@/api/lib/tanstack-ai-generate";
import type { Answer } from "@/api/lib/workflow/ai-answer-schema";
import {
  buildBatchSchema,
  buildDocxBlocksMessage,
  buildExtractedFileMessage,
  buildPromptsMessage,
  buildTextInputsMessage,
  WORKFLOW_SYSTEM_PROMPT,
} from "@/api/lib/workflow/ai-prompts";
import type { PreparedInputFile } from "@/api/lib/workflow/generate-batch";
import type { TextInput } from "@/api/lib/workflow/generate-batch-shared";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type {
  AIJustificationOutput,
  JustificationFilenames,
} from "@/api/lib/workflow/parse-justifications";
import { getWorkflowBatchAITimeoutMs } from "@/api/lib/workflow/run-logic";
import {
  consumePartialAnswers,
  consumeTanStackPartialAnswer,
  formatPartialAnswer,
} from "@/api/lib/workflow/streaming-answer";
import type { PartialAnswerUpdate } from "@/api/lib/workflow/streaming-answer";
import {
  outputFromSystemOneOutcomes,
  questionsFromProperties,
  sourcesFromPreparedFiles,
  splitPropertiesForSystemOne,
  SYSTEM_ONE_BATCH_LANGUAGE,
  systemOneDocumentHeader,
} from "@/api/lib/workflow/system-one-batch";

type GenerateWorkflowDataProps = {
  files: PreparedInputFile[];
  properties: AIBatchProperty[];
  filenames: JustificationFilenames;
  textInputs: TextInput[];
  abortSignal: AbortSignal;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityVersionId: string;
  orgAIConfig?: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
  usageMetering?: AIUsageMetering | undefined;
  onPartialAnswer?:
    | ((update: PartialAnswerUpdate) => Promise<void> | void)
    | undefined;
  /** Injected by tests; the org's resolved decision model otherwise, null for none. */
  decisionModel?: DecisionModel | null | undefined;
};

export type WorkflowDataOutput = Record<
  string,
  { answer: Answer; justification: AIJustificationOutput }
>;

type WorkflowAIAnalyticsProps = Parameters<
  typeof createTanStackAIAnalyticsCallbacks
>[0];

type BuildWorkflowAIAnalyticsPropsInput = {
  entityVersionId: string;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  propertyCount: number;
  usageMetering?: AIUsageMetering | undefined;
  workspaceId: SafeId<"workspace">;
};

export const EXTRACTED_TEXT_PROMPT_LIMITS = {
  perFileChars: 40_000,
  totalChars: 100_000,
} as const;

const EXTRACTED_TEXT_TRUNCATION_MARKER =
  "\n\n[… content truncated to fit AI prompt limits …]";

type LimitExtractedTextPromptContentOptions = {
  content: string;
  fileCount: number;
};

export const limitExtractedTextPromptContent = ({
  content,
  fileCount,
}: LimitExtractedTextPromptContentOptions): string => {
  if (fileCount < 1) {
    panic("Extracted-text prompt file count must be positive");
  }
  const fairShare = Math.floor(
    EXTRACTED_TEXT_PROMPT_LIMITS.totalChars / fileCount,
  );
  const maxChars = Math.min(
    EXTRACTED_TEXT_PROMPT_LIMITS.perFileChars,
    fairShare,
  );
  if (content.length <= maxChars) {
    return content;
  }
  if (maxChars <= EXTRACTED_TEXT_TRUNCATION_MARKER.length) {
    return EXTRACTED_TEXT_TRUNCATION_MARKER.slice(0, maxChars);
  }
  return `${content.slice(0, maxChars - EXTRACTED_TEXT_TRUNCATION_MARKER.length)}${EXTRACTED_TEXT_TRUNCATION_MARKER}`;
};

export const buildWorkflowAIAnalyticsProps = ({
  entityVersionId,
  organizationId,
  orgAIConfig,
  propertyCount,
  usageMetering,
  workspaceId,
}: BuildWorkflowAIAnalyticsPropsInput): WorkflowAIAnalyticsProps => ({
  feature: "workflow.generate-batch",
  modelRole: "pdf",
  orgAIConfig,
  properties: {
    entity_version_id: entityVersionId,
    organization_id: organizationId,
    property_count: propertyCount,
    workspace_id: workspaceId,
  },
  sessionId: entityVersionId,
  traceId: Bun.randomUUIDv7(),
  ...(usageMetering ? { usageMetering } : {}),
});

const SYSTEM_ONE_ERROR_SOURCE = "workflow.generate-batch.system-one";

type SystemOnePhaseOptions = {
  decisionModel: DecisionModel | null | undefined;
  usageMetering: AIUsageMetering | undefined;
  orgAIConfig: OrgAIConfig | null | undefined;
  properties: AIBatchProperty[];
  files: PreparedInputFile[];
  textInputs: TextInput[];
  abortSignal: AbortSignal;
  onPartialAnswer:
    | ((update: PartialAnswerUpdate) => Promise<void> | void)
    | undefined;
};

type SystemOnePhaseResult = {
  output: WorkflowDataOutput;
  /** What the generative model still owes, in batch order. */
  generative: AIBatchProperty[];
};

/**
 * The decision model answers the closed-answer properties of one batch.
 * Anything it does not settle — a text property, a question the plan could not
 * ask, an undecided answer, a deployment with no decision model at all — is
 * left to the generative model, so this phase can only add answers, never lose
 * a property.
 */
const askSystemOne = async ({
  decisionModel,
  usageMetering,
  orgAIConfig,
  properties,
  files,
  textInputs,
  abortSignal,
  onPartialAnswer,
}: SystemOnePhaseOptions): Promise<SystemOnePhaseResult> => {
  const fallbackAll: SystemOnePhaseResult = {
    output: {},
    generative: properties,
  };
  const { systemOne } = splitPropertiesForSystemOne(properties);
  if (systemOne.length === 0) {
    return fallbackAll;
  }

  const prepared = await Result.tryPromise({
    try: async () => await sourcesFromPreparedFiles(files, textInputs),
    catch: (cause) =>
      new WorkflowIntegrationError({
        message: "Workflow System One source preparation failed",
        cause,
      }),
  });
  if (Result.isError(prepared)) {
    captureError(prepared.error, { source: SYSTEM_ONE_ERROR_SOURCE });
    return fallbackAll;
  }
  const { sources, locators } = prepared.value;
  if (sources.length === 0) {
    return fallbackAll;
  }

  const questions = questionsFromProperties(systemOne);
  const plan = planSystemOneAnswers({
    document: systemOneDocumentHeader(files),
    sources,
    language: SYSTEM_ONE_BATCH_LANGUAGE,
    questions,
  });
  if (Object.keys(plan.questions).length === 0) {
    return fallbackAll;
  }

  const { decisions } = await decideMany({
    id: "workflow.table-batch",
    orgAIConfig,
    state: plan.state,
    questions: plan.questions,
    abortSignal,
    // One call reads the whole batch; the caller's signal still bounds it.
    timeoutMs: 60_000,
    client: decisionModel,
    usageMetering: usageMetering
      ? { ...usageMetering, callId: Bun.randomUUIDv7() }
      : undefined,
  });
  const outcomes = decodeSystemOneAnswers({ plan, questions, decisions });
  const { output } = outputFromSystemOneOutcomes({
    properties: systemOne,
    outcomes,
    locators,
  });

  if (onPartialAnswer) {
    for (const property of systemOne) {
      const entry = output[property.id];
      const answer =
        entry === undefined ? null : formatPartialAnswer(entry.answer);
      if (answer === null) {
        continue;
      }
      await onPartialAnswer({ propertyId: property.id, answer });
    }
  }

  return {
    output,
    generative: properties.filter(
      (property) => output[property.id] === undefined,
    ),
  };
};

export const generateWorkflowData = async ({
  files,
  properties,
  filenames,
  textInputs,
  abortSignal,
  entityVersionId,
  organizationId,
  workspaceId,
  orgAIConfig,
  promptCachingEnabled,
  serviceTier,
  usageMetering,
  onPartialAnswer,
  decisionModel,
}: GenerateWorkflowDataProps): Promise<
  Result<WorkflowDataOutput, WorkflowIntegrationError>
> => {
  // Always asked: without a decision model every question comes back
  // undecided and every property falls back, which is the generative path.
  const { output: systemOneOutput, generative: generativeProperties } =
    await askSystemOne({
      decisionModel,
      usageMetering,
      orgAIConfig,
      properties,
      files,
      textInputs,
      abortSignal,
      onPartialAnswer,
    });
  // Only a batch System One answered in full ends here; an empty batch takes
  // the generative path it has always taken.
  if (properties.length > 0 && generativeProperties.length === 0) {
    return Result.ok(systemOneOutput);
  }

  // Resolved up front because the schema budget is a property of the provider,
  // not of the batch: the planner groups properties by dependency signature
  // and cannot know how many of them one request may carry.
  const model = Result.try({
    try: () =>
      resolveTanStackTextModel({ role: "pdf", orgAIConfig, organizationId }),
    catch: (error) =>
      new WorkflowIntegrationError({
        message: "Workflow AI model resolution failed",
        cause: error,
      }),
  });
  if (Result.isError(model)) {
    return Result.err(model.error);
  }
  const { provider, modelId } = model.value;

  const chunks = splitPropertiesForBudget({
    provider,
    modelId,
    properties: generativeProperties,
    buildSchema: (chunkProperties) =>
      structuredOutputWireJsonSchema({
        outputSchema: buildBatchSchema(chunkProperties, filenames),
        provider,
      }),
  });
  if (Result.isError(chunks)) {
    return Result.err(
      new WorkflowIntegrationError({
        message:
          "A single workflow property does not fit the provider's structured-output budget",
        cause: chunks.error,
      }),
    );
  }

  const cachingDecision = resolveCaching({
    promptCachingEnabled,
    role: "pdf",
    scopeKey: entityVersionId,
  });

  type WorkflowMessagePart =
    | DocumentPart<AnthropicDocumentMetadata>
    | TextPart<AnthropicTextMetadata>;

  const messageContent: WorkflowMessagePart[] = [];
  const extractedTextFileCount = files.filter(
    (file) => file.kind === "extracted-text",
  ).length;

  for (const file of files) {
    if (file.kind === "pdf") {
      messageContent.push({
        type: "document",
        source: {
          type: "data",
          value: Buffer.from(file.content).toString("base64"),
          mimeType: file.mimeType,
        },
      });
      continue;
    }
    if (file.kind === "extracted-text") {
      messageContent.push({
        type: "text",
        content: buildExtractedFileMessage({
          content: sanitizeForPrompt(
            untrustedText(
              limitExtractedTextPromptContent({
                content: file.content,
                fileCount: extractedTextFileCount,
              }),
            ),
          ),
          simplifiedName: file.simplifiedName,
        }),
      });
      continue;
    }
    // DOCX: serialise folio blocks inline. The model cites block ids back in
    // `justification.citations` instead of bates stamps.
    messageContent.push({
      type: "text",
      content: buildDocxBlocksMessage({
        simplifiedName: file.simplifiedName,
        blocks: file.blocks,
      }),
    });
  }

  if (textInputs.length > 0) {
    messageContent.push({
      type: "text",
      content: buildTextInputsMessage(textInputs),
    });
  }

  const lastStaticIdx = messageContent.length - 1;
  if (lastStaticIdx >= 0) {
    const lastStatic = messageContent[lastStaticIdx];
    if (lastStatic) {
      messageContent[lastStaticIdx] = markTanStackCacheBreakpoint(lastStatic, {
        decision: cachingDecision,
      });
    }
  }

  // Every chunk sends the same `messageContent` prefix, so the cache
  // breakpoint above is warmed once and reused; only the prompt list and the
  // output schema narrow to the chunk.
  const runChunk = async (
    chunkProperties: AIBatchProperty[],
  ): Promise<Result<WorkflowDataOutput, WorkflowIntegrationError>> => {
    const aiAnalytics = createTanStackAIAnalyticsCallbacks(
      buildWorkflowAIAnalyticsProps({
        entityVersionId,
        organizationId,
        orgAIConfig: orgAIConfig ?? null,
        propertyCount: chunkProperties.length,
        usageMetering,
        workspaceId,
      }),
    );

    const chunkContent: WorkflowMessagePart[] = [
      ...messageContent,
      { type: "text", content: buildPromptsMessage(chunkProperties) },
    ];

    // Each chunk is one model request, so it gets the per-request budget;
    // before the batch was split, the caller applied that same budget once
    // because a batch *was* one request. The caller's signal (the worker's
    // per-job timeout) still bounds the batch as a whole, so a stalled chunk
    // fails on its own instead of consuming what the remaining chunks need.
    const chunkAbortSignal = AbortSignal.any([
      abortSignal,
      AbortSignal.timeout(getWorkflowBatchAITimeoutMs(serviceTier)),
    ]);

    return await Result.tryPromise({
      try: async () => {
        const stream = streamTanStackObjectForRole({
          role: "pdf",
          orgAIConfig,
          organizationId,
          tenantWorkspaceIds: [workspaceId],
          analytics: aiAnalytics,
          caching: cachingDecision,
          serviceTier,
          messages: [{ role: "user", content: chunkContent }],
          system: WORKFLOW_SYSTEM_PROMPT,
          abortSignal: chunkAbortSignal,
          outputSchema: buildBatchSchema(chunkProperties, filenames),
        });

        let rawJson = "";
        let output: WorkflowDataOutput | undefined;
        const propertyIds = chunkProperties.map((property) => property.id);

        for await (const event of stream) {
          if (event.type === "complete") {
            output = event.object;
            continue;
          }

          if (!onPartialAnswer) {
            continue;
          }

          if (event.type === "partial") {
            await consumePartialAnswers({
              partialOutputs: [event.partial],
              propertyIds,
              onPartialAnswer,
            });
            continue;
          }

          rawJson += event.delta;
          await consumeTanStackPartialAnswer({
            rawJson,
            propertyIds,
            onPartialAnswer,
          });
        }

        if (output === undefined) {
          throw new WorkflowIntegrationError({
            message: "Workflow AI generation did not return structured output",
          });
        }

        return output;
      },
      catch: (error) => {
        aiAnalytics.captureError(error);

        return new WorkflowIntegrationError({
          message: "Workflow AI generation failed",
          cause: error,
        });
      },
    });
  };

  // Recursion rather than a loop because the chunks must run strictly in
  // order, and only one at a time: the first chunk writes the shared prompt
  // prefix into the provider's cache and the rest read it, so overlapping
  // them would pay for that prefix once per chunk. Answers from earlier
  // chunks accumulate into `merged`; the first failure ends the batch.
  const chunkBatches = chunks.value;
  const runFromChunk = async (
    index: number,
    merged: WorkflowDataOutput,
  ): Promise<Result<WorkflowDataOutput, WorkflowIntegrationError>> => {
    const chunkProperties = chunkBatches.at(index);
    if (chunkProperties === undefined) {
      return Result.ok(merged);
    }

    const chunkOutput = await runChunk(chunkProperties);
    if (Result.isError(chunkOutput)) {
      return chunkOutput;
    }
    Object.assign(merged, chunkOutput.value);
    return await runFromChunk(index + 1, merged);
  };

  // Chunk answers accumulate onto the System One answers; the two sets of
  // property ids are disjoint, so neither overwrites the other.
  return await runFromChunk(0, systemOneOutput);
};
