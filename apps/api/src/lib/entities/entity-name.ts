import * as v from "valibot";

import { stripInvisibleFormatting } from "@stll/text-normalize/invisible-formatting";

const entityNameSchema = v.pipe(v.string(), v.brand("EntityName"));

export type EntityName = v.InferOutput<typeof entityNameSchema>;

/** Matches the `entities.display_name` column default. */
const NAME_OF_ONLY_FORMATTING = "Untitled";

/**
 * The one way a value becomes `entities.name`. A census test holds every
 * writer of that column to it: `entity-name-writers.test.ts`.
 */
export const normalizeEntityName = (name: string): EntityName =>
  v.parse(
    entityNameSchema,
    stripInvisibleFormatting(name) || NAME_OF_ONLY_FORMATTING,
  );
