import { Value } from "@sinclair/typebox/value";
import { panic } from "better-result";
import { t } from "elysia";

import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import type { ValidatedServiceInput } from "@/api/lib/rate-limit/service-classification";

const templateRefSchema = t.Union([
  t.Object({
    type: t.Literal("builtin"),
    key: tDefaultVarchar,
  }),
  t.Object({
    type: t.Literal("stored"),
    templateId: tSafeId("template"),
  }),
]);

export const reportExportBodySchema = t.Object({
  templateRef: templateRefSchema,
  viewId: tSafeId("workspaceView"),
  mode: t.Union([t.Literal("workspace"), t.Literal("download")]),
  // Output format. The fill pipeline always builds a DOCX; `pdf` converts it
  // via Gotenberg before delivery. Optional for back-compat; absent defaults
  // to docx (also matches Elysia's optional-UnionEnum coercion to the first
  // literal). The frontend always sends it explicitly.
  format: t.Optional(t.Union([t.Literal("docx"), t.Literal("pdf")])),
  // Include the template's AI-drafted narrative (executive + per-contract
  // summaries). Optional for back-compat; absent defaults to on. When false
  // the worker skips every model call and the template's {% if aiNarrative %}
  // sections are removed, so the export is fast and deterministic.
  aiNarrative: t.Optional(t.Boolean()),
});

export const reportExportConsumesServices = ({
  body,
}: ValidatedServiceInput): boolean => {
  if (!Value.Check(reportExportBodySchema, body)) {
    return panic("Report export classification requires validated input");
  }
  return body.aiNarrative !== false;
};
