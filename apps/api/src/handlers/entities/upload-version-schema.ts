import { t } from "elysia";

import { tSafeId } from "@/api/lib/custom-schema";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";

export const uploadVersionBodySchema = t.Object({
  entityId: tSafeId("entity"),
  file: t.File({
    maxSize: FILE_SIZE_LIMITS.document,
  }),
});
