import type { PipelineConfig } from "@stll/anonymize-wasm";

import { PDF_MIME_TYPE } from "@/consts";
import { DEFAULT_ENTITY_LABELS } from "@/lib/anonymize/constants";
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
  FileAnonymization,
} from "@/lib/pdf/anonymization-types";

const buildPipelineConfig = (
  workspaceId: string,
  labels: readonly string[],
): PipelineConfig => ({
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

  const { PDF } = await import("@libpdf/core");
  const pdf = await PDF.load(pdfBytes);
  const { text, spans: charSpans } = extractPDFText(pdf);

  const [{ loadNameDictionaries }, { runPipeline }] = await Promise.all([
    import("@stll/anonymize-data"),
    import("@stll/anonymize-wasm"),
  ]);
  const dictionaries = await loadNameDictionaries();

  const entities = await runPipeline({
    fullText: text,
    config: {
      ...buildPipelineConfig(workspaceId, DEFAULT_ENTITY_LABELS),
      dictionaries,
    },
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
