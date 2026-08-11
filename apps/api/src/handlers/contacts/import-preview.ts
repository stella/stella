import { Result } from "better-result";
import { t } from "elysia";

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
  mapping: t.String(),
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
    return Result.ok({
      errorCount: preview.errorCount,
      validCount: preview.validCount,
      rows: preview.rows.map(({ contact, issues, rowNumber }) => ({
        contact: {
          type: contact.type,
          displayName: contact.displayName,
          primaryEmail: contact.emails?.at(0)?.address ?? null,
        },
        issues,
        rowNumber,
      })),
    });
  },
);

export default previewContactImportHandler;
