import * as v from "valibot";

export const desktopMatterSchema = v.strictObject({
  id: v.string(),
  name: v.string(),
  reference: v.nullable(v.string()),
  color: v.nullable(v.string()),
});

export type DesktopMatter = v.InferOutput<typeof desktopMatterSchema>;

export const desktopMattersResponseSchema = v.strictObject({
  matters: v.pipe(v.array(desktopMatterSchema), v.maxLength(20)),
});

export type DesktopMattersResponse = v.InferOutput<
  typeof desktopMattersResponseSchema
>;
