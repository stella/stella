import type { PipelineConfig } from "@stll/anonymize-wasm";

import { useInspectorStore } from "@/components/inspector/inspector-store";
import {
  createPipelineRunRegistry,
  type PipelineRun,
} from "@/components/inspector/pipeline-run-registry.logic";
import { PDF_MIME_TYPE } from "@/consts";
import { DEFAULT_ENTITY_LABELS } from "@/lib/anonymize/constants";
import { extractPDFText } from "@/lib/anonymize/pdf-coords";
import { createPipelineContextRunner } from "@/lib/anonymize/pipeline-context";
import { api } from "@/lib/api";
import { ClientOperationError } from "@/lib/errors/client";
import {
  allocateEntityOverlayId,
  clearAnonymizationForField,
  commitAnonymizationForField,
} from "@/lib/pdf/anonymization-cache";
import { buildPerPage, getEntitySpans } from "@/lib/pdf/anonymization-helpers";
import type {
  EntityOverlay,
  FileAnonymization,
} from "@/lib/pdf/anonymization-types";

const buildPipelineConfig = (
  workspaceId: string,
  labels: readonly string[],
): PipelineConfig => {
  const config: PipelineConfig = {
    threshold: 0.4,
    enableTriggerPhrases: true,
    enableRegex: true,
    enableNameCorpus: true,
    enableDenyList: false,
    enableGazetteer: false,
    enableNer: false,
    enableConfidenceBoost: false,
    enableCoreference: true,
    enableLegalForms: true,
    labels: [...labels],
    workspaceId,
  };
  return config;
};

const pipelineRuns = createPipelineRunRegistry();
let dictionariesPromise: Promise<
  NonNullable<PipelineConfig["dictionaries"]>
> | null = null;
const runWithPipelineContext = createPipelineContextRunner();

export const anonymizePdf = async ({
  workspaceId,
  fieldId,
  mimeType,
}: {
  workspaceId: string;
  fieldId: string;
  mimeType: string | null;
}): Promise<void> => {
  const run = pipelineRuns.start(fieldId);
  const isPdf = mimeType === PDF_MIME_TYPE;
  // Tell the inspector facet a producer is in flight so
  // it shows "Detecting entities…" while the wasm pipeline
  // runs. Mirrored on every terminal exit below.
  useInspectorStore.getState().markAnonymizationPipelineStarted(fieldId);
  try {
    await runPipelineAndCommit({ workspaceId, fieldId, isPdf, run });
  } finally {
    // Release the in-flight lock unconditionally — even
    // when cancelled or when an awaited step rejected
    // before the explicit cancellation check inside
    // `runPipelineAndCommit`. Without this, a cancel +
    // error race would leave `pipelineStartedFieldIds`
    // permanently holding this field, and reopening the
    // same document would keep the inspector facet stuck
    // on the "Detecting…" placeholder.
    if (pipelineRuns.finish(fieldId, run)) {
      useInspectorStore.getState().markAnonymizationPipelineRan(fieldId);
    }
  }
};

const runPipelineAndCommit = async ({
  workspaceId,
  fieldId,
  isPdf,
  run,
}: {
  workspaceId: string;
  fieldId: string;
  isPdf: boolean;
  run: PipelineRun;
}): Promise<void> => {
  const response = await api
    .files({ workspaceId })
    .url({ fieldId })
    .get({
      query: { purpose: isPdf ? "download" : "display" },
    });

  if (response.error) {
    throw new ClientOperationError({
      action: "anonymizePdf",
      message: "Failed to get file URL",
      cause: response.error,
    });
  }

  const s3Response = await fetch(response.data.presignedUrl, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!s3Response.ok) {
    throw new ClientOperationError({
      action: "anonymizePdf",
      message: "Failed to fetch file from storage",
    });
  }

  const buffer = await s3Response.arrayBuffer();
  const pdfBytes = new Uint8Array(buffer);

  const { PDF } = await import("@libpdf/core");
  const pdf = await PDF.load(pdfBytes);
  const { text, spans: charSpans } = extractPDFText(pdf);

  const [{ loadNameDictionaries }, wasm] = await Promise.all([
    import("@stll/anonymize-data"),
    import("@stll/anonymize-wasm"),
  ]);
  dictionariesPromise ??= loadNameDictionaries();
  const dictionaries = await dictionariesPromise;
  // Detection-only: this overlay only needs the entity spans, so the
  // combined `redaction` half of the single detect+redact call is
  // discarded.
  const entities = await runWithPipelineContext(async () => {
    const context = wasm.createPipelineContext();
    const config = {
      ...buildPipelineConfig(workspaceId, DEFAULT_ENTITY_LABELS),
      dictionaries,
    };
    const binding = await wasm.getBinding();
    const pipeline = await wasm.createNativePipelineFromConfig({
      binding,
      config,
      gazetteerEntries: [],
      context,
    });
    return pipeline.redactText(text).resolvedEntities;
  });

  const overlayEntities: EntityOverlay[] = [];

  for (const entity of entities) {
    const spans = getEntitySpans({
      charSpans,
      entityStart: entity.start,
      entityEnd: entity.end,
    });
    if (spans.length === 0) {
      continue;
    }
    overlayEntities.push({
      id: allocateEntityOverlayId(),
      label: entity.label,
      text: entity.text,
      spans,
    });
  }

  if (!pipelineRuns.canCommit(fieldId, run)) {
    return;
  }

  const perPage = buildPerPage(overlayEntities);

  const data: FileAnonymization = {
    entities: overlayEntities,
    perPage,
    extractedText: text,
    charSpans,
  };

  commitAnonymizationForField(fieldId, data);
  // Mirror the detection result into the inspector
  // matches store. The DOCX path publishes via Folio's
  // plugin on every transaction; the PDF path runs
  // once-per-document, so we publish here for the
  // count badge. The "started/ran" lifecycle bookkeeping
  // lives in the wrapping `anonymizePdf` so the facet
  // exits the "Detecting…" state on errors too.
  const countByCanonical = new Map<string, number>();
  const labelByCanonical = new Map<string, string>();
  let totalMatches = 0;
  for (const overlay of overlayEntities) {
    const canonical = overlay.text;
    countByCanonical.set(canonical, (countByCanonical.get(canonical) ?? 0) + 1);
    if (!labelByCanonical.has(canonical)) {
      labelByCanonical.set(canonical, overlay.label);
    }
    totalMatches += 1;
  }
  useInspectorStore.getState().publishAnonymizationMatches(fieldId, {
    totalMatches,
    countByCanonical,
    labelByCanonical,
  });
};

export const clearAnonymization = (fieldId: string): void => {
  pipelineRuns.cancel(fieldId);
  clearAnonymizationForField(fieldId);
  // Also drop the matches-store entry for this field so
  // the inspector facet stops showing a stale count when
  // the user navigates away mid-detection. Idempotent for
  // fields that were never published.
  useInspectorStore.getState().clearAnonymizationMatches(fieldId);
};
