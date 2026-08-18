import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { contactExtractionUploadKey } from "./contact-extraction-upload";

describe("contact extraction upload", () => {
  test("stages the object inside its organization signing scope", () => {
    expect(
      contactExtractionUploadKey({
        organizationId: toSafeId<"organization">("organization-a"),
        uploadId: toSafeId<"contactExtractionUpload">(
          "019cc3c1-e40d-7000-8000-000000000001",
        ),
      }),
    ).toBe(
      "organization-a/contact-extractions/tmp/019cc3c1-e40d-7000-8000-000000000001",
    );
  });
});
