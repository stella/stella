type CellField = {
  id: string;
  propertyId?: string | undefined;
  content: { type: string };
};

/** The cited cell's field and the file its evidence lies in: the file its
 * justification names, else the document's first file. Null when the
 * document no longer has the cell. */
export const cellCitationFields = <TField extends CellField>({
  fields,
  justifications,
  propertyId,
}: {
  fields: readonly TField[];
  justifications: readonly {
    fieldId: string;
    fileFieldIds: readonly string[];
  }[];
  propertyId: string;
}): { cell: TField; file: TField | undefined } | null => {
  const cell = fields.find((field) => field.propertyId === propertyId);
  if (cell === undefined) {
    return null;
  }
  const evidenceFileId = justifications
    .find((justification) => justification.fieldId === cell.id)
    ?.fileFieldIds.at(0);
  const file = fields.find(
    (field) =>
      field.content.type === "file" &&
      (evidenceFileId === undefined || field.id === evidenceFileId),
  );
  return { cell, file };
};
