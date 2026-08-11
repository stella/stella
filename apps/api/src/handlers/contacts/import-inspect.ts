import { Result } from "better-result";
import { t } from "elysia";

import {
  inspectContactImportDocument,
  parseContactImportDocument,
} from "@/api/handlers/contacts/contact-import-file";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";

const importInspectBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.dataImport }),
});

const config = {
  permissions: { contact: ["create"] },
  mcp: { type: "internal", reason: "upload_mechanics" },
  body: importInspectBodySchema,
} satisfies HandlerConfig;

const inspectContactImport = createSafeRootHandler(
  config,
  async function* ({ body: { file } }) {
    const text = await file.text();
    const document = yield* parseContactImportDocument(text);
    return Result.ok(inspectContactImportDocument(document));
  },
);

export default inspectContactImport;
