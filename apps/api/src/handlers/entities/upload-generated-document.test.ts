import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import { uploadGeneratedDocument } from "@/api/handlers/entities/upload";
import { toSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type UploadGeneratedDocumentContext = Parameters<
  typeof uploadGeneratedDocument.handler
>[0];

const messageId = toSafeId<"chatMessage">(
  "00000000-0000-0000-0000-000000000001",
);
const threadId = toSafeId<"chatThread">("00000000-0000-0000-0000-000000000002");
const propertyId = toSafeId<"property">("00000000-0000-0000-0000-000000000003");

const createUnreadFile = () => {
  const file = new File(["untrusted bytes"], "draft.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const arrayBuffer = mock(
    async () => await Promise.resolve(new ArrayBuffer(1)),
  );
  file.arrayBuffer = arrayBuffer;
  return { arrayBuffer, file };
};

const createContext = ({ file, safeDb }: { file: File; safeDb: SafeDb }) =>
  createTestHandlerContext<UploadGeneratedDocumentContext>({
    body: {
      contentSha256Hex: "0".repeat(64),
      file,
      messageId,
      name: "draft.docx",
      propertyId,
      threadId,
      toolCallId: "tool-call-1",
    },
    safeDb,
  });

const createQueuedSafeDb = (values: unknown[]) => {
  let callIndex = 0;
  return asTestRaw<SafeDb>(async <T>() => {
    const value = values.at(callIndex);
    callIndex += 1;
    return Result.ok(asTestRaw<T>(value));
  });
};

describe("generated document upload preflight", () => {
  test("rejects an unavailable draft before reading uploaded bytes", async () => {
    const { arrayBuffer, file } = createUnreadFile();
    const safeDb = asTestRaw<SafeDb>(async <T>() =>
      Result.ok(asTestRaw<T>({ status: "invalid" })),
    );

    const result = await uploadGeneratedDocument.handler(
      createContext({ file, safeDb }),
    );

    expect(result).toEqual({
      code: 409,
      response: { message: "Generated document draft not found" },
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  test("returns a saved draft replay before reading uploaded bytes", async () => {
    const { arrayBuffer, file } = createUnreadFile();
    const replay = {
      entityId: "entity-1",
      fieldId: "field-1",
      fileId: "file-1",
      fileName: "draft.docx",
      renamed: false,
    };
    const safeDb = asTestRaw<SafeDb>(async <T>() =>
      Result.ok(asTestRaw<T>({ result: replay, status: "saved" })),
    );

    const result = await uploadGeneratedDocument.handler(
      createContext({ file, safeDb }),
    );

    expect(result).toEqual(replay);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  test("rejects a saved replay whose bytes no longer match", async () => {
    const { arrayBuffer, file } = createUnreadFile();
    const safeDb = asTestRaw<SafeDb>(async <T>() =>
      Result.ok(asTestRaw<T>({ status: "content-mismatch" })),
    );

    const result = await uploadGeneratedDocument.handler(
      createContext({ file, safeDb }),
    );

    expect(result).toEqual({
      code: 409,
      response: {
        message:
          "Generated document content does not match the requested draft",
      },
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  test("rejects a ready draft over the entity cap before reading uploaded bytes", async () => {
    const { arrayBuffer, file } = createUnreadFile();
    const safeDb = createQueuedSafeDb([
      { status: "ready" },
      LIMITS.entitiesCount,
      { content: { type: "file" }, id: propertyId },
    ]);

    const result = await uploadGeneratedDocument.handler(
      createContext({ file, safeDb }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Entities limit reached" },
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  test("rejects a ready draft with an invalid property before reading uploaded bytes", async () => {
    const { arrayBuffer, file } = createUnreadFile();
    const safeDb = createQueuedSafeDb([{ status: "ready" }, 0, undefined]);

    const result = await uploadGeneratedDocument.handler(
      createContext({ file, safeDb }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Property not found in workspace" },
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
