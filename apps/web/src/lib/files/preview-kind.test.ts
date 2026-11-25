import { describe, expect, test } from "bun:test";

import { nativeFilePreviewKind } from "./preview-kind";

describe("a recording's preview", () => {
  test("plays natively by media type or name", () => {
    expect(nativeFilePreviewKind({ mimeType: "audio/mpeg" })).toBe("audio");
    expect(
      nativeFilePreviewKind({
        fileName: "call.m4a",
        mimeType: "application/octet-stream",
      }),
    ).toBe("audio");
  });

  test("an encrypted recording has nothing to play", () => {
    expect(
      nativeFilePreviewKind({ encrypted: true, mimeType: "audio/wav" }),
    ).toBeNull();
  });
});
