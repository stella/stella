import { discoverTemplate } from "@/api/handlers/docx/discover-template";

type FindUnusedTemplateValueKeysOptions = {
  buffer: Buffer;
  values: Record<string, unknown>;
};

/**
 * Compare submitted top-level or already-flattened keys with every value path
 * declared by the template. Value types are deliberately irrelevant: a typo
 * must be rejected consistently for strings, scalars, arrays, and objects.
 */
export const findUnusedTemplateValueKeys = async ({
  buffer,
  values,
}: FindUnusedTemplateValueKeysOptions): Promise<string[]> => {
  const discovered = await discoverTemplate(buffer);
  const declaredKeys = new Set([
    ...discovered.fields.map((field) => field.path),
    ...discovered.placeholders.map((placeholder) => placeholder.name),
  ]);
  return Object.keys(values).filter((key) => !declaredKeys.has(key));
};
