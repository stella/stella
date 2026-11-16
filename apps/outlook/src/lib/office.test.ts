import { describe, expect, test } from "bun:test";

import {
  isOfficeDialogApi,
  supportsOfficeRequirement,
  toOfficeAttachmentMetadata,
} from "@/lib/office";

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

  test("requires the secure cross-origin dialog contract", () => {
    const requests: string[] = [];
    const requirements = {
      isSetSupported: (name: string, version: string) => {
        requests.push(`${name}:${version}`);
        return name === "DialogOrigin" && version === "1.1";
      },
    };

    expect(
      supportsOfficeRequirement({
        name: "DialogOrigin",
        requirements,
        version: "1.1",
      }),
    ).toBe(true);
    expect(requests).toEqual(["DialogOrigin:1.1"]);
  });

  test("treats missing or failing requirement APIs as unsupported", () => {
    expect(
      supportsOfficeRequirement({
        name: "DialogOrigin",
        requirements: undefined,
        version: "1.1",
      }),
    ).toBe(false);
    expect(
      supportsOfficeRequirement({
        name: "DialogOrigin",
        requirements: {
          isSetSupported: () => {
            throw new Error("Office runtime failure");
          },
        },
        version: "1.1",
      }),
    ).toBe(false);
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
