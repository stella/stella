import { t } from "elysia";

import { tUuid, withDescription } from "@/api/lib/custom-schema";

export const accountExportParams = t.Object({
  exportId: withDescription(
    tUuid,
    "Export ID returned by account-exports.create or account-exports.get.",
  ),
});
