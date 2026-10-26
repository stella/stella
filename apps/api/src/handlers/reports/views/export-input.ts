import { panic } from "better-result";
import * as v from "valibot";

import {
  defaultVarcharSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import type { ValidatedServiceInput } from "@/api/lib/rate-limit/service-classification";

const templateRefSchema = v.union([
  v.object({ type: v.literal("builtin"), key: defaultVarcharSchema }),
  v.object({
    type: v.literal("stored"),
    templateId: resourceIdSchema("template"),
  }),
]);

export const reportExportBodySchema = v.object({
  templateRef: templateRefSchema,
  viewId: resourceIdSchema("workspaceView"),
  mode: v.picklist(["workspace", "download"]),
  format: v.optional(v.picklist(["docx", "pdf"])),
  aiNarrative: v.optional(v.boolean()),
});

export const reportExportConsumesServices = ({
  body,
}: ValidatedServiceInput): boolean => {
  if (!v.is(reportExportBodySchema, body)) {
    return panic("Report export classification requires validated input");
  }
  return body.aiNarrative !== false;
};
