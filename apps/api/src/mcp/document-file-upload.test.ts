import {
  getToolUiResourceUri,
  McpUiToolMetaSchema,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { panic, Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  DOCUMENT_UPLOAD_APP_RESOURCE_URI,
  uploadRemoteDocumentVersion,
} from "@/api/mcp/document-file-upload";
import {
  DOCUMENT_TOOL_DEFINITIONS,
  DOCUMENT_TOOL_HANDLERS,
} from "@/api/mcp/document-tools";
import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import { errorResult } from "@/api/mcp/tool-utils";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const emptyScopedDb = asTestRaw<McpRequestContext["scopedDb"]>(
  async (run: (tx: unknown) => unknown) => await run({}),
);
const noopRecorder = asTestRaw<AuditRecorder>(async () => undefined);

const createContext = (): McpRequestContext => {
  const workspaceId = toSafeId<"workspace">(
    "00000000-0000-4000-8000-000000000001",
  );
  const safeDb = toSafeDbMock(emptyScopedDb);
  return {
    accessibleWorkspaceIds: [workspaceId],
    accessibleWorkspaceIdSet: new Set([workspaceId]),
    accessibleWorkspaceStatusById: new Map([[workspaceId, "active"]]),
    accessibleWorkspaces: [{ id: workspaceId, status: "active" }],
    grantedScopes: [
      "stella:read",
      "stella:documents_write",
      "stella:matters_write",
    ],
    memberRole: "owner",
    organizationId: toSafeId<"organization">(
      "00000000-0000-4000-8000-000000000002",
    ),
    request: new Request("https://stella.example/mcp"),
    recordAuditEvent: noopRecorder,
    safeDb,
    scopedDb: emptyScopedDb,
    userId: toSafeId<"user">("00000000-0000-4000-8000-000000000003"),
  };
};

describe("document file upload surface", () => {
  test("keeps host-file uploads UI-free and isolates the portable picker", () => {
    const uploadDefinition = DOCUMENT_TOOL_DEFINITIONS.find(
      ({ name }) => name === "upload_document_version",
    );
    const pickerDefinition = DOCUMENT_TOOL_DEFINITIONS.find(
      ({ name }) => name === "open_document_version_upload",
    );
    if (!uploadDefinition || !pickerDefinition) {
      panic("Canonical upload and picker tool definitions are missing");
    }

    const listedUpload = toMcpTools([uploadDefinition]).at(0);
    expect(listedUpload?._meta).toMatchObject({
      "openai/fileParams": ["file"],
    });
    expect(listedUpload?._meta).not.toHaveProperty("ui");
    expect(listedUpload?.inputSchema).toMatchObject({
      required: ["entity_id", "file"],
      properties: {
        file: {
          required: ["download_url", "file_id"],
          properties: {
            download_url: { type: "string" },
            file_id: { type: "string" },
            mime_type: { type: "string" },
            file_name: { type: "string" },
          },
        },
      },
    });

    const listedPicker = toMcpTools([pickerDefinition]).at(0);
    const parsedUi = McpUiToolMetaSchema.safeParse(listedPicker?._meta?.["ui"]);
    expect(parsedUi.success).toBe(true);
    if (!parsedUi.success) {
      panic("Upload picker UI metadata is invalid");
    }
    expect(getToolUiResourceUri({ _meta: { ui: parsedUi.data } })).toBe(
      DOCUMENT_UPLOAD_APP_RESOURCE_URI,
    );
    expect(listedPicker?._meta).toMatchObject({
      ui: { resourceUri: DOCUMENT_UPLOAD_APP_RESOURCE_URI },
    });
    expect(listedPicker?._meta).not.toHaveProperty("openai/fileParams");
    expect(listedPicker?.inputSchema).toMatchObject({
      required: ["entity_id"],
    });
    expect(listedPicker?.inputSchema.properties).not.toHaveProperty("file");
  });

  test("rejects a host-file upload before dispatch when the host omitted the file", async () => {
    const result = await DOCUMENT_TOOL_HANDLERS.upload_document_version({
      args: {
        entity_id: "00000000-0000-4000-8000-000000000010",
      },
      context: createContext(),
    });

    expect(result).toMatchObject({
      status: "error",
      error: {
        type: "structured",
        code: "validation_error",
      },
    });
  });

  test("bridges a host file through the canonical create and finalize capabilities", async () => {
    const bytes = new TextEncoder().encode("agreement body");
    const invocations: Record<string, unknown>[] = [];

    const result = await uploadRemoteDocumentVersion({
      context: createContext(),
      entityId: "00000000-0000-4000-8000-000000000010",
      file: {
        download_url: "https://files.example/agreement.docx",
        file_id: "file_123",
        file_name: "agreement.docx",
        mime_type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      workspaceId: "00000000-0000-4000-8000-000000000001",
      dependencies: {
        abort: mock(async () => ({
          status: "ok" as const,
          payload: { aborted: true },
        })),
        captureCleanupFailure: mock(() => undefined),
        download: mock(async () =>
          Result.ok({
            body: bytes.buffer,
            headers: new Headers(),
            ok: true,
            status: 200,
          }),
        ),
        invoke: mock(async ({ args }) => {
          invocations.push(args);
          return args["capability"] === "uploads.create"
            ? ({
                status: "ok",
                payload: {
                  headers: { "content-type": "application/octet-stream" },
                  uploadId: "upload_123",
                  url: "https://storage.example/upload",
                },
              } satisfies { status: "ok"; payload: unknown })
            : ({
                status: "ok",
                payload: {
                  finalizedResult: {
                    type: "entity_version",
                    entityVersionId: "version_123",
                  },
                },
              } satisfies { status: "ok"; payload: unknown });
        }),
        put: mock(async () => Result.ok(new Response(null, { status: 200 }))),
      },
    });

    expect(result).toMatchObject({
      egress: "structured",
      payload: {
        finalizedResult: {
          type: "entity_version",
          entityVersionId: "version_123",
        },
      },
    });
    expect(invocations.map((args) => args["capability"])).toEqual([
      "uploads.create",
      "uploads.update",
    ]);
    expect(invocations.at(0)).toMatchObject({
      input: {
        body: {
          purpose: "entity_version",
          sha256Hex: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
        },
      },
    });
  });

  test("aborts the canonical reservation when the storage PUT fails", async () => {
    const capabilities: string[] = [];
    const aborted = mock(async () => ({
      status: "ok" as const,
      payload: { aborted: true },
    }));
    const result = await uploadRemoteDocumentVersion({
      context: createContext(),
      entityId: "00000000-0000-4000-8000-000000000010",
      file: {
        download_url: "https://files.example/agreement.docx",
        file_id: "file_123",
      },
      workspaceId: "00000000-0000-4000-8000-000000000001",
      dependencies: {
        abort: aborted,
        captureCleanupFailure: mock(() => undefined),
        download: mock(async () =>
          Result.ok({
            body: new TextEncoder().encode("bytes").buffer,
            headers: new Headers(),
            ok: true,
            status: 200,
          }),
        ),
        invoke: mock(async ({ args }) => {
          capabilities.push(String(args["capability"]));
          return {
            status: "ok",
            payload: {
              headers: {},
              uploadId: "upload_123",
              url: "https://storage.example/upload",
            },
          } satisfies { status: "ok"; payload: unknown };
        }),
        put: mock(async () => Result.ok(new Response(null, { status: 500 }))),
      },
    });

    expect(capabilities).toEqual(["uploads.create"]);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "error" });
  });

  test("reports a failed reservation cleanup without hiding the transfer failure", async () => {
    const captureCleanupFailure = mock(
      (_error: unknown, _context?: Record<string, string>) => undefined,
    );
    const result = await uploadRemoteDocumentVersion({
      context: createContext(),
      entityId: "00000000-0000-4000-8000-000000000010",
      file: {
        download_url: "https://files.example/agreement.docx",
        file_id: "file_123",
      },
      workspaceId: "00000000-0000-4000-8000-000000000001",
      dependencies: {
        abort: mock(async () => ({
          status: "error" as const,
          result: errorResult("abort failed"),
        })),
        captureCleanupFailure,
        download: mock(async () =>
          Result.ok({
            body: new TextEncoder().encode("bytes").buffer,
            headers: new Headers(),
            ok: true,
            status: 200,
          }),
        ),
        invoke: mock(async () => ({
          status: "ok" as const,
          payload: {
            headers: {},
            uploadId: "upload_123",
            url: "https://storage.example/upload",
          },
        })),
        put: mock(async () => Result.ok(new Response(null, { status: 500 }))),
      },
    });

    expect(result).toMatchObject({
      status: "error",
      error: {
        message: expect.stringContaining(
          "could not be transferred, and its reserved upload could not be cleaned up",
        ),
      },
    });
    expect(captureCleanupFailure).toHaveBeenCalledTimes(1);
    expect(captureCleanupFailure).toHaveBeenCalledWith(expect.any(Error), {
      source: "mcp_document_upload",
      uploadId: "upload_123",
      workspaceId: "00000000-0000-4000-8000-000000000001",
    });
  });

  test("abandons a malformed reservation when the upload id is recoverable", async () => {
    const aborted = mock(async () => ({
      status: "ok" as const,
      payload: { aborted: true },
    }));
    const result = await uploadRemoteDocumentVersion({
      context: createContext(),
      entityId: "00000000-0000-4000-8000-000000000010",
      file: {
        download_url: "https://files.example/agreement.docx",
        file_id: "file_123",
      },
      workspaceId: "00000000-0000-4000-8000-000000000001",
      dependencies: {
        abort: aborted,
        captureCleanupFailure: mock(() => undefined),
        download: mock(async () =>
          Result.ok({
            body: new TextEncoder().encode("bytes").buffer,
            headers: new Headers(),
            ok: true,
            status: 200,
          }),
        ),
        invoke: mock(async () => ({
          status: "ok" as const,
          payload: { uploadId: "upload_123" },
        })),
        put: mock(async () => Result.ok(new Response(null, { status: 200 }))),
      },
    });

    expect(aborted).toHaveBeenCalledWith({
      context: expect.any(Object),
      uploadId: "upload_123",
      workspaceId: "00000000-0000-4000-8000-000000000001",
    });
    expect(result).toMatchObject({ status: "error" });
  });
});
