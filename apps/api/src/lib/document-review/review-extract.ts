import { panic, Result } from "better-result";

import type { JustificationContent } from "@/api/db/schema";
import type {
  AiExtractablePropertyContent,
  FieldContent,
} from "@/api/db/schema-validators";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import type { ReviewWithheldSource } from "@/api/lib/document-review/contract";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import type { DocumentTooLargeError } from "@/api/lib/errors/tagged-errors";
import { createDefaultTool } from "@/api/lib/properties/create-schema";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { brandDerivedPropertyId } from "@/api/lib/safe-id-boundaries";
import type { AnswerShape } from "@/api/lib/workflow/ai-answer-schema";
import {
  generateWorkflowData,
  propertyOutput,
} from "@/api/lib/workflow/ai-generate-batch";
import {
  fieldContentFromValidated,
  validateAIOutput,
} from "@/api/lib/workflow/ai-validators";
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
// call, justification parsing) but returns the answers + verified citations in
// memory — no `fields`/`justifications` rows are written. Citations retain the
// source field id so callers can resolve the cited document before rendering a
// source link.

// A folio block citation's navigable payload. This shape remains compatible
// with the persisted review finding contract; `ReviewDocxFolioCitation` adds
// the source ownership needed by non-persisting extraction callers.
export type DocxFolioCitation = {
  blockId: string;
  text: string;
};

export type ReviewDocxFolioCitation = DocxFolioCitation & {
  kind: "docx-folio";
  fileFieldId: SafeId<"field">;
  statement: string;
};

// Bates citations are already validated by `normalizeJustification`, which
// checks the file-specific Bates prefix and positive page number. Keep that
// trusted locator together with its owning field for source resolution.
export type PdfBatesCitation = {
  kind: "pdf-bates";
  fileFieldId: SafeId<"field">;
  bates: string;
  pageNumber: number;
  statement: string;
};

export type ReviewCitation = PdfBatesCitation | ReviewDocxFolioCitation;

export type AskExtraction = {
  content: FieldContent;
  citations: ReviewCitation[];
};

/**
 * What extraction settled for one ask. A failure is not one of these: it fails
 * the whole extraction, so no caller can grade a position whose extraction
 * broke as if the document were silent on it.
 */
export type AskOutcome =
  | ({ type: "answered" } & AskExtraction)
  /** The model read the document and found no value. */
  | { type: "not-stated" }
  /** The model declined; this says nothing about the document. */
  | { type: "refused" };

// One eligible ASK prompt: a position whose `ask.question` is non-empty and
// whose `ask.content` the model can produce a value for (a file column holds
// the document, not an extracted value; see AiExtractablePropertyContent).
// Narrowed to the content types `buildBatchSchema` handles.
export type ReviewAsk = {
  sourceId: string;
  question: string;
  content: AiExtractablePropertyContent;
  answerShape: AnswerShape;
};

export type ReviewExtractionResult = {
  // One outcome for every ask, keyed by the originating position sourceId.
  outcomeBySourceId: ReadonlyMap<string, AskOutcome>;
  // Last folio block id of the active DOCX, used as the insert anchor when a
  // FIX has no clause citation to replace. Null when no DOCX block exists.
  lastBlockId: string | null;
  // Sources cut to fit the request, empty when all were read whole.
  withheld: readonly ReviewWithheldSource[];
};

export type ExtractAskContentsArgs = {
  asks: ReviewAsk[];
  resolvedFiles: ResolvedFile[];
  abortSignal: AbortSignal;
  organizationId: SafeId<"organization">;
  admission: ModelDispatchAdmission;
  workspaceId: SafeId<"workspace">;
  entityVersionId: SafeId<"entityVersion">;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
  usageMetering?: AIUsageMetering | undefined;
  /** External file and model boundaries; supplied by focused tests. */
  fetchAndPrepareFiles?: typeof fetchAndPrepareFiles | undefined;
  generateWorkflowData?: typeof generateWorkflowData | undefined;
};

const EMPTY_RESULT: ReviewExtractionResult = {
  outcomeBySourceId: new Map(),
  lastBlockId: null,
  withheld: [],
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

export const collectReviewCitations = (
  content: JustificationContent | null,
): ReviewCitation[] => {
  if (!content) {
    return [];
  }
  const seen = new Set<string>();
  const citations: ReviewCitation[] = [];
  for (const block of content.blocks) {
    switch (block.kind) {
      case "pdf-bates":
        for (const statement of block.statements) {
          for (const cite of statement.citations) {
            citations.push({
              kind: "pdf-bates",
              fileFieldId: block.fileFieldId,
              bates: cite.bates,
              pageNumber: cite.pageNumber,
              statement: statement.text,
            });
          }
        }
        break;
      case "docx-folio":
        for (const statement of block.statements) {
          for (const cite of statement.citations) {
            // Only verified citations carry a navigable block id; unverified
            // hints have no anchor for scroll or one-click fix.
            if (cite.citationStatus === "unverified") {
              continue;
            }
            const citationKey = `${block.fileFieldId}:${cite.blockId}:${statement.text}`;
            if (seen.has(citationKey)) {
              continue;
            }
            seen.add(citationKey);
            citations.push({
              kind: "docx-folio",
              fileFieldId: block.fileFieldId,
              blockId: cite.blockId,
              text: cite.text,
              statement: statement.text,
            });
          }
        }
        break;
      // A document review cites the file under review; a decision passage is
      // cited by the case-law research runner, which never writes here.
      case "playbook-verdict":
      case "decision-passage":
        break;
      default:
        block satisfies never;
        panic(`Unhandled block: ${String(block)}`);
    }
  }
  return citations;
};

export const keepNavigableReviewCitations = (
  citations: readonly ReviewCitation[],
  preparedFiles: readonly PreparedInputFile[],
): ReviewCitation[] => {
  const pdfPageCounts = new Map(
    preparedFiles.flatMap((file) =>
      file.kind === "pdf" ? [[file.fileFieldId, file.pageCount] as const] : [],
    ),
  );
  return citations.filter((citation) => {
    if (citation.kind !== "pdf-bates") {
      return true;
    }
    const pageCount = pdfPageCounts.get(citation.fileFieldId);
    return pageCount !== undefined && citation.pageNumber <= pageCount;
  });
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
  admission,
  workspaceId,
  entityVersionId,
  orgAIConfig,
  managedAIResidency,
  promptCachingEnabled,
  serviceTier,
  usageMetering,
  fetchAndPrepareFiles: prepareFiles = fetchAndPrepareFiles,
  generateWorkflowData: generate = generateWorkflowData,
}: ExtractAskContentsArgs): Promise<
  Result<
    ReviewExtractionResult,
    WorkflowIntegrationError | DocumentTooLargeError
  >
> =>
  await Result.gen(async function* () {
    if (asks.length === 0) {
      return Result.ok(EMPTY_RESULT);
    }
    // Asks with nothing the model can read have no answer to give. An empty
    // result here would grade every one of them as a missing clause.
    const supportedFiles = resolvedFiles.filter(isAISupportedFile);
    if (supportedFiles.length === 0) {
      return Result.err(
        new WorkflowIntegrationError({
          message: "No review input file can be read by the model",
        }),
      );
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
          await prepareFiles(reviewFiles, organizationId, workspaceId),
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
    const asked: { sourceId: string; property: AIBatchProperty }[] = [];
    for (const ask of asks) {
      // Derived from the ask, not minted per call: the ids name the output
      // schema and the prompts message, both of which sit in the model
      // request, so a fresh id per run would make two extractions of the
      // same document look different to the prompt cache.
      const property: AIBatchProperty = {
        id: brandDerivedPropertyId(ask.sourceId),
        status: "stale",
        content: ask.content,
        answerShape: ask.answerShape,
        dependencies: [],
        tool: buildAiTool(ask.question),
      };
      properties.push(property);
      asked.push({ sourceId: ask.sourceId, property });
    }

    const generation = yield* Result.await(
      generate({
        files: preparedFiles,
        properties,
        filenames,
        textInputs: [],
        linkedSkillsMessage: null,
        abortSignal,
        organizationId,
        admission,
        workspaceId,
        entityVersionId,
        orgAIConfig,
        managedAIResidency,
        promptCachingEnabled,
        serviceTier,
        usageMetering,
      }),
    );

    const outcomeBySourceId = new Map<string, AskOutcome>();
    for (const { sourceId, property } of asked) {
      const output = propertyOutput(generation, property);
      switch (output.type) {
        case "returned":
          break;
        case "refused":
          outcomeBySourceId.set(sourceId, { type: "refused" });
          continue;
        case "not-asked":
          outcomeBySourceId.set(sourceId, { type: "not-stated" });
          continue;
        // An answer the request owed but never returned is a failure, not a
        // document that is silent on the question.
        case "omitted":
          return Result.err(
            new WorkflowIntegrationError({
              message: "Review extraction returned no answer for an ask",
              cause: { sourceId },
            }),
          );
        default:
          output satisfies never;
          return panic("Unhandled review extraction output");
      }
      const propertyResult = output.result;

      const validated = validateAIOutput({
        aiResult: propertyResult,
        property,
      });
      // A schema/extraction failure must not be dropped: silently skipping it
      // lets buildFindings grade the position as if the document had no answer,
      // producing false "missing"/"deviation" findings. Surface it instead.
      if (Result.isError(validated)) {
        return Result.err(
          new WorkflowIntegrationError({
            message: "Failed to validate review extraction output",
            cause: validated.error,
          }),
        );
      }

      const content = fieldContentFromValidated(validated.value);
      if (content === null) {
        // The model reported no value for this text/int ASK: the document
        // does not state it, which grading reads as absent rather than as a
        // fabricated answer.
        outcomeBySourceId.set(sourceId, { type: "not-stated" });
        continue;
      }

      const justification = normalizeJustification({
        justification: propertyResult.justification,
        filenames,
      });
      const citations = Result.isOk(justification)
        ? keepNavigableReviewCitations(
            collectReviewCitations(justification.value?.content ?? null),
            preparedFiles,
          )
        : [];

      outcomeBySourceId.set(sourceId, { type: "answered", content, citations });
    }

    return Result.ok({
      outcomeBySourceId,
      lastBlockId,
      withheld: generation.fit.type === "cut" ? generation.fit.withheld : [],
    });
  });
