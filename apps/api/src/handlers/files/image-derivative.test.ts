import { describe, expect, test } from "bun:test";

import {
  isThumbnailableMimeType,
  shouldGenerateImageThumbnail,
} from "@/api/handlers/files/image-derivative";

describe("image thumbnail eligibility", () => {
  test("accepts only supported unencrypted image formats", () => {
    expect(shouldGenerateImageThumbnail({ mimeType: "image/jpeg" })).toBe(true);
    expect(shouldGenerateImageThumbnail({ mimeType: "image/png" })).toBe(true);
    expect(shouldGenerateImageThumbnail({ mimeType: "image/gif" })).toBe(true);
    expect(shouldGenerateImageThumbnail({ mimeType: "image/webp" })).toBe(true);

    expect(shouldGenerateImageThumbnail({ mimeType: "image/avif" })).toBe(
      false,
    );
    expect(shouldGenerateImageThumbnail({ mimeType: "image/heic" })).toBe(
      false,
    );
    expect(shouldGenerateImageThumbnail({ mimeType: "application/pdf" })).toBe(
      false,
    );
  });

  test("rejects encrypted images and prototype names", () => {
    expect(
      shouldGenerateImageThumbnail({
        encrypted: true,
        mimeType: "image/png",
      }),
    ).toBe(false);
    expect(isThumbnailableMimeType("toString")).toBe(false);
    expect(isThumbnailableMimeType("constructor")).toBe(false);
  });
});
