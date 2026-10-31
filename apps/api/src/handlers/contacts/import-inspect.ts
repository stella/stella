import { Result } from "better-result";
import * as v from "valibot";

import {
  inspectContactImportDocument,
  parseContactImportDocument,
} from "@/api/handlers/contacts/contact-import-file";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { fileSchema } from "@/api/lib/custom-schema";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";

const importInspectBodySchema = v.object({
  file: fileSchema({ maxBytes: FILE_SIZE_LIMIT_BYTES.dataImport }),
});

const config = {
  contract: "patch",
  permissions: { contact: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
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
