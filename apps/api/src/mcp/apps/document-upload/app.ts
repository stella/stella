import { App } from "@modelcontextprotocol/ext-apps";
import { panic, TaggedError } from "better-result";

import {
  buildDocumentVersionUploadReservationInput,
  buildUploadAbortInput,
  buildUploadFinalizeInput,
  DOCUMENT_VERSION_UPLOAD_TRANSPORT,
} from "@stll/api-contract";
import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";
import { fetchWithTimeout } from "@stll/fetch";

import { hashUploadFile } from "../file-content-hash";
import { formatAppError, LocalizedAppError } from "../shared/app-error";
import { parseAppToolPayload } from "../shared/bridge";
import { mountFilePicker } from "../shared/file-picker";
import { createUploadTargetController } from "./upload-target";

const UPLOAD_TIMEOUT_MS = 1_800_000;

class UploadAppError extends TaggedError("UploadAppError")<{
  message: string;
}> {}

const picker = mountFilePicker();
const t = picker.translate;
const applyHostContext = picker.applyHostContext;
const uploadButton = document.querySelector<HTMLButtonElement>("#upload");
if (!uploadButton) {
  panic("Document upload app markup is incomplete");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const targetController = createUploadTargetController({
  hasSelectedFile: () => Boolean(picker.getFile("file")),
  setDocumentId: (label) => {
    picker.setCaption(() => t("documentTarget", { documentId: label }));
  },
  setUploadEnabled: picker.setUploadEnabled,
});

const setStatus = picker.setStatus;

const callCapability = async (
  app: App,
  capability: string,
  input: Record<string, unknown>,
  confirm?: true,
): Promise<unknown> => {
  const result = await app.callServerTool({
    name: MCP_CAPABILITY_EXECUTORS.write,
    arguments: {
      capability,
      input,
      ...(confirm === true ? { confirm: true } : {}),
    },
  });
  if (result.isError === true) {
    const message = result.content.find((part) => part.type === "text")?.text;
    throw message === undefined
      ? new LocalizedAppError({
          key: "capabilityFailed",
          values: { capability },
        })
      : new UploadAppError({ message });
  }
  const payload = parseAppToolPayload(result);
  return isRecord(payload) && "result" in payload ? payload["result"] : payload;
};

const parseReservation = (
  value: unknown,
): { headers: Record<string, string>; uploadId: string; url: string } => {
  if (!isRecord(value)) {
    throw new LocalizedAppError({ key: "invalidUploadReservation" });
  }
  const { headers, uploadId, url } = value;
  if (
    typeof uploadId !== "string" ||
    typeof url !== "string" ||
    !isRecord(headers)
  ) {
    throw new LocalizedAppError({ key: "invalidUploadReservation" });
  }
  const headerEntries: [string, string][] = [];
  for (const [key, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== "string") {
      throw new LocalizedAppError({ key: "invalidUploadHeaders" });
    }
    headerEntries.push([key, headerValue]);
  }
  return {
    headers: Object.fromEntries(headerEntries),
    uploadId,
    url,
  };
};

const app = new App({ name: "stella document upload", version: "1.0.0" });

app.addEventListener("hostcontextchanged", applyHostContext);
app.addEventListener("toolinput", ({ arguments: toolArguments }) => {
  const { entity_id: entityId } = toolArguments ?? {};
  targetController.handleToolInput(entityId);
});
app.addEventListener("toolresult", (result) =>
  targetController.handleToolResult(result.structuredContent),
);

picker.onFilesChanged(() => {
  targetController.handleFileChange();
  setStatus(() => "", "idle");
});

const uploadSelectedFile = async (): Promise<void> => {
  const file = picker.getFile("file");
  const uploadTarget = targetController.snapshot();
  if (!file || !uploadTarget) {
    return;
  }
  picker.setActivity("uploading");
  setStatus(() => t("preparingUpload"), "idle");
  let uploadId: string | undefined;
  try {
    const reservation = parseReservation(
      await callCapability(
        app,
        DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.reserve,
        buildDocumentVersionUploadReservationInput({
          entityId: uploadTarget.entityId,
          file: {
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            sha256Hex: await hashUploadFile(file),
          },
          workspaceId: uploadTarget.workspaceId,
        }),
      ),
    );
    uploadId = reservation.uploadId;
    setStatus(() => t("uploading"), "idle");
    const put = await fetchWithTimeout(reservation.url, {
      method: "PUT",
      headers: reservation.headers,
      body: file,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    if (!put.ok) {
      throw new LocalizedAppError({
        key: "storageRejected",
        values: { status: put.status },
      });
    }

    setStatus(() => t("scanningSaving"), "idle");
    await callCapability(
      app,
      DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.finalize,
      buildUploadFinalizeInput({
        uploadId,
        workspaceId: uploadTarget.workspaceId,
      }),
    );
    uploadId = undefined;
    picker.clearFiles();
    setStatus(() => t("versionUploaded"), "success");
  } catch (error) {
    let message = () => formatAppError(error, t, "uploadFailed");
    if (uploadId !== undefined) {
      try {
        await callCapability(
          app,
          DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.abort,
          buildUploadAbortInput({
            uploadId,
            workspaceId: uploadTarget.workspaceId,
          }),
          true,
        );
      } catch (cleanupError) {
        message = () =>
          t("uploadCleanupFailed", {
            message: formatAppError(error, t, "uploadFailed"),
            cleanupMessage: formatAppError(cleanupError, t, "cleanupFailed"),
          });
      }
    }
    setStatus(message, "error");
    targetController.handleFileChange();
  }
};

uploadButton.addEventListener("click", () => {
  uploadSelectedFile()
    .finally(() => {
      picker.setActivity("idle");
      targetController.handleFileChange();
    })
    .catch((error: unknown) => {
      setStatus(() => formatAppError(error, t, "uploadFailed"), "error");
    });
});

await app.connect();
const initialContext = app.getHostContext();
if (initialContext) {
  applyHostContext(initialContext);
}
