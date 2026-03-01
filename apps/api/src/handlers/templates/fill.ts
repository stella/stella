import { Result } from "better-result";
import { t } from "elysia";

import { DOCX_MIME_TYPE } from "@/api/handlers/docx/constants";
import { fillTemplate } from "@/api/handlers/docx/patch-template";
import type { TemplateData } from "@/api/handlers/docx/types";
import type { SafeId } from "@/api/lib/branded-types";

export const fillBodySchema = t.Object({
  file: t.File({ maxSize: "50m" }),
  values: t.String(),
});

type FillProps = {
  organizationId: SafeId<"organization">;
  body: { file: File; values: string };
};

export const containsNull = (value: unknown): boolean => {
  if (value === null) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsNull);
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsNull);
  }
  return false;
};

export const fillHandler = async ({
  body: { file, values: valuesJson },
}: FillProps) => {
  if (file.type !== DOCX_MIME_TYPE) {
    return new Response(
      JSON.stringify({
        error: "Invalid file type. Expected a DOCX file.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const parseResult = Result.try(() => JSON.parse(valuesJson) as unknown);
  if (Result.isError(parseResult)) {
    return new Response(
      JSON.stringify({
        error: "Invalid JSON in 'values' field.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const parsed = parseResult.value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return new Response(
      JSON.stringify({
        error: "'values' must be a JSON object (not null or array).",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const record = parsed as Record<string, unknown>;
  const hasNullValue = Object.values(record).some(containsNull);
  if (hasNullValue) {
    return new Response(
      JSON.stringify({
        error: "'values' must not contain null values.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  // SAFETY: `parsed` is validated as a non-null, non-array object
  // with no null values. `fillTemplate` handles arbitrary value
  // shapes via `isTemplateData` discrimination internally.
  const result = await fillTemplate(buffer, record as TemplateData);

  const headers = new Headers({
    "Content-Type":
      "application/vnd.openxmlformats-officedocument" +
      ".wordprocessingml.document",
    "Content-Disposition": 'attachment; filename="filled.docx"',
  });

  if (result.unmatchedPlaceholders.length > 0) {
    headers.set(
      "X-Unmatched-Placeholders",
      result.unmatchedPlaceholders.join(","),
    );
  }
  if (result.unusedValues.length > 0) {
    headers.set("X-Unused-Values", result.unusedValues.join(","));
  }
  if (result.structureErrors.length > 0) {
    headers.set("X-Structure-Errors", JSON.stringify(result.structureErrors));
  }

  return new Response(new Uint8Array(result.buffer), {
    status: 200,
    headers,
  });
};
