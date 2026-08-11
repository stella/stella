import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { writeManifest } from "@/api/lib/docx/template-manifest";
import type { TemplateManifest } from "@/api/lib/docx/types";
import { isFieldMeta } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import { isRecord } from "@/api/lib/type-guards";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const manifestBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
  manifest: t.Any(),
});

type ManifestProps = {
  organizationId: SafeId<"organization">;
  body: { file: File; manifest: unknown };
};

export const manifestHandler = async ({
  body: { file, manifest: manifestJson },
}: ManifestProps) => {
  if (file.type !== DOCX_MIME_TYPE) {
    return new Response(
      JSON.stringify({
        error: "Invalid file type. Expected a DOCX file.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Handle both string (JSON body) and already-parsed object
  // (FormData auto-parsed by Elysia).
  let parsed: unknown = manifestJson;
  if (typeof manifestJson === "string") {
    const parseResult = Result.try((): unknown => JSON.parse(manifestJson));
    if (Result.isError(parseResult)) {
      return new Response(
        JSON.stringify({
          error: "Invalid JSON in 'manifest' field.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    parsed = parseResult.value;
  }
  if (!isRecord(parsed)) {
    return new Response(
      JSON.stringify({
        error: "'manifest' must be a JSON object (not null or array).",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (
    !("version" in parsed) ||
    typeof parsed["version"] !== "number" ||
    !Number.isFinite(parsed["version"])
  ) {
    return new Response(
      JSON.stringify({
        error: "'manifest.version' must be a finite number.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!("fields" in parsed) || !Array.isArray(parsed["fields"])) {
    return new Response(
      JSON.stringify({
        error: "'manifest.fields' must be an array.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const fields = parsed["fields"];
  if (!fields.every(isFieldMeta)) {
    return new Response(
      JSON.stringify({
        error:
          "Every element in 'manifest.fields' must be an object " +
          "with a string 'path' property.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const manifest: TemplateManifest = {
    version: parsed["version"],
    fields,
  };

  const buffer = Buffer.from(await file.arrayBuffer());
  const resultBuffer = await writeManifest(buffer, manifest);

  return secureDocumentResponse({
    body: new Uint8Array(resultBuffer),
    contentType:
      "application/vnd.openxmlformats-officedocument" +
      ".wordprocessingml.document",
    disposition: "attachment",
    fileName: sanitizeFilename("template.docx"),
  });
};

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  access: "read",
  transport: {
    type: "file-both",
    input: { field: "file", required: true, mediaTypes: [DOCX_MIME_TYPE] },
    response: { mediaTypes: [DOCX_MIME_TYPE] },
    alternative: {
      type: "none",
      reason:
        "it embeds a manifest into the supplied DOCX and returns the rewritten DOCX; both legs are bytes",
    },
  },
  body: manifestBodySchema,
} satisfies HandlerConfig;

const manifestTemplate = createSafeRootHandler(
  config,
  async function* ({ session, body }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await manifestHandler({
            organizationId: session.activeOrganizationId,
            body,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Internal server error",
            cause,
          }),
      }),
    );
    return Result.ok(result);
  },
);

export default manifestTemplate;
