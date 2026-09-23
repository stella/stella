import * as v from "valibot";

import type { FileKey } from "@/api/lib/file-key";
import { fileKeySchema } from "@/api/lib/file-key";

/**
 * A fixture object key typed as a file key. Production keys come from
 * `createFileKey`/`createUserFileKey`; tests that seed rows or fake storage
 * with literal keys use this instead.
 */
export const testFileKey = (key: string): FileKey =>
  v.parse(fileKeySchema, key);
