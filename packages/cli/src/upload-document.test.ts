import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type {
  UploadDocumentDependencies,
  UploadDocumentInput,
} from "./upload-document.js";
import { uploadDocument } from "./upload-document.js";

type InvocationCall = {
  capability: string;
  confirm: true | undefined;
  input: Record<string, unknown>;
};

const uploadInput: UploadDocumentInput = {
  filePath: "/tmp/agreement.txt",
  mimeType: "text/plain",
  name: undefined,
  parentId: undefined,
  propertyId: undefined,
  workspaceId: "workspace-1",
};

const localFile = {
  bytes: new TextEncoder().encode("agreement"),
  mimeType: "text/plain",
  name: "agreement.txt",
  sha256Hex: "a".repeat(64),
};

const reservation = {
  uploadId: "upload-1",
  url: "https://objects.example.test/upload-1",
  headers: {
    "content-type": "text/plain",
    "x-amz-checksum-sha256": "checksum",
  },
};

const createDependencies = ({
  invoke,
  put = async () => Result.ok(undefined),
}: {
  invoke: UploadDocumentDependencies["invoke"];
  put?: UploadDocumentDependencies["put"];
}): UploadDocumentDependencies => ({
  invoke,
  put,
  readLocalFile: async () => Result.ok(localFile),
});

describe("document upload state machine", () => {
  test("discovers the file property, PUTs exact bytes and headers, then finalizes", async () => {
    const calls: InvocationCall[] = [];
    const puts: Parameters<UploadDocumentDependencies["put"]>[0][] = [];
    const dependencies = createDependencies({
      invoke: async (capability, input, confirm) => {
        calls.push({ capability, input, confirm });
        if (capability === "properties.list") {
          return {
            status: "ok",
            payload: [
              { id: "text-property", content: { type: "text" } },
              { id: "file-property", content: { type: "file" } },
            ],
          };
        }
        if (capability === "uploads.create") {
          return { status: "ok", payload: reservation };
        }
        return {
          status: "ok",
          payload: { finalizedResult: { entityId: "entity-1" } },
        };
      },
      put: async (request) => {
        puts.push(request);
        return Result.ok(undefined);
      },
    });

    const result = await uploadDocument({ dependencies, input: uploadInput });

    expect(Result.isOk(result)).toBe(true);
    expect(calls.map(({ capability }) => capability)).toEqual([
      "properties.list",
      "uploads.create",
      "uploads.update",
    ]);
    expect(calls.at(1)?.input).toEqual({
      body: {
        purpose: "entity_create",
        propertyId: "file-property",
        name: "agreement.txt",
        mimeType: "text/plain",
        size: localFile.bytes.byteLength,
        sha256Hex: localFile.sha256Hex,
      },
      params: { workspaceId: "workspace-1" },
    });
    expect(puts).toEqual([
      {
        bytes: localFile.bytes,
        headers: reservation.headers,
        url: reservation.url,
      },
    ]);
  });

  test("an explicit property id skips discovery", async () => {
    const capabilities: string[] = [];
    const dependencies = createDependencies({
      invoke: async (capability) => {
        capabilities.push(capability);
        return capability === "uploads.create"
          ? { status: "ok", payload: reservation }
          : { status: "ok", payload: { entityId: "entity-1" } };
      },
    });

    const result = await uploadDocument({
      dependencies,
      input: { ...uploadInput, propertyId: "chosen-property" },
    });

    expect(Result.isOk(result)).toBe(true);
    expect(capabilities).toEqual(["uploads.create", "uploads.update"]);
  });

  test("uses the local file's inferred MIME type unless explicitly overridden", async () => {
    const createBodies: Record<string, unknown>[] = [];
    const dependencies = createDependencies({
      invoke: async (capability, input) => {
        if (capability === "uploads.create") {
          createBodies.push(input);
          return { status: "ok", payload: reservation };
        }
        return { status: "ok", payload: { entityId: "entity-1" } };
      },
    });

    const result = await uploadDocument({
      dependencies,
      input: {
        ...uploadInput,
        mimeType: undefined,
        propertyId: "chosen-property",
      },
    });

    expect(Result.isOk(result)).toBe(true);
    expect(createBodies.at(0)?.["body"]).toEqual({
      purpose: "entity_create",
      propertyId: "chosen-property",
      name: "agreement.txt",
      mimeType: "text/plain",
      size: localFile.bytes.byteLength,
      sha256Hex: localFile.sha256Hex,
    });
  });

  test("ambiguous discovery fails before reserving an upload", async () => {
    const capabilities: string[] = [];
    const dependencies = createDependencies({
      invoke: async (capability) => {
        capabilities.push(capability);
        return {
          status: "ok",
          payload: [
            { id: "file-1", content: { type: "file" } },
            { id: "file-2", content: { type: "file" } },
          ],
        };
      },
    });

    const result = await uploadDocument({ dependencies, input: uploadInput });

    expect(Result.isError(result)).toBe(true);
    expect(capabilities).toEqual(["properties.list"]);
  });

  test("a failed PUT always aborts the reservation and never finalizes", async () => {
    const calls: InvocationCall[] = [];
    const dependencies = createDependencies({
      invoke: async (capability, input, confirm) => {
        calls.push({ capability, input, confirm });
        if (capability === "uploads.create") {
          return { status: "ok", payload: reservation };
        }
        return { status: "ok", payload: { aborted: true } };
      },
      put: async () => Result.err("PUT rejected"),
    });

    const result = await uploadDocument({
      dependencies,
      input: { ...uploadInput, propertyId: "file-property" },
    });

    expect(Result.isError(result)).toBe(true);
    expect(calls).toEqual([
      expect.objectContaining({ capability: "uploads.create" }),
      {
        capability: "uploads.delete",
        input: {
          params: { uploadId: "upload-1", workspaceId: "workspace-1" },
        },
        confirm: true,
      },
    ]);
    expect(
      calls.some(({ capability }) => capability === "uploads.update"),
    ).toBe(false);
  });

  test("a malformed reservation with a known id is abandoned", async () => {
    const capabilities: string[] = [];
    const dependencies = createDependencies({
      invoke: async (capability) => {
        capabilities.push(capability);
        return capability === "uploads.create"
          ? { status: "ok", payload: { uploadId: "upload-1" } }
          : { status: "ok", payload: { aborted: true } };
      },
    });

    const result = await uploadDocument({
      dependencies,
      input: { ...uploadInput, propertyId: "file-property" },
    });

    expect(Result.isError(result)).toBe(true);
    expect(capabilities).toEqual(["uploads.create", "uploads.delete"]);
  });

  test("a finalize failure preserves the staged upload for an idempotent retry", async () => {
    const capabilities: string[] = [];
    const dependencies = createDependencies({
      invoke: async (capability) => {
        capabilities.push(capability);
        if (capability === "uploads.create") {
          return { status: "ok", payload: reservation };
        }
        return {
          status: "tool-error",
          result: {
            isError: true,
            content: [{ type: "text", text: "finalize failed" }],
          },
        };
      },
    });

    const result = await uploadDocument({
      dependencies,
      input: { ...uploadInput, propertyId: "file-property" },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toEqual(
        expect.objectContaining({ type: "finalize", uploadId: "upload-1" }),
      );
    }
    expect(capabilities).toEqual(["uploads.create", "uploads.update"]);
  });
});
