import { panic, Result, TaggedError } from "better-result";

import { FILE_COMPARISON_TRANSPORT } from "@stll/api-contract";
import { fetchWithTimeout } from "@stll/fetch";

import { hashUploadFile } from "../file-content-hash";
import { formatAppError, LocalizedAppError } from "../shared/app-error";
import { createViewportApp, parseAppToolPayload } from "../shared/bridge";
import { mountFilePicker } from "../shared/file-picker";
import { mountAppViewport } from "../shared/size";

const UPLOAD_TIMEOUT_MS = 1_800_000;

class ComparisonAppError extends TaggedError("ComparisonAppError")<{
  message: string;
}> {}

const comparisonError = (message: string): ComparisonAppError =>
  new ComparisonAppError({ message });

/** Carry a wrapped exception's message on into the panel's own error type. */
const wrapped = ({ message }: { message: string }): ComparisonAppError =>
  comparisonError(message);

const picker = mountFilePicker();
const t = picker.translate;
const applyHostContext = picker.applyHostContext;
const uploadButton = document.querySelector<HTMLButtonElement>("#upload");
if (!uploadButton) {
  panic("File comparison app markup is incomplete");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const setStatus = picker.setStatus;

const refreshUploadEnabled = (): void => {
  picker.setUploadEnabled(
    Boolean(picker.getFile("base") && picker.getFile("target")),
  );
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
): Result<PreparedUpload, ComparisonAppError | LocalizedAppError> => {
  if (!isRecord(value)) {
    return Result.err(
      new LocalizedAppError({ key: "invalidComparisonReservation" }),
    );
  }
  const { headers, url } = value;
  if (typeof url !== "string" || !isRecord(headers)) {
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
  isRecord(value) &&
  value["type"] === "uploads" &&
  typeof value["base_upload_id"] === "string" &&
  typeof value["target_upload_id"] === "string";

const parseReservation = (
  value: unknown,
): Result<ComparisonReservation, ComparisonAppError | LocalizedAppError> => {
  if (!isRecord(value)) {
    return Result.err(
      new LocalizedAppError({ key: "invalidComparisonReservation" }),
    );
  }
  const { base, next, target } = value;
  if (!isRecord(next)) {
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

const app = createViewportApp("stella file comparison");

const prepareComparison = async (
  base: File,
  target: File,
): Promise<
  Result<ComparisonReservation, ComparisonAppError | LocalizedAppError>
> => {
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
      message !== undefined
        ? comparisonError(message)
        : new LocalizedAppError({
            key: "capabilityFailed",
            values: { capability: FILE_COMPARISON_TRANSPORT.prepareToolName },
          }),
    );
  }
  const payload = parseAppToolPayload(result);
  return parseReservation(
    isRecord(payload) && "result" in payload ? payload["result"] : payload,
  );
};

const putFile = async (
  upload: PreparedUpload,
  file: File,
): Promise<Result<void, ComparisonAppError | LocalizedAppError>> => {
  const response = await Result.tryPromise(
    async () =>
      await fetchWithTimeout(upload.url, {
        method: "PUT",
        headers: upload.headers,
        body: file,
        timeoutMs: UPLOAD_TIMEOUT_MS,
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

type HandoffOutcome = "delivered" | "unsupported";

/**
 * The bytes are in storage; only the model can run the redline. A host that
 * takes a message gets one, a host that only takes context gets the
 * reservation as context, and a host with neither leaves the ask to the user.
 */
const handOffToModel = async (
  next: ComparisonReservation["next"],
  text: string,
): Promise<Result<HandoffOutcome, ComparisonAppError>> => {
  const capabilities = app.getHostCapabilities();
  if (capabilities?.message) {
    const sent = await Result.tryPromise(
      async () =>
        await app.sendMessage({
          role: "user",
          content: [{ type: "text", text }],
        }),
    );
    return Result.isError(sent)
      ? Result.err(wrapped(sent.error))
      : Result.ok("delivered");
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

const uploadSelectedFiles = async (): Promise<void> => {
  const base = picker.getFile("base");
  const target = picker.getFile("target");
  if (!base || !target) {
    return;
  }
  picker.setActivity("uploading");
  setStatus(() => t("preparingUpload"), "idle");
  const reservation = await prepareComparison(base, target);
  if (Result.isError(reservation)) {
    setStatus(
      () => formatAppError(reservation.error, t, "uploadFailed"),
      "error",
    );
    refreshUploadEnabled();
    return;
  }

  setStatus(() => t("uploading"), "idle");
  const puts = await Promise.all([
    putFile(reservation.value.base, base),
    putFile(reservation.value.target, target),
  ]);
  for (const put of puts) {
    if (Result.isError(put)) {
      setStatus(() => formatAppError(put.error, t, "uploadFailed"), "error");
      refreshUploadEnabled();
      return;
    }
  }

  picker.clearFiles();
  refreshUploadEnabled();

  const { next } = reservation.value;
  // The bytes are already staged, so a failed handoff still has to leave the
  // user able to ask for the redline themselves.
  const ask = () => t("askRedline", { source: JSON.stringify(next.source) });
  const outcome = await handOffToModel(
    next,
    t("redlineHandoff", {
      tool: FILE_COMPARISON_TRANSPORT.compareToolName,
      source: JSON.stringify(next.source),
    }),
  );
  if (Result.isError(outcome)) {
    setStatus(
      () =>
        t("redlineStartFailed", {
          message: formatAppError(outcome.error, t, "uploadFailed"),
          ask: ask(),
        }),
      "error",
    );
    return;
  }
  setStatus(
    () =>
      outcome.value === "delivered"
        ? t("redlineNext")
        : t("redlineAsk", { ask: ask() }),
    "success",
  );
};

app.addEventListener("hostcontextchanged", applyHostContext);

picker.onFilesChanged(() => {
  refreshUploadEnabled();
  setStatus(() => "", "idle");
});

uploadButton.addEventListener("click", () => {
  uploadSelectedFiles()
    .finally(() => {
      picker.setActivity("idle");
      refreshUploadEnabled();
    })
    .catch((error: unknown) => {
      setStatus(() => formatAppError(error, t, "uploadFailed"), "error");
    });
});

await app.connect();
const stopViewport = mountAppViewport({
  app,
  onFailure: () => setStatus(() => t("bridgeUnavailable"), "error"),
});
app.onteardown = () => {
  stopViewport();
  return {};
};
const initialContext = app.getHostContext();
if (initialContext) {
  applyHostContext(initialContext);
}
