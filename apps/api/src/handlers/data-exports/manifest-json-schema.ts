import {
  DATA_EXPORT_SCHEMA_ID,
  dataExportManifestSchema,
} from "@/api/handlers/data-exports/manifest-schema";
import { toJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";

/** Repository path of the committed, generated JSON Schema. */
export const DATA_EXPORT_JSON_SCHEMA_PATH =
  "docs/data-export/stella-data-export.v1.schema.json";

/** The published JSON Schema, derived from the Valibot contract. */
export const buildDataExportJsonSchema = (): Record<string, unknown> => ({
  ...toJsonSchema(dataExportManifestSchema),
  $id: DATA_EXPORT_SCHEMA_ID,
});

/** Serialized schema input for repository artifact formatting. */
export const serializeDataExportJsonSchema = (): string =>
  `${JSON.stringify(buildDataExportJsonSchema(), null, 2)}\n`;
