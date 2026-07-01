import { panic, Result } from "better-result";

import type { JustificationContent } from "@/api/db/schema";
import type { FieldContent, PropertyContent } from "@/api/db/schema-validators";
import { createDefaultTool } from "@/api/handlers/properties/create-schema";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-models";
import type { AIUsageMetering } from "@/api/lib/analytics/ai";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { generateWorkflowData } from "@/api/lib/workflow/ai-generate-batch";
import { validateAIOutput } from "@/api/lib/workflow/ai-validators";
import type { ValidatedResult } from "@/api/lib/workflow/ai-validators";
import {
  buildJustificationFilenames,
  fetchAndPrepareFiles,
  isAISupportedFile,
} from "@/api/lib/workflow/generate-batch";
import type { PreparedInputFile } from "@/api/lib/workflow/generate-batch";
import type { ResolvedFile } from "@/api/lib/workflow/generate-batch-shared";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import { normalizeJustification } from "@/api/lib/workflow/parse-justifications";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

// Non-persisting ASK extraction for the single-doc playbook review. It runs the
// SAME AI extraction the batch workflow uses (file prep, batch schema, model
// call, justification parsing) but returns the answers + docx-folio citations in
// memory — no `fields`/`justifications` rows are written. Citations carry folio
// block ids (`deriveBlockId`: a `w14:paraId` verbatim, or a `seq-NNNN`
// fallback) so the frontend can scroll/highlight the cited paragraph.

// A folio block citation: the cited paragraph's block id plus its literal text
// (captured at extraction time so the client renders the quote with no
// re-parse). Mirrors `DocxFolioJustificationBlock` statement citations.
export type DocxFolioCitation = {
  blockId: string;
  text: string;
};

export type AskExtraction = {
  content: FieldContent;
  citations: DocxFolioCitation[];
};

// One eligible ASK prompt: a position whose `ask.question` is non-empty and
// whose `ask.content` is not a file column (file columns hold the document, not
// an extracted value). Narrowed to the AI content types `buildBatchSchema`
// handles.
export type ReviewAsk = {
  sourceId: string;
  question: string;
  content: Exclude<PropertyContent, { type: "file" }>;
};

export type ReviewExtractionResult = {
  // Extracted ASK value + citations keyed by the originating position sourceId.
  contentBySourceId: Map<string, AskExtraction>;
  // Last folio block id of the active DOCX, used as the insert anchor when a
  // FIX has no clause citation to replace. Null when no DOCX block exists.
  lastBlockId: string | null;
};

export type ExtractAskContentsArgs = {
  asks: ReviewAsk[];
  resolvedFiles: ResolvedFile[];
  abortSignal: AbortSignal;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityVersionId: SafeId<"entityVersion">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
  usageMetering?: AIUsageMetering | undefined;
};

const EMPTY_RESULT: ReviewExtractionResult = {
  contentBySourceId: new Map(),
  lastBlockId: null,
};

// Reuse the canonical AI-model tool builder, then narrow to `AIModelTool`. The
// eligible asks all carry a non-empty question, so the builder always returns
// the ai-model variant.
const buildAiTool = (question: string): AIBatchProperty["tool"] => {
  const tool = createDefaultTool({
    dependencies: [],
    prompt: question,
    toolType: "ai-model",
  });
  if (tool.type !== "ai-model") {
    return panic("createDefaultTool returned a non ai-model tool for an ASK");
  }
  return tool;
};

const validatedToFieldContent = (validated: ValidatedResult): FieldContent => {
  switch (validated.type) {
    case "text":
      return { version: 1, type: "text", value: validated.value };
    case "single-select":
      return { version: 1, type: "single-select", value: validated.value };
    case "multi-select":
      return { version: 1, type: "multi-select", value: validated.value };
    case "date":
      return { version: 1, type: "date", value: validated.value };
    case "int":
      return {
        version: 1,
        type: "int",
        value: validated.value,
        currency: validated.currency,
      };
    default: {
      const exhaustive: never = validated;
      void exhaustive;
      return panic("Unexpected validated ASK content type");
    }
  }
};

const collectDocxCitations = (
  content: JustificationContent | null,
): DocxFolioCitation[] => {
  if (!content) {
    return [];
  }
  const seen = new Set<string>();
  const citations: DocxFolioCitation[] = [];
  for (const block of content.blocks) {
    if (block.kind !== "docx-folio") {
      continue;
    }
    for (const statement of block.statements) {
      for (const cite of statement.citations) {
        if (seen.has(cite.blockId)) {
          continue;
        }
        seen.add(cite.blockId);
        citations.push({ blockId: cite.blockId, text: cite.text });
      }
    }
  }
  return citations;
};

const lastDocxBlockId = (files: PreparedInputFile[]): string | null => {
  for (const file of files) {
    if (file.kind === "docx") {
      const last = file.blocks.at(-1);
      if (last) {
        return last.id;
      }
    }
  }
  return null;
};

export const extractAskContents = async ({
  asks,
  resolvedFiles,
  abortSignal,
  organizationId,
  workspaceId,
  entityVersionId,
  orgAIConfig,
  promptCachingEnabled,
  serviceTier,
  usageMetering,
}: ExtractAskContentsArgs): Promise<
  Result<ReviewExtractionResult, WorkflowIntegrationError>
> =>
  await Result.gen(async function* () {
    const supportedFiles = resolvedFiles.filter(isAISupportedFile);
    if (asks.length === 0 || supportedFiles.length === 0) {
      return Result.ok(EMPTY_RESULT);
    }

    // Force DOCX block preparation: the files-table batch prefers a converted
    // DOCX's PDF derivative (bates citations), but single-document review targets
    // docx-folio block ids for scroll + one-click fix anchors, so a converted
    // DOCX must still be parsed to blocks. Nulling pdfFileId selects the DOCX
    // path in fetchAndPrepareFiles.
    const reviewFiles: ResolvedFile[] = [];
    for (const file of supportedFiles) {
      reviewFiles.push(
        file.mimeType === DOCX_MIME_TYPE ? { ...file, pdfFileId: null } : file,
      );
    }

    const preparedFiles = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await fetchAndPrepareFiles(reviewFiles, organizationId, workspaceId),
        catch: (cause) =>
          new WorkflowIntegrationError({
            message: "Failed to prepare review input files",
            cause,
          }),
      }),
    );

    const filenames = buildJustificationFilenames(preparedFiles);
    const lastBlockId = lastDocxBlockId(preparedFiles);

    const properties: AIBatchProperty[] = [];
    const sourceIdByPropertyId = new Map<string, string>();
    for (const ask of asks) {
      const propertyId = createSafeId<"property">();
      sourceIdByPropertyId.set(propertyId, ask.sourceId);
      properties.push({
        id: propertyId,
        status: "stale",
        content: ask.content,
        dependencies: [],
        tool: buildAiTool(ask.question),
      });
    }

    const output = yield* Result.await(
      generateWorkflowData({
        files: preparedFiles,
        properties,
        filenames,
        textInputs: [],
        abortSignal,
        organizationId,
        workspaceId,
        entityVersionId,
        orgAIConfig,
        promptCachingEnabled,
        serviceTier,
        usageMetering,
      }),
    );

    const contentBySourceId = new Map<string, AskExtraction>();
    for (const property of properties) {
      const sourceId = sourceIdByPropertyId.get(property.id);
      const propertyResult = output[property.id];
      if (sourceId === undefined || !propertyResult) {
        continue;
      }

      const validated = validateAIOutput({
        aiResult: propertyResult,
        property,
      });
      if (Result.isError(validated)) {
        continue;
      }

      const justification = normalizeJustification({
        justification: propertyResult.justification,
        filenames,
      });
      const citations = Result.isOk(justification)
        ? collectDocxCitations(justification.value?.content ?? null)
        : [];

      contentBySourceId.set(sourceId, {
        content: validatedToFieldContent(validated.value),
        citations,
      });
    }

    return Result.ok({ contentBySourceId, lastBlockId });
  });
