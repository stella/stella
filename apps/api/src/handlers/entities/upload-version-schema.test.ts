import { describe, expect, test } from "bun:test";

import { uploadVersionBodySchema } from "@/api/handlers/entities/upload-version-schema";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";

describe("upload version request schema", () => {
  test("caps uploaded files at the document upload limit", () => {
    expect(uploadVersionBodySchema.properties.file["maxSize"]).toBe(
      FILE_SIZE_LIMITS.document,
    );
  });
});
