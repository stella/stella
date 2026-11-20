import * as v from "valibot";

export const structuredDocumentPreviewSchema = v.object({
  text: v.string(),
  truncated: v.boolean(),
});
