import { Result } from "better-result";
import { t } from "elysia";

import { writeManifest } from "@/api/handlers/docx/template-manifest";
import type { TemplateManifest } from "@/api/handlers/docx/types";
import type { SafeId } from "@/api/lib/branded-types";
import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { isRecord } from "@/api/lib/type-guards";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

export const manifestBodySchema = t.Object({
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
    const parseResult = Result.try(() => JSON.parse(manifestJson) as unknown);
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
    typeof parsed.version !== "number" ||
    !Number.isFinite(parsed.version)
  ) {
    return new Response(
      JSON.stringify({
        error: "'manifest.version' must be a finite number.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!("fields" in parsed) || !Array.isArray(parsed.fields)) {
    return new Response(
      JSON.stringify({
        error: "'manifest.fields' must be an array.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!("conditions" in parsed) || !Array.isArray(parsed.conditions)) {
    return new Response(
      JSON.stringify({
        error: "'manifest.conditions' must be an array.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const hasInvalidField = parsed.fields.some(
    (f: unknown) => !isRecord(f) || typeof f.path !== "string",
  );
  if (hasInvalidField) {
    return new Response(
      JSON.stringify({
        error:
          "Every element in 'manifest.fields' must be an object " +
          "with a string 'path' property.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const hasInvalidCondition = parsed.conditions.some(
    (c: unknown) =>
      !isRecord(c) ||
      typeof c.name !== "string" ||
      typeof c.expression !== "string",
  );
  if (hasInvalidCondition) {
    return new Response(
      JSON.stringify({
        error:
          "Every element in 'manifest.conditions' must be an " +
          "object with string 'name' and 'expression' properties.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // SAFETY: top-level shape and element-level required properties
  // are validated above. Optional FieldMeta properties (label,
  // inputType, options, validation) are handled gracefully by
  // buildFieldXml which uses ?? and conditional checks.
  // TODO: FIXME — Array.isArray narrows unknown to any[] (TS lib limitation)
  // oxlint-disable typescript-eslint/no-unsafe-assignment -- Array.isArray narrows unknown to any[]
  const manifest = {
    version: parsed.version,
    fields: parsed.fields,
    conditions: parsed.conditions,
  } as TemplateManifest;
  // oxlint-enable typescript-eslint/no-unsafe-assignment

  const buffer = Buffer.from(await file.arrayBuffer());
  const resultBuffer = await writeManifest(buffer, manifest);

  return new Response(new Uint8Array(resultBuffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument" +
        ".wordprocessingml.document",
      "Content-Disposition": 'attachment; filename="template.docx"',
    },
  });
};

const config = {
  permissions: { workspace: ["read"] },
  body: manifestBodySchema,
} satisfies HandlerConfig;

const manifestTemplate = createRootHandler(
  config,
  async ({ session, body }) =>
    await manifestHandler({
      organizationId: session.activeOrganizationId,
      body,
    }),
);

export default manifestTemplate;
