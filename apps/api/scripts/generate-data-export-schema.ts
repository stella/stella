// Regenerate the committed data export JSON Schema from its Valibot source.
// `--check` fails instead of writing when the committed file is stale.

import path from "node:path";

import {
  DATA_EXPORT_JSON_SCHEMA_PATH,
  serializeDataExportJsonSchema,
} from "@/api/handlers/data-exports/manifest-json-schema";

import { formattedLikeRepository } from "../../../scripts/generated-artifacts";

const target = path.join(
  import.meta.dir,
  "../../..",
  DATA_EXPORT_JSON_SCHEMA_PATH,
);
const expected = await formattedLikeRepository(
  serializeDataExportJsonSchema(),
  "json",
);
const file = Bun.file(target);
const current = (await file.exists()) ? await file.text() : null;

if (process.argv.includes("--check")) {
  if (current !== expected) {
    console.error(
      `${DATA_EXPORT_JSON_SCHEMA_PATH} is stale; run bun apps/api/scripts/generate-data-export-schema.ts`,
    );
    process.exit(1);
  }
  process.exit(0);
}

await Bun.write(target, expected);
