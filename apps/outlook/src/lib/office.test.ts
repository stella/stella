import { describe, expect, test } from "bun:test";

import { isOfficeDialogApi, toOfficeAttachmentMetadata } from "@/lib/office";

const readAttachment = {
  contentType: "application/pdf",
  id: "read-attachment-id",
  isInline: false,
  name: "agreement.pdf",
  size: 1234,
} satisfies {
  contentType: string;
  id: string;
  isInline: boolean;
  name: string;
  size: number;
};

const composeAttachment = {
  id: "compose-attachment-id",
  isInline: false,
  name: "agreement.pdf",
  size: 1234,
} satisfies Pick<
  Office.AttachmentDetailsCompose,
  "id" | "isInline" | "name" | "size"
>;

describe("Office dialog capability", () => {
  test("treats a partial browser Office context as unavailable", () => {
    expect(isOfficeDialogApi(undefined)).toBe(false);
    expect(isOfficeDialogApi(null)).toBe(false);
    expect(isOfficeDialogApi({})).toBe(false);
  });

  test("accepts a structurally valid dialog API", () => {
    expect(isOfficeDialogApi({ displayDialogAsync: () => undefined })).toBe(
      true,
    );
  });
});

describe("Office attachment metadata", () => {
  test("preserves the read-mode MIME type while projecting the shared shape", () => {
    expect(toOfficeAttachmentMetadata(readAttachment)).toEqual({
      contentType: "application/pdf",
      id: "read-attachment-id",
      isInline: false,
      name: "agreement.pdf",
      size: 1234,
    });
  });

  test("leaves MIME type absent for compose-mode attachment details", () => {
    expect(toOfficeAttachmentMetadata(composeAttachment)).toEqual({
      id: "compose-attachment-id",
      isInline: false,
      name: "agreement.pdf",
      size: 1234,
    });
  });
});
