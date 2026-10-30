import { App } from "@modelcontextprotocol/ext-apps";
import { Result, TaggedError } from "better-result";

import { FILE_COMPARISON_TRANSPORT } from "@stll/api-contract";
import { fetchWithTimeout } from "@stll/fetch";

import { hashUploadFile } from "../file-content-hash";
import { formatAppError, LocalizedAppError } from "../shared/app-error";
import { applyUploadHostStyles, parseAppToolPayload } from "../shared/bridge";
import { appLocale, setAppDocumentLocale } from "../shared/locale";
import {
  bindUploadSdkErrors,
  connectUploadApp,
  createUploadSubscriptions,
  createUploadTranslator,
  isUploadRecord,
} from "../shared/upload-bridge";

const UPLOAD_TIMEOUT_MS = 1_800_000;

class ComparisonAppError extends TaggedError("ComparisonAppError")<{
  message: string;
}> {}

type ComparisonError = ComparisonAppError | LocalizedAppError;

const comparisonError = (message: string): ComparisonAppError =>
  new ComparisonAppError({ message });

/** Carry a wrapped exception's message on into the panel's own error type. */
const wrapped = ({ message }: { message: string }): ComparisonAppError =>
  comparisonError(message);

type UploadSnapshot = {
  base: File | null;
  target: File | null;
  uploadPhase: "idle" | "active";
  message: string;
  status: "idle" | "error" | "success";
  locale: ReturnType<typeof appLocale>;
};

type ComparisonFileInput = { name: string; size: number; sha256_hex: string };

/** The URL is signed against these exact bytes, so the digest is read here. */
const describeFile = async (
  file: File,
): Promise<Result<ComparisonFileInput, ComparisonAppError>> => {
  const digest = await Result.tryPromise(
    async () => await hashUploadFile(file),
  );
  if (Result.isError(digest)) {
    return Result.err(wrapped(digest.error));
  }
  return Result.ok({
    name: file.name,
    size: file.size,
    sha256_hex: digest.value,
  });
};

type PreparedUpload = { headers: Record<string, string>; url: string };

type ComparisonSource = {
  type: "uploads";
  base_upload_id: string;
  target_upload_id: string;
};

/** The reserved PUT targets plus the next call, echoed back to the model. */
type ComparisonReservation = {
  base: PreparedUpload;
  next: { [key: string]: unknown; source: ComparisonSource };
  target: PreparedUpload;
};

const parsePreparedUpload = (
  value: unknown,
): Result<PreparedUpload, ComparisonError> => {
  if (!isUploadRecord(value)) {
    return Result.err(
      new LocalizedAppError({ key: "invalidComparisonReservation" }),
    );
  }
  const { headers, url } = value;
  if (typeof url !== "string" || !isUploadRecord(headers)) {
    return Result.err(
      new LocalizedAppError({ key: "invalidComparisonReservation" }),
    );
  }
  const headerEntries: [string, string][] = [];
  for (const [key, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== "string") {
      return Result.err(new LocalizedAppError({ key: "invalidUploadHeaders" }));
    }
    headerEntries.push([key, headerValue]);
  }
  return Result.ok({ headers: Object.fromEntries(headerEntries), url });
};

const isComparisonSource = (value: unknown): value is ComparisonSource =>
  isUploadRecord(value) &&
  value["type"] === "uploads" &&
  typeof value["base_upload_id"] === "string" &&
  typeof value["target_upload_id"] === "string";

const parseReservation = (
  value: unknown,
): Result<ComparisonReservation, ComparisonError> => {
  if (!isUploadRecord(value)) {
    return Result.err(
      new LocalizedAppError({ key: "invalidComparisonReservation" }),
    );
  }
  const { base, next, target } = value;
  if (!isUploadRecord(next)) {
    return Result.err(
      new LocalizedAppError({ key: "invalidComparisonReservation" }),
    );
  }
  const { source } = next;
  if (!isComparisonSource(source)) {
    return Result.err(
      new LocalizedAppError({ key: "invalidComparisonReservation" }),
    );
  }
  const parsedBase = parsePreparedUpload(base);
  if (Result.isError(parsedBase)) {
    return Result.err(parsedBase.error);
  }
  const parsedTarget = parsePreparedUpload(target);
  if (Result.isError(parsedTarget)) {
    return Result.err(parsedTarget.error);
  }
  return Result.ok({
    base: parsedBase.value,
    next: { ...next, source },
    target: parsedTarget.value,
  });
};

type HandoffOutcome = "delivered" | "unsupported";

/**
 * The bytes are in storage; only the model can run the redline. A host that
 * takes a message gets one, a host that only takes context gets the
 * reservation as context, and a host with neither leaves the ask to the user.
 */
type HandOffOptions = {
  app: App;
  next: ComparisonReservation["next"];
  text: string;
};
const handOffToModel = async ({
  app,
  next,
  text,
}: HandOffOptions): Promise<Result<HandoffOutcome, ComparisonError>> => {
  const capabilities = app.getHostCapabilities();
  if (capabilities?.message) {
    const sent = await Result.tryPromise(
      async () =>
        await app.sendMessage({
          role: "user",
          content: [{ type: "text", text }],
        }),
    );
    if (Result.isError(sent)) {
      return Result.err(wrapped(sent.error));
    }
    if (sent.value.isError === true) {
      return Result.err(
        new LocalizedAppError({
          key: "capabilityFailed",
          values: { capability: FILE_COMPARISON_TRANSPORT.compareToolName },
        }),
      );
    }
    return Result.ok("delivered");
  }
  if (capabilities?.updateModelContext) {
    const updated = await Result.tryPromise(
      async () =>
        await app.updateModelContext({
          content: [{ type: "text", text }],
          structuredContent: next,
        }),
    );
    return Result.isError(updated)
      ? Result.err(wrapped(updated.error))
      : Result.ok("delivered");
  }
  return Result.ok("unsupported");
};

type PutFileOptions = { upload: PreparedUpload; file: File };
const putFile = async ({
  upload,
  file,
}: PutFileOptions): Promise<Result<void, ComparisonError>> => {
  const response = await Result.tryPromise(
    async () =>
      await fetchWithTimeout(upload.url, {
        method: "PUT",
        headers: upload.headers,
        body: file,
        timeout: { type: "headers", ms: UPLOAD_TIMEOUT_MS },
      }),
  );
  if (Result.isError(response)) {
    return Result.err(wrapped(response.error));
  }
  if (!response.value.ok) {
    return Result.err(
      new LocalizedAppError({
        key: "storageRejected",
        values: { status: response.value.status },
      }),
    );
  }
  return Result.ok();
};

export const createFileComparisonRuntime = (
  app = new App({ name: "stella file comparison", version: "1.0.0" }),
) => {
  let locale = appLocale(undefined);
  const t = createUploadTranslator(() => locale);
  const { notify, subscribe } = createUploadSubscriptions();
  let snapshot: UploadSnapshot = {
    base: null,
    target: null,
    uploadPhase: "idle",
    message: "",
    status: "idle",
    locale,
  };
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    notify();
  };
  let statusMessage = () => "";
  const setStatus = (
    message: () => string,
    state: "idle" | "error" | "success",
  ) => {
    statusMessage = message;
    publish({ message: statusMessage(), status: state });
  };

  const prepareComparison = async (
    base: File,
    target: File,
  ): Promise<Result<ComparisonReservation, ComparisonError>> => {
    const [baseFile, targetFile] = await Promise.all([
      describeFile(base),
      describeFile(target),
    ]);
    if (Result.isError(baseFile)) {
      return Result.err(baseFile.error);
    }
    if (Result.isError(targetFile)) {
      return Result.err(targetFile.error);
    }
    const called = await Result.tryPromise(
      async () =>
        await app.callServerTool({
          name: FILE_COMPARISON_TRANSPORT.prepareToolName,
          arguments: { base: baseFile.value, target: targetFile.value },
        }),
    );
    if (Result.isError(called)) {
      return Result.err(wrapped(called.error));
    }
    const result = called.value;
    if (result.isError === true) {
      const message = result.content.find((part) => part.type === "text")?.text;
      return Result.err(
        message === undefined
          ? new LocalizedAppError({
              key: "capabilityFailed",
              values: { capability: FILE_COMPARISON_TRANSPORT.prepareToolName },
            })
          : comparisonError(message),
      );
    }
    const payload = parseAppToolPayload(result);
    return parseReservation(
      isUploadRecord(payload) && "result" in payload
        ? payload["result"]
        : payload,
    );
  };

  const uploadSelectedFiles = async (): Promise<void> => {
    const base = snapshot.base;
    const target = snapshot.target;
    if (!base || !target) {
      return;
    }
    publish({ uploadPhase: "active" });
    setStatus(() => t("preparingUpload"), "idle");
    const reservation = await prepareComparison(base, target);
    if (Result.isError(reservation)) {
      setStatus(
        () => formatAppError(reservation.error, t, "uploadFailed"),
        "error",
      );
      return;
    }

    setStatus(() => t("uploading"), "idle");
    const puts = await Promise.all([
      putFile({ upload: reservation.value.base, file: base }),
      putFile({ upload: reservation.value.target, file: target }),
    ]);
    for (const put of puts) {
      if (Result.isError(put)) {
        setStatus(() => formatAppError(put.error, t, "uploadFailed"), "error");
        return;
      }
    }

    publish({ base: null });
    publish({ target: null });

    const { next } = reservation.value;
    // The bytes are already staged, so a failed handoff still has to leave the
    // user able to ask for the redline themselves.
    const outcome = await handOffToModel({
      app,
      next,
      text: t("redlineHandoff", {
        tool: FILE_COMPARISON_TRANSPORT.compareToolName,
        source: JSON.stringify(next.source),
      }),
    });
    if (Result.isError(outcome)) {
      setStatus(
        () =>
          t("redlineStartFailed", {
            message: formatAppError(outcome.error, t, "uploadFailed"),
            ask: t("askRedline", { source: JSON.stringify(next.source) }),
          }),
        "error",
      );
      return;
    }
    setStatus(
      () =>
        outcome.value === "delivered"
          ? t("redlineNext")
          : t("redlineAsk", {
              ask: t("askRedline", { source: JSON.stringify(next.source) }),
            }),
      "success",
    );
  };

  const applyHostContext = (context: ReturnType<App["getHostContext"]>) => {
    locale = appLocale(context?.locale);
    setAppDocumentLocale(context?.locale, t("comparisonTitle"));
    publish({ locale, message: statusMessage() });
    applyUploadHostStyles(context);
  };
  app.addEventListener("hostcontextchanged", applyHostContext);

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
    selectBase: (base: File) => {
      if (snapshot.uploadPhase === "active") {
        return;
      }
      publish({ base });
      setStatus(() => "", "idle");
    },
    selectTarget: (target: File) => {
      if (snapshot.uploadPhase === "active") {
        return;
      }
      publish({ target });
      setStatus(() => "", "idle");
    },
    upload: async () => {
      if (snapshot.uploadPhase === "active") {
        return;
      }
      const uploaded = await Result.tryPromise(uploadSelectedFiles);
      if (Result.isError(uploaded)) {
        setStatus(
          () => formatAppError(uploaded.error, t, "uploadFailed"),
          "error",
        );
      }
      publish({ uploadPhase: "idle" });
    },
    connect: async () =>
      await connectUploadApp({
        app,
        onContext: applyHostContext,
        onError: (message) => setStatus(() => message, "error"),
      }),
  };
};
