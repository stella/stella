import { describe, expect, test } from "bun:test";

import { getClipboardImageFiles } from "../clipboard";

describe("getClipboardImageFiles", () => {
  test("returns image files from clipboardData.files", () => {
    const imageFile = new File([new Uint8Array([1, 2, 3])], "photo.png", {
      type: "image/png",
    });
    const textFile = new File([new Uint8Array([4])], "note.txt", {
      type: "text/plain",
    });

    const clipboardData = {
      files: [imageFile, textFile],
    } as unknown as DataTransfer;

    expect(getClipboardImageFiles(clipboardData)).toEqual([imageFile]);
  });

  test("returns image files from clipboardData.items", () => {
    const imageFile = new File([new Uint8Array([9])], "scan.jpg", {
      type: "image/jpeg",
    });
    const textFile = new File([new Uint8Array([5])], "readme.md", {
      type: "text/plain",
    });

    const imageItem = {
      kind: "file",
      type: "image/jpeg",
      getAsFile: () => imageFile,
    };
    const textItem = {
      kind: "file",
      type: "text/plain",
      getAsFile: () => textFile,
    };

    const clipboardData = {
      items: [imageItem, textItem],
    } as unknown as DataTransfer;

    expect(getClipboardImageFiles(clipboardData)).toEqual([imageFile]);
  });

  test("deduplicates images that appear in files and items", () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const fileFromFiles = new File([payload], "dup.png", {
      type: "image/png",
      lastModified: 123,
    });
    const fileFromItems = new File([payload], "dup.png", {
      type: "image/png",
      lastModified: 123,
    });

    const imageItem = {
      kind: "file",
      type: "image/png",
      getAsFile: () => fileFromItems,
    };

    const clipboardData = {
      files: [fileFromFiles],
      items: [imageItem],
    } as unknown as DataTransfer;

    const result = getClipboardImageFiles(clipboardData);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("dup.png");
  });

  test("deduplicates multiple clipboard formats for the same image", () => {
    const payload = new Uint8Array([9, 8, 7, 6, 5]);
    const pngFile = new File([payload], "clipboard.png", {
      type: "image/png",
      lastModified: 111,
    });
    const bmpFile = new File([payload], "clipboard.bmp", {
      type: "image/bmp",
      lastModified: 222,
    });

    const pngItem = {
      kind: "file",
      type: "image/png",
      getAsFile: () => pngFile,
    };
    const bmpItem = {
      kind: "file",
      type: "image/bmp",
      getAsFile: () => bmpFile,
    };

    const clipboardData = {
      files: [pngFile, bmpFile],
      items: [pngItem, bmpItem],
    } as unknown as DataTransfer;

    const result = getClipboardImageFiles(clipboardData);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("image/png");
  });

  test("returns empty array when clipboardData is null", () => {
    expect(getClipboardImageFiles(null)).toEqual([]);
  });
});
