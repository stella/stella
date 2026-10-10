import { App } from "@modelcontextprotocol/ext-apps";
import { Result, TaggedError } from "better-result";

import {
  buildDocumentVersionUploadReservationInput,
  buildUploadAbortInput,
  buildUploadFinalizeInput,
  DOCUMENT_VERSION_UPLOAD_TRANSPORT,
} from "@stll/api-contract";
import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";
import { fetchWithTimeout } from "@stll/fetch";

import { hashUploadFile } from "../file-content-hash";
import { applyUploadHostStyles } from "../shared/bridge";
import { appLocale, setAppDocumentLocale } from "../shared/locale";
import {
  isUploadRecord,
  parseUploadToolPayload,
  createUploadTranslator,
  connectUploadApp,
  createUploadSubscriptions,
  bindUploadSdkErrors,
} from "../shared/upload-bridge";
import { createUploadTargetController } from "./upload-target";
import type { UploadTarget } from "./upload-target";

const UPLOAD_TIMEOUT_MS = 1_800_000;

class UploadAppError extends TaggedError("UploadAppError")<{
  message: string;
}> {}

type UploadSnapshot = {
  file: File | null;
  uploadTarget: UploadTarget | null;
  uploadPhase: "idle" | "active";
  targetLabel: string;
  message: string;
  status: "idle" | "error" | "success";
  locale: ReturnType<typeof appLocale>;
};

type AppTranslator = (
  key: keyof ReturnType<typeof appLocale>["messages"],
  values?: Record<string, string | number>,
) => string;
type UploadSelectedFileOptions = {
  app: App;
  getSnapshot: () => UploadSnapshot;
  targetController: ReturnType<typeof createUploadTargetController>;
  publish: (patch: Partial<UploadSnapshot>) => void;
  setStatus: (message: string, status: UploadSnapshot["status"]) => void;
  t: AppTranslator;
  callCapability: (
    app: App,
    capability: string,
    input: Record<string, unknown>,
    confirm?: true,
  ) => Promise<Result<unknown, UploadAppError>>;
  parseReservation: (value: unknown) => Result<
    {
      headers: Record<string, string>;
      uploadId: string;
      url: string;
    },
    UploadAppError
  >;
};
const uploadSelectedFile = async ({
  app,
  getSnapshot,
  targetController,
  publish,
  setStatus,
  t,
  callCapability,
  parseReservation,
}: UploadSelectedFileOptions): Promise<void> => {
  const file = getSnapshot().file;
  const uploadTarget = targetController.snapshot();
  if (!file || !uploadTarget) {
    return;
  }
  publish({ uploadPhase: "active" });
  setStatus(t("preparingUpload"), "idle");
  let uploadId: string | undefined;
  const attempted = await Result.tryPromise(async () => {
    const reserved = await callCapability(
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
    );
    if (Result.isError(reserved)) {
      return Result.err(reserved.error);
    }
    const parsed = parseReservation(reserved.value);
    if (Result.isError(parsed)) {
      return Result.err(parsed.error);
    }
    const reservation = parsed.value;
    uploadId = reservation.uploadId;
    setStatus(t("uploading"), "idle");
    const put = await fetchWithTimeout(reservation.url, {
      method: "PUT",
      headers: reservation.headers,
      body: file,
      timeout: { type: "headers", ms: UPLOAD_TIMEOUT_MS },
    });
    if (!put.ok) {
      return Result.err(
        new UploadAppError({
          message: t("storageRejected", { status: put.status }),
        }),
      );
    }

    setStatus(t("savingUpload"), "idle");
    const finalized = await callCapability(
      app,
      DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.finalize,
      buildUploadFinalizeInput({
        uploadId,
        workspaceId: uploadTarget.workspaceId,
      }),
    );
    if (Result.isError(finalized)) {
      return Result.err(finalized.error);
    }
    uploadId = undefined;
    publish({ file: null });
    setStatus(t("uploadComplete"), "success");
    return Result.ok();
  });
  const uploaded = Result.isError(attempted)
    ? Result.err(new UploadAppError({ message: attempted.error.message }))
    : attempted.value;
  if (Result.isError(uploaded)) {
    let message = uploaded.error.message;
    if (uploadId !== undefined) {
      const failedUploadId = uploadId;
      const cleanup = await callCapability(
        app,
        DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.abort,
        buildUploadAbortInput({
          uploadId: failedUploadId,
          workspaceId: uploadTarget.workspaceId,
        }),
        true,
      );
      if (Result.isError(cleanup)) {
        const cleanupMessage = cleanup.error.message;
        message = t("cleanupAlsoFailed", { message, cleanupMessage });
      }
    }
    setStatus(message, "error");
  }
};

export const createDocumentUploadRuntime = (
  app = new App({ name: "stella document upload", version: "1.0.0" }),
) => {
  let locale = appLocale(undefined);
  const t = createUploadTranslator(() => locale);
  const { notify, subscribe } = createUploadSubscriptions();
  let snapshot: UploadSnapshot = {
    file: null,
    uploadTarget: null,
    uploadPhase: "idle",
    targetLabel: t("connecting"),
    message: "",
    status: "idle",
    locale,
  };
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    notify();
  };
  const targetController = createUploadTargetController({
    formatLabel: (documentId) => t("documentTarget", { documentId }),
    setLabel: (label) => {
      publish({ targetLabel: label });
    },
    setTarget: (uploadTarget) => {
      publish({ uploadTarget });
    },
  });

  const setStatus = (message: string, state: "idle" | "error" | "success") => {
    publish({ message, status: state });
  };

  const callCapability = async (
    protocol: App,
    capability: string,
    input: Record<string, unknown>,
    confirm?: true,
  ): Promise<Result<unknown, UploadAppError>> => {
    const called = await Result.tryPromise(
      async () =>
        await protocol.callServerTool({
          name: MCP_CAPABILITY_EXECUTORS.write,
          arguments: {
            capability,
            input,
            ...(confirm === true ? { confirm: true } : {}),
          },
        }),
    );
    if (Result.isError(called)) {
      return Result.err(new UploadAppError({ message: called.error.message }));
    }
    const result = called.value;
    if (result.isError === true) {
      const message = result.content.find((part) => part.type === "text")?.text;
      return Result.err(
        new UploadAppError({
          message: message ?? t("capabilityFailed"),
        }),
      );
    }
    const payload = parseUploadToolPayload(result);
    return Result.ok(
      isUploadRecord(payload) && "result" in payload
        ? payload["result"]
        : payload,
    );
  };

  const parseReservation = (
    value: unknown,
  ): Result<
    { headers: Record<string, string>; uploadId: string; url: string },
    UploadAppError
  > => {
    if (!isUploadRecord(value)) {
      return Result.err(
        new UploadAppError({
          message: t("invalidUploadReservation"),
        }),
      );
    }
    const { headers, uploadId, url } = value;
    if (
      typeof uploadId !== "string" ||
      typeof url !== "string" ||
      !isUploadRecord(headers)
    ) {
      return Result.err(
        new UploadAppError({
          message: t("invalidUploadReservation"),
        }),
      );
    }
    const headerEntries: [string, string][] = [];
    for (const [key, headerValue] of Object.entries(headers)) {
      if (typeof headerValue !== "string") {
        return Result.err(
          new UploadAppError({
            message: t("invalidUploadHeaders"),
          }),
        );
      }
      headerEntries.push([key, headerValue]);
    }
    return Result.ok({
      headers: Object.fromEntries(headerEntries),
      uploadId,
      url,
    });
  };

  const applyHostContext = (context: ReturnType<App["getHostContext"]>) => {
    locale = appLocale(context?.locale);
    setAppDocumentLocale(context?.locale, t("uploadTitle"));
    publish({ locale });
    const target = targetController.snapshot();
    publish({
      targetLabel: target
        ? t("documentTarget", { documentId: target.entityId })
        : t("connecting"),
    });
    applyUploadHostStyles(context);
  };
  app.addEventListener("hostcontextchanged", applyHostContext);
  app.addEventListener("toolinput", ({ arguments: toolArguments }) => {
    const { entity_id: entityId } = toolArguments ?? {};
    targetController.handleToolInput(entityId);
  });
  app.addEventListener("toolresult", (result) =>
    targetController.handleToolResult(result.structuredContent),
  );

  const detached = bindUploadSdkErrors({
    app,
    getLabel: () => t("uploadFailed"),
    onError: (message) => setStatus(message, "error"),
  });
  applyHostContext(undefined);

  return {
    detached,
    subscribe,
    getSnapshot: () => snapshot,
    selectFile: (file: File) => {
      if (snapshot.uploadPhase === "active") {
        return;
      }
      publish({ file });
      setStatus("", "idle");
    },
    upload: async () => {
      if (snapshot.uploadPhase === "active") {
        return;
      }
      const uploaded = await Result.tryPromise(
        async () =>
          await uploadSelectedFile({
            app,
            getSnapshot: () => snapshot,
            targetController,
            publish,
            setStatus,
            t,
            callCapability,
            parseReservation,
          }),
      );
      if (Result.isError(uploaded)) {
        setStatus(uploaded.error.message, "error");
      }
      publish({ uploadPhase: "idle" });
    },
    connect: async () =>
      await connectUploadApp({
        app,
        onContext: applyHostContext,
        onError: (message) => setStatus(message, "error"),
      }),
  };
};
