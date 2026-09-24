import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { panic, Result, TaggedError } from "better-result";

import { FILE_COMPARISON_TRANSPORT } from "@stll/api-contract";
import { fetchWithTimeout } from "@stll/fetch";

import "../style.css";

const UPLOAD_TIMEOUT_MS = 1_800_000;
const INVALID_RESERVATION = "stella returned an invalid comparison reservation";

class ComparisonAppError extends TaggedError("ComparisonAppError")<{
  message: string;
}> {}

const comparisonError = (message: string): ComparisonAppError =>
  new ComparisonAppError({ message });

/** Carry a wrapped exception's message on into the panel's own error type. */
const wrapped = ({ message }: { message: string }): ComparisonAppError =>
  comparisonError(message);

const baseInput = document.querySelector<HTMLInputElement>("#base");
const targetInput = document.querySelector<HTMLInputElement>("#target");
const uploadButton = document.querySelector<HTMLButtonElement>("#upload");
const statusElement = document.querySelector<HTMLElement>("#status");
if (!baseInput || !targetInput || !uploadButton || !statusElement) {
  panic("File comparison app markup is incomplete");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type AppToolResult = Awaited<ReturnType<App["callServerTool"]>>;

const parsePayload = (result: AppToolResult): unknown => {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const text = result.content.find((part) => part.type === "text")?.text;
  if (text === undefined) {
    return undefined;
  }
  const parsed = Result.try((): unknown => JSON.parse(text));
  return Result.isError(parsed) ? undefined : parsed.value;
};

const setStatus = (message: string, state: "idle" | "error" | "success") => {
  statusElement.textContent = message;
  statusElement.className = `status-${state}`;
};

const refreshUploadEnabled = (): void => {
  uploadButton.disabled = !(
    baseInput.files?.item(0) && targetInput.files?.item(0)
  );
};

type ComparisonFileInput = { name: string; size: number; sha256_hex: string };

/** The URL is signed against these exact bytes, so the digest is read here. */
const describeFile = async (
  file: File,
): Promise<Result<ComparisonFileInput, ComparisonAppError>> => {
  const digest = await Result.tryPromise(
    async () => await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
  );
  if (Result.isError(digest)) {
    return Result.err(wrapped(digest.error));
  }
  return Result.ok({
    name: file.name,
    size: file.size,
    sha256_hex: Array.from(new Uint8Array(digest.value), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
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
): Result<PreparedUpload, ComparisonAppError> => {
  if (!isRecord(value)) {
    return Result.err(comparisonError(INVALID_RESERVATION));
  }
  const { headers, url } = value;
  if (typeof url !== "string" || !isRecord(headers)) {
    return Result.err(comparisonError(INVALID_RESERVATION));
  }
  const headerEntries: [string, string][] = [];
  for (const [key, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== "string") {
      return Result.err(
        comparisonError("stella returned invalid upload headers"),
      );
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
): Result<ComparisonReservation, ComparisonAppError> => {
  if (!isRecord(value)) {
    return Result.err(comparisonError(INVALID_RESERVATION));
  }
  const { base, next, target } = value;
  if (!isRecord(next)) {
    return Result.err(comparisonError(INVALID_RESERVATION));
  }
  const { source } = next;
  if (!isComparisonSource(source)) {
    return Result.err(comparisonError(INVALID_RESERVATION));
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

const app = new App({ name: "stella file comparison", version: "1.0.0" });

const prepareComparison = async (
  base: File,
  target: File,
): Promise<Result<ComparisonReservation, ComparisonAppError>> => {
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
      comparisonError(
        message ?? `${FILE_COMPARISON_TRANSPORT.prepareToolName} failed`,
      ),
    );
  }
  const payload = parsePayload(result);
  return parseReservation(
    isRecord(payload) && "result" in payload ? payload["result"] : payload,
  );
};

const putFile = async (
  upload: PreparedUpload,
  file: File,
): Promise<Result<void, ComparisonAppError>> => {
  const response = await Result.tryPromise(
    async () =>
      // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- browser upload to the presigned URL Stella's upload reservation returned
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
      comparisonError(
        `Storage rejected the upload (HTTP ${response.value.status})`,
      ),
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
  const base = baseInput.files?.item(0);
  const target = targetInput.files?.item(0);
  if (!base || !target) {
    return;
  }
  uploadButton.disabled = true;
  setStatus("Preparing upload…", "idle");
  const reservation = await prepareComparison(base, target);
  if (Result.isError(reservation)) {
    setStatus(reservation.error.message, "error");
    refreshUploadEnabled();
    return;
  }

  setStatus("Uploading…", "idle");
  const puts = await Promise.all([
    putFile(reservation.value.base, base),
    putFile(reservation.value.target, target),
  ]);
  for (const put of puts) {
    if (Result.isError(put)) {
      setStatus(put.error.message, "error");
      refreshUploadEnabled();
      return;
    }
  }

  baseInput.value = "";
  targetInput.value = "";
  refreshUploadEnabled();

  const { next } = reservation.value;
  // The bytes are already staged, so a failed handoff still has to leave the
  // user able to ask for the redline themselves.
  const ask = `Ask for the redline with source ${JSON.stringify(next.source)}.`;
  const outcome = await handOffToModel(
    next,
    `Both files are uploaded. Call ${FILE_COMPARISON_TRANSPORT.compareToolName} with source ${JSON.stringify(next.source)}.`,
  );
  if (Result.isError(outcome)) {
    setStatus(
      `Uploaded, but stella could not start the redline: ${outcome.error.message} ${ask}`,
      "error",
    );
    return;
  }
  setStatus(
    outcome.value === "delivered"
      ? "Uploaded. The redline runs next."
      : `Uploaded. ${ask}`,
    "success",
  );
};

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

for (const input of [baseInput, targetInput]) {
  input.addEventListener("change", () => {
    refreshUploadEnabled();
    setStatus("", "idle");
  });
}

uploadButton.addEventListener("click", () => {
  uploadSelectedFiles().catch((error: unknown) => {
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
