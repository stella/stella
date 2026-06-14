import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  createFileKey,
  createUserFileKey,
  getFileExtension,
  resolveUploadMime,
} from "./utils";

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

describe("S3 object-key tenant scoping", () => {
  test("createFileKey is prefixed by organization then workspace", () => {
    const key = createFileKey({
      organizationId: toSafeId<"organization">("org_1"),
      workspaceId: toSafeId<"workspace">("ws_1"),
      fileId: "file_1",
      mimeType: "text/markdown",
    });
    expect(key).toBe("org_1/ws_1/file_1.bin");
    // The tenant prefix is the durable isolation boundary; it must lead.
    expect(key.startsWith("org_1/ws_1/")).toBe(true);
  });

  test("createUserFileKey is prefixed by the owning user", () => {
    const key = createUserFileKey({
      userId: toSafeId<"user">("user_1"),
      fileId: "file_1",
      mimeType: "text/markdown",
    });
    expect(key).toBe("user_1/file_1.bin");
    expect(key.startsWith("user_1/")).toBe(true);
  });

  test("keys contain no path-traversal segments for branded ids", () => {
    const key = createFileKey({
      organizationId: toSafeId<"organization">("org_1"),
      workspaceId: toSafeId<"workspace">("ws_1"),
      fileId: "file_1",
      mimeType: "application/pdf",
    });
    expect(key).not.toContain("..");
    expect(key.split("/")).toHaveLength(3);
  });
});
