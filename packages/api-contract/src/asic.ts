import * as v from "valibot";

/** Payload inventory. Membership does not establish coverage by any signature. */
export const asicPreviewSchema = v.object({
  members: v.array(
    v.object({
      fileName: v.string(),
      text: v.string(),
      status: v.picklist(["readable", "truncated", "unavailable"]),
    }),
  ),
});
