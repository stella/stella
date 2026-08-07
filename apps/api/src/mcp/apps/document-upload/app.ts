import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

import {
  buildDocumentVersionUploadReservationInput,
  buildUploadAbortInput,
  buildUploadFinalizeInput,
  DOCUMENT_VERSION_UPLOAD_TRANSPORT,
} from "@stll/api-contract";
import { fetchWithTimeout } from "@stll/fetch";

import "./style.css";

const UPLOAD_TIMEOUT_MS = 1_800_000;

class UploadAppError extends Error {
  override readonly name = "UploadAppError";
}

const fileInput = document.querySelector<HTMLInputElement>("#file");
const uploadButton = document.querySelector<HTMLButtonElement>("#upload");
const statusElement = document.querySelector<HTMLElement>("#status");
const targetElement = document.querySelector<HTMLElement>("#target");
if (!fileInput || !uploadButton || !statusElement || !targetElement) {
  throw new TypeError("Document upload app markup is incomplete");
}

type UploadTarget = { entityId: string; workspaceId: string };
let target: UploadTarget | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseTarget = (value: unknown): UploadTarget | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { entityId, workspaceId } = value;
  if (typeof entityId !== "string" || typeof workspaceId !== "string") {
    return undefined;
  }
  return {
    entityId,
    workspaceId,
  };
};

type AppToolResult = Awaited<ReturnType<App["callServerTool"]>>;

const parsePayload = (result: AppToolResult): unknown => {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const text = result.content.find((part) => part.type === "text")?.text;
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const setTarget = (value: unknown): void => {
  const next = parseTarget(value);
  if (!next) {
    return;
  }
  target = next;
  targetElement.textContent = `Document ${next.entityId}`;
  uploadButton.disabled = fileInput.files?.item(0) === null;
};

const setStatus = (message: string, state: "idle" | "error" | "success") => {
  statusElement.textContent = message;
  statusElement.className = `status-${state}`;
};

const sha256Hex = async (file: File): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const callCapability = async (
  app: App,
  capability: string,
  input: Record<string, unknown>,
  confirm?: true,
): Promise<unknown> => {
  const result = await app.callServerTool({
    name: "invoke_capability",
    arguments: {
      capability,
      input,
      ...(confirm === true ? { confirm: true } : {}),
    },
  });
  if (result.isError === true) {
    const message = result.content.find((part) => part.type === "text")?.text;
    throw new UploadAppError(message ?? `Capability ${capability} failed`);
  }
  return parsePayload(result);
};

const parseReservation = (
  value: unknown,
): { headers: Record<string, string>; uploadId: string; url: string } => {
  if (!isRecord(value)) {
    throw new TypeError("stella returned an invalid upload reservation");
  }
  const { headers, uploadId, url } = value;
  if (
    typeof uploadId !== "string" ||
    typeof url !== "string" ||
    !isRecord(headers)
  ) {
    throw new TypeError("stella returned an invalid upload reservation");
  }
  const headerEntries: [string, string][] = [];
  for (const [key, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== "string") {
      throw new TypeError("stella returned invalid upload headers");
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

const applyHostContext = (context: ReturnType<App["getHostContext"]>) => {
  if (!context) {
    return;
  }
  if (context.theme) {
    applyDocumentTheme(context.theme);
  }
  if (context.styles?.variables) {
    applyHostStyleVariables(context.styles.variables);
  }
  if (context.styles?.css?.fonts) {
    applyHostFonts(context.styles.css.fonts);
  }
};
app.addEventListener("hostcontextchanged", applyHostContext);
app.addEventListener("toolinput", ({ arguments: toolArguments }) => {
  const { entity_id: entityId } = toolArguments ?? {};
  if (typeof entityId === "string") {
    targetElement.textContent = `Document ${entityId}`;
  }
});
app.addEventListener("toolresult", (result) =>
  setTarget(result.structuredContent),
);

fileInput.addEventListener("change", () => {
  uploadButton.disabled =
    target === undefined || fileInput.files?.item(0) === null;
  setStatus("", "idle");
});

const uploadSelectedFile = async (): Promise<void> => {
  const file = fileInput.files?.item(0);
  if (!file || !target) {
    return;
  }
  uploadButton.disabled = true;
  setStatus("Preparing upload…", "idle");
  let uploadId: string | undefined;
  try {
    const reservation = parseReservation(
      await callCapability(
        app,
        DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.reserve,
        buildDocumentVersionUploadReservationInput({
          entityId: target.entityId,
          file: {
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            sha256Hex: await sha256Hex(file),
          },
          workspaceId: target.workspaceId,
        }),
      ),
    );
    uploadId = reservation.uploadId;
    setStatus("Uploading…", "idle");
    const put = await fetchWithTimeout(reservation.url, {
      method: "PUT",
      headers: reservation.headers,
      body: file,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    if (!put.ok) {
      throw new UploadAppError(
        `Storage rejected the upload (HTTP ${put.status})`,
      );
    }

    setStatus("Scanning and saving…", "idle");
    await callCapability(
      app,
      DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.finalize,
      buildUploadFinalizeInput({ uploadId, workspaceId: target.workspaceId }),
    );
    uploadId = undefined;
    fileInput.value = "";
    setStatus("New version uploaded.", "success");
  } catch (error) {
    if (uploadId !== undefined) {
      await callCapability(
        app,
        DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.abort,
        buildUploadAbortInput({ uploadId, workspaceId: target.workspaceId }),
        true,
      ).catch(() => undefined);
    }
    setStatus(
      error instanceof Error ? error.message : "Upload failed",
      "error",
    );
    uploadButton.disabled = false;
  }
};

uploadButton.addEventListener("click", () => {
  uploadSelectedFile().catch((error: unknown) => {
    setStatus(
      error instanceof Error ? error.message : "Upload failed",
      "error",
    );
  });
});

await app.connect();
const initialContext = app.getHostContext();
if (initialContext) {
  applyHostContext(initialContext);
}
