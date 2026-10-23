import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { clauseBodySchema } from "@/api/lib/clauses/body-schema";
import { jsonObjectSchema, resourceIdSchema } from "@/api/lib/custom-schema";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import { fillByIdLogic } from "@/api/lib/templates/fill-by-id-logic";
import { OCTET_STREAM_MIME_TYPE } from "@/api/mime-types";

const fillByIdBodySchema = v.object({
  values: jsonObjectSchema,
  clauseOverrides: v.exactOptional(v.record(v.string(), clauseBodySchema)),
});

const fillByIdQuerySchema = v.object({
  format: v.exactOptional(v.picklist(["docx", "pdf"])),
});

const fillByIdParamsSchema = v.object({
  templateId: resourceIdSchema("template"),
});

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.standard,
  contentDelivery: { type: "audited" },
  description:
    "Fill a stored template and return the finished document as DOCX (the " +
    "default) or PDF. values is an object mapping each field path to its value; " +
    "clauseOverrides replaces a clause slot's body for this fill only. " +
    "Registry lookups, formulas, composite fields, AI-drafted fields, and " +
    "conditional sections resolve server-side. Use " +
    "templates.fills.create to save the same fill into a matter instead " +
    "of downloading it, and templates.fills.preview to see the text without " +
    "producing a file.",
  permissions: { template: ["use"] },
  access: "write",
  mcp: { type: "covered", by: "fill_template" },
  transport: {
    type: "file-response",
    // Octet-stream on the wire regardless of the rendered format; see
    // OCTET_STREAM_MIME_TYPE.
    response: { mediaTypes: [OCTET_STREAM_MIME_TYPE] },
    alternative: {
      type: "complete",
      via: ["templates.fills.create"],
      note: "same stored template and values, with the filled document saved into a matter and its entity id returned instead of the bytes",
    },
  },
  params: fillByIdParamsSchema,
  body: fillByIdBodySchema,
  query: fillByIdQuerySchema,
} satisfies HandlerConfig;

const fillTemplateById = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    scopedDb,
    session,
    user,
    params,
    body,
    query,
    recordAuditEvent,
  }) {
    // fillByIdLogic returns the resolved document as data (body, content
    // type, filename), not a Response: the capability-catalog exporter
    // statically scans each handler module's own source for a file-like
    // construction, so the actual secureDocumentResponse(...) call — the
    // thing that makes this endpoint's declared file-response transport
    // true — has to live here, not in the delegated lib module.
    const filled = yield* yield* fillByIdLogic({
      safeDb,
      scopedDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      templateId: params.templateId,
      body,
      query,
      recordAuditEvent,
    });
    return Result.ok(secureDocumentResponse(filled));
  },
);

export default fillTemplateById;
