import * as v from "valibot";

import {
  DATA_BOX_DOCUMENT_KIND,
  dataBoxDeliveryEventSchema,
  dataBoxStatedEnvelopeSchema,
} from "@stll/api-contract/data-box";

export const DATA_BOX_PREVIEW_MODE = "data-box-preview";

const common = {
  annotation: v.string(),
  envelope: dataBoxStatedEnvelopeSchema,
};

const dataBoxMessageMetadataSchema = v.object({
  kind: v.literal(DATA_BOX_DOCUMENT_KIND.message),
  ...common,
  files: v.array(v.object({ fileName: v.string(), mimeType: v.string() })),
});
export type DataBoxMessageMetadata = v.InferOutput<
  typeof dataBoxMessageMetadataSchema
>;

const dataBoxReceiptSchema = v.object({
  kind: v.literal(DATA_BOX_DOCUMENT_KIND.receipt),
  ...common,
  events: v.array(dataBoxDeliveryEventSchema),
});
export type DataBoxReceipt = v.InferOutput<typeof dataBoxReceiptSchema>;

export const dataBoxPreviewResultSchema = v.variant("kind", [
  v.object({
    ...dataBoxMessageMetadataSchema.entries,
    files: v.array(
      v.object({
        ...dataBoxMessageMetadataSchema.entries.files.item.entries,
        sha256Hex: v.string(),
        /** The type the file is listed and delivered as (`partMediaType`). */
        mediaType: v.string(),
        sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
      }),
    ),
    contentHash: v.string(),
  }),
  dataBoxReceiptSchema,
  v.object({ kind: v.literal("unreadable") }),
]);
