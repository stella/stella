import { describe, expect, test } from "bun:test";

import { getFileExtension, resolveUploadMime } from "./utils";

describe("resolveUploadMime", () => {
  test("recovers .msg reported as octet-stream", () => {
    expect(
      resolveUploadMime({
        declaredMime: "application/octet-stream",
        fileName: "Re Contract.msg",
      }),
    ).toBe("application/vnd.ms-outlook");
  });

  test("recovers .eml reported with an empty type", () => {
    expect(
      resolveUploadMime({ declaredMime: "", fileName: "thread.EML" }),
    ).toBe("message/rfc822");
  });

  test("recovers markdown reported as octet-stream", () => {
    expect(
      resolveUploadMime({
        declaredMime: "application/octet-stream",
        fileName: "notes.MD",
      }),
    ).toBe("text/markdown");
  });

  test("leaves a well-typed MIME unchanged", () => {
    expect(
      resolveUploadMime({
        declaredMime: "application/pdf",
        fileName: "weird-name.msg",
      }),
    ).toBe("application/pdf");
  });

  test("leaves a generic type unchanged for unknown extensions", () => {
    expect(
      resolveUploadMime({
        declaredMime: "application/octet-stream",
        fileName: "archive.bin",
      }),
    ).toBe("application/octet-stream");
  });

  test("leaves a generic type unchanged when there is no extension", () => {
    expect(
      resolveUploadMime({
        declaredMime: "application/octet-stream",
        fileName: "msg",
      }),
    ).toBe("application/octet-stream");
  });
});

describe("getFileExtension", () => {
  test("keeps text/markdown on the legacy fallback storage extension", () => {
    expect(getFileExtension("text/markdown")).toBe("bin");
  });
});
