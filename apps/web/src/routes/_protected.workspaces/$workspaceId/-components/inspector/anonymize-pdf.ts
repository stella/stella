import { DEFAULT_ENTITY_LABELS, runPipeline } from "@stll/anonymize-wasm";
import type { PipelineConfig } from "@stll/anonymize-wasm";

import { PDF_MIME_TYPE } from "@/consts";
import type { CharSpan } from "@/lib/anonymize/pdf-coords";
import { extractPDFText } from "@/lib/anonymize/pdf-coords";
import { api } from "@/lib/api";
import { ClientOperationError } from "@/lib/errors";
import {
  allocateEntityOverlayId,
  clearAnonymizationForField,
  commitAnonymizationForField,
} from "@/lib/pdf/anonymization-cache";
import { buildPerPage, getEntitySpans } from "@/lib/pdf/anonymization-helpers";
import type {
  EntityOverlay,
  EntitySpan,
  FileAnonymization,
} from "@/lib/pdf/anonymization-types";

export type { EntitySpan, EntityOverlay, FileAnonymization };

const buildPipelineConfig = (workspaceId: string): PipelineConfig => ({
  threshold: 0.4,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableNameCorpus: true,
  enableDenyList: false,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId,
});

const cancelledFieldIds = new Set<string>();

export const anonymizePdf = async ({
  workspaceId,
  fieldId,
  mimeType,
}: {
  workspaceId: string;
  fieldId: string;
  mimeType: string | null;
}): Promise<void> => {
  cancelledFieldIds.delete(fieldId);
  const isPdf = mimeType === PDF_MIME_TYPE;

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

  const s3Response = await fetch(response.data.presignedUrl);
  if (!s3Response.ok) {
    throw new ClientOperationError({
      action: "anonymizePdf",
      message: "Failed to fetch file from storage",
    });
  }

  const buffer = await s3Response.arrayBuffer();
  const pdfBytes = new Uint8Array(buffer);

  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");
  if (!GlobalWorkerOptions.workerSrc) {
    GlobalWorkerOptions.workerSrc = (
      await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
    ).default;
  }

  const pdf = await getDocument({
    data: pdfBytes.slice(),
  }).promise;
  let text: string;
  let charSpans: CharSpan[];
  try {
    const result = await extractPDFText(pdf);
    text = result.text;
    charSpans = result.spans;
  } finally {
    await pdf.destroy();
  }

  const entities = await runPipeline({
    fullText: text,
    config: buildPipelineConfig(workspaceId),
    gazetteerEntries: [],
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

  if (cancelledFieldIds.has(fieldId)) {
    cancelledFieldIds.delete(fieldId);
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
};

export const clearAnonymization = (fieldId: string): void => {
  cancelledFieldIds.add(fieldId);
  clearAnonymizationForField(fieldId);
};
