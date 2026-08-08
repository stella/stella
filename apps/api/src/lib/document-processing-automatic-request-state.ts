type OcrRun = {
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

export const isExactOcrProjection = ({
  projection,
  run,
  source,
}: {
  projection: AutomaticOcrProjection | null;
  run: Pick<OcrRun, "id">;
  source: AutomaticOcrSource;
}): boolean =>
  projection?.ocrRunId === run.id &&
  projection.sourceEntityVersionId === source.entityVersionId &&
  projection.sourceFieldId === source.fieldId &&
  projection.sourceFileId === source.sourceFileId &&
  projection.sourceSha256Hex === source.sourceSha256Hex;

/** Restore a successful OCR run only when its durable projection was lost. */
export const shouldRequeueOcrRunAfterProjectionLoss = ({
  projection,
  run,
  source,
}: {
  projection: AutomaticOcrProjection | null;
  run: OcrRun;
  source: AutomaticOcrSource;
}): boolean =>
  run.status === "succeeded" &&
  !isExactOcrProjection({ projection, run, source });
