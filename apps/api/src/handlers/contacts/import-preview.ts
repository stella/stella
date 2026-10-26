import { Result } from "better-result";
import * as v from "valibot";

import { CONTACT_IMPORT_MAPPING_MAX_CHARS } from "@stll/api-contract";

import {
  parseContactImportDocument,
  parseContactImportMappingText,
  previewContactImport,
} from "@/api/handlers/contacts/contact-import-file";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { fileSchema } from "@/api/lib/custom-schema";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";

const importPreviewBodySchema = v.object({
  file: fileSchema({ maxBytes: FILE_SIZE_LIMIT_BYTES.dataImport }),
  mapping: v.pipe(v.string(), v.maxLength(CONTACT_IMPORT_MAPPING_MAX_CHARS)),
});

const config = {
  contract: "patch",
  permissions: { contact: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
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
