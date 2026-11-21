import type { FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";

type ExtractionSourceField = {
  content: FieldContent | null;
  propertyId?: SafeId<"property"> | undefined;
};

/**
 * The single policy owner for choosing the immutable file which backs text
 * extraction. Callers must supply fields in stable creation order. An
 * explicitly replaced property wins; otherwise the first file is the source.
 */
export const chooseExtractionSource = <T extends ExtractionSourceField>(
  fields: readonly T[],
  filePropertyId?: SafeId<"property">,
): (T & { content: Extract<FieldContent, { type: "file" }> }) | null =>
  fields.find(
    (
      field,
    ): field is T & {
      content: Extract<FieldContent, { type: "file" }>;
    } =>
      field.content?.type === "file" &&
      (filePropertyId === undefined || field.propertyId === filePropertyId),
  ) ?? null;
