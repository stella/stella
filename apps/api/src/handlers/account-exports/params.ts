import * as v from "valibot";

import { uuidSchema, withDescription } from "@/api/lib/custom-schema";

export const accountExportParams = v.object({
  exportId: withDescription(
    uuidSchema,
    "Export ID returned by account-exports.create or account-exports.get.",
  ),
});
