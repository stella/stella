import { t } from "elysia";

import { FILE_SIZE_LIMITS } from "@/api/lib/limits";

export const uploadVersionBodySchema = t.Object({
  entityId: t.String(),
  file: t.File({
    maxSize: FILE_SIZE_LIMITS.document,
  }),
});
