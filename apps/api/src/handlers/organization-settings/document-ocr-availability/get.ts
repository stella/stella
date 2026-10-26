import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { getDocumentOcrAvailability } from "@/api/lib/document-processing-readiness";

const config = {
  contract: "patch",
  description:
    "Report whether this deployment accepts document OCR requests: `live` " +
    "when a worker is processing now, `batched` when queued requests run in " +
    "the next recognition batch, `unconfigured` when requests would not run.",
  // Any org member may see whether document OCR accepts work. The response is
  // only an ephemeral status; it exposes no worker topology or provider
  // configuration.
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "anonymization_admin",
    consumesServices: false,
  },
  access: "read",
} satisfies HandlerConfig;

export const createGetDocumentOcrAvailability = (
  readAvailability: typeof getDocumentOcrAvailability,
) =>
  createSafeRootHandler(config, async function* () {
    const availability = yield* Result.ok(await readAvailability());
    return Result.ok(availability);
  });

export default createGetDocumentOcrAvailability(getDocumentOcrAvailability);
