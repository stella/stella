import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { isDocumentOcrWorkerAvailable } from "@/api/lib/document-processing-readiness";

const config = {
  description:
    "Report whether a document OCR worker is currently ready to accept work.",
  // Any org member may see whether document OCR can currently accept work.
  // The response is only an ephemeral availability bit; it exposes no worker
  // topology or provider configuration.
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "anonymization_admin" },
  access: "read",
} satisfies HandlerConfig;

const getDocumentOcrAvailability = createSafeRootHandler(
  config,
  async function* () {
    const available = yield* Result.ok(await isDocumentOcrWorkerAvailable());
    return Result.ok({
      available,
    });
  },
);

export default getDocumentOcrAvailability;
