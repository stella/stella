type AutomaticOcrRun = {
  id: string;
  requestSource: string;
  status: string;
};

type AutomaticOcrProjection = {
  ocrRunId: string | null;
  sourceEntityVersionId: string | null;
  sourceFieldId: string | null;
  sourceFileId: string | null;
  sourceSha256Hex: string | null;
};

type AutomaticOcrSource = {
  entityVersionId: string;
  fieldId: string;
  sourceFileId: string;
  sourceSha256Hex: string;
};

/** Restore an automatic OCR run only when its durable projection was lost. */
export const shouldRequeueAutomaticOcrRun = ({
  projection,
  run,
  source,
}: {
  projection: AutomaticOcrProjection | null;
  run: AutomaticOcrRun;
  source: AutomaticOcrSource;
}): boolean =>
  run.status === "succeeded" &&
  run.requestSource !== "manual" &&
  !(
    projection?.ocrRunId === run.id &&
    projection.sourceEntityVersionId === source.entityVersionId &&
    projection.sourceFieldId === source.fieldId &&
    projection.sourceFileId === source.sourceFileId &&
    projection.sourceSha256Hex === source.sourceSha256Hex
  );
