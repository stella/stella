import * as v from "valibot";

export const generateBBoxesSchema = v.strictObject({
  queryKey: v.array(v.string()),
  justificationId: v.pipe(v.string(), v.nanoid()),
});

export type GenerateBBoxesSchema = v.InferOutput<typeof generateBBoxesSchema>;
