import { Result } from "better-result";
import { t } from "elysia";

import { CONTACT_IMPORT_MAPPING_MAX_CHARS } from "@stll/api-contract";

import {
  parseContactImportDocument,
  parseContactImportMappingText,
  previewContactImport,
} from "@/api/handlers/contacts/contact-import-file";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";

const importPreviewBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.dataImport }),
  /** The mapping, JSON-encoded by the client; bounded before it is parsed. */
  mapping: t.String({ maxLength: CONTACT_IMPORT_MAPPING_MAX_CHARS }),
});

const config = {
  permissions: { contact: ["create"] },
  mcp: { type: "internal", reason: "upload_mechanics" },
  body: importPreviewBodySchema,
} satisfies HandlerConfig;

const previewContactImportHandler = createSafeRootHandler(
  config,
  async function* ({ body: { file, mapping: mappingText } }) {
    const text = await file.text();
    const document = yield* parseContactImportDocument(text);
    const mapping = yield* parseContactImportMappingText(mappingText);
    const preview = yield* previewContactImport({ document, mapping });
    // The full candidate goes back, not a projection of it: the commit call
    // (`PUT /contacts/import`) submits exactly the rows shown here, so a
    // trimmed preview row would force the client to rebuild the contact from
    // the raw file and re-derive every normalization this module applied.
    return Result.ok({
      errorCount: preview.errorCount,
      validCount: preview.validCount,
      rows: preview.rows.map(({ contact, issues, rowNumber }) => ({
        contact,
        issues,
        rowNumber,
      })),
    });
  },
);

export default previewContactImportHandler;
