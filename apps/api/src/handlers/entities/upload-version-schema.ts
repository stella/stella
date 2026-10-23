import * as v from "valibot";

import { fileSchema, resourceIdSchema } from "@/api/lib/custom-schema";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";

export const uploadVersionBodySchema = v.object({
  entityId: resourceIdSchema("entity"),
  file: fileSchema({ maxBytes: FILE_SIZE_LIMIT_BYTES.document }),
});
