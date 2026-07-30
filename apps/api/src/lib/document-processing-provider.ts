import { Result, TaggedError } from "better-result";

import { env } from "@/api/env";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { LIMITS } from "@/api/lib/limits";
import { isRecord } from "@/api/lib/type-guards";

const OCR_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const OCR_MAX_PAGES = 500;
const OCR_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const PAGE_SEPARATOR = "\n\n\f\n\n";

export class DocumentOcrProviderError extends TaggedError(
  "DocumentOcrProviderError",
)<{
  code:
    | "not_configured"
    | "request_failed"
    | "invalid_response"
    | "response_too_large"
    | "page_limit_exceeded"
    | "empty_result";
  message: string;
  cause?: unknown;
  status?: number | undefined;
}>() {}

export type DocumentOcrResult = {
  pageCount: number;
  text: string;
  truncated: boolean;
};

export const createOcrRequestInit = ({
  idempotencyKey,
  sourceUrl,
  token,
}: {
  idempotencyKey: string;
  sourceUrl: string;
  token?: string | undefined;
}) => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  }

  return {
    method: "POST",
    headers,
    body: JSON.stringify({
      file: sourceUrl,
      fileType: 0,
      useDocOrientationClassify: false,
      useDocUnwarping: false,
      useTextlineOrientation: false,
      visualize: false,
    }),
    // The payload contains a presigned document URL. Following a provider
    // redirect could otherwise disclose it to an unvalidated HTTP endpoint.
    redirect: "error" as const,
    timeoutMs: OCR_REQUEST_TIMEOUT_MS,
  };
};

export const isSupportedOcrPageCount = (pageCount: number): boolean =>
  pageCount > 0 && pageCount <= OCR_MAX_PAGES;

export const readBoundedOcrJson = async (
  response: Response,
  maxBytes = OCR_MAX_RESPONSE_BYTES,
): Promise<unknown> => {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number.parseInt(contentLength, 10) > maxBytes) {
    throw new DocumentOcrProviderError({
      code: "response_too_large",
      message: "OCR service response exceeded the allowed size",
    });
  }
  if (!response.body) {
    throw new DocumentOcrProviderError({
      code: "invalid_response",
      message: "OCR service returned no response body",
    });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const readNextChunk = async (): Promise<void> => {
    const chunk = await reader.read();
    if (chunk.done) {
      return;
    }
    const value: unknown = chunk.value;
    if (!(value instanceof Uint8Array)) {
      throw new DocumentOcrProviderError({
        code: "invalid_response",
        message: "OCR service returned an invalid response body",
      });
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new DocumentOcrProviderError({
        code: "response_too_large",
        message: "OCR service response exceeded the allowed size",
      });
    }
    chunks.push(value);
    await readNextChunk();
  };
  await readNextChunk();

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return parsed;
};

const serviceUrl = (): string => {
  const configured = env.OCR_SERVICE_URL;
  if (!configured) {
    throw new DocumentOcrProviderError({
      code: "not_configured",
      message: "OCR_SERVICE_URL is required by the document processing worker",
    });
  }
  let end = configured.length;
  while (end > 0 && configured[end - 1] === "/") {
    end -= 1;
  }
  return `${configured.slice(0, end)}/ocr`;
};

export const isDocumentOcrProviderConfigured = (): boolean =>
  env.OCR_SERVICE_URL !== undefined;

const parsePageText = (value: unknown): string | null => {
  if (!isRecord(value)) {
    return null;
  }

  const prunedResult = value["prunedResult"];
  if (!isRecord(prunedResult)) {
    return null;
  }

  const texts = prunedResult["rec_texts"];
  if (
    !Array.isArray(texts) ||
    !texts.every((text) => typeof text === "string")
  ) {
    return null;
  }

  return texts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join("\n");
};

export const parsePaddleOcrResponse = (
  value: unknown,
): DocumentOcrResult | null => {
  if (!isRecord(value) || value["errorCode"] !== 0) {
    return null;
  }

  const result = value["result"];
  if (!isRecord(result) || !Array.isArray(result["ocrResults"])) {
    return null;
  }

  const textParts: string[] = [];
  let accumulatedChars = 0;
  let pageCount = 0;
  let truncated = false;
  for (const page of result["ocrResults"]) {
    const pageText = parsePageText(page);
    if (pageText === null) {
      return null;
    }
    const part = pageCount === 0 ? pageText : `${PAGE_SEPARATOR}${pageText}`;
    pageCount += 1;
    const remainingChars = LIMITS.extractedContentMaxChars - accumulatedChars;
    if (remainingChars <= 0) {
      truncated ||= part.length > 0;
      continue;
    }
    textParts.push(part.slice(0, remainingChars));
    accumulatedChars += Math.min(part.length, remainingChars);
    truncated ||= part.length > remainingChars;
  }

  return {
    pageCount,
    text: textParts.join(""),
    truncated,
  };
};

export const recognizePdfText = async ({
  idempotencyKey,
  sourceUrl,
}: {
  idempotencyKey: string;
  sourceUrl: string;
}): Promise<Result<DocumentOcrResult, DocumentOcrProviderError>> =>
  await Result.tryPromise({
    try: async () => {
      const response = await fetchWithTimeout(
        serviceUrl(),
        createOcrRequestInit({
          idempotencyKey,
          sourceUrl,
          token: env.OCR_SERVICE_TOKEN,
        }),
      );

      if (!response.ok) {
        throw new DocumentOcrProviderError({
          code: "request_failed",
          message: `OCR service returned HTTP ${response.status}`,
          status: response.status,
        });
      }

      const parsed = parsePaddleOcrResponse(await readBoundedOcrJson(response));
      if (!parsed) {
        throw new DocumentOcrProviderError({
          code: "invalid_response",
          message: "OCR service returned an invalid response",
        });
      }
      if (!isSupportedOcrPageCount(parsed.pageCount)) {
        throw new DocumentOcrProviderError({
          code: "page_limit_exceeded",
          message: `OCR supports PDFs up to ${OCR_MAX_PAGES} pages`,
        });
      }
      if (parsed.text.trim().length === 0) {
        throw new DocumentOcrProviderError({
          code: "empty_result",
          message: "OCR service found no searchable text",
        });
      }

      return parsed;
    },
    catch: (cause) =>
      cause instanceof DocumentOcrProviderError
        ? cause
        : new DocumentOcrProviderError({
            code: "request_failed",
            message: "OCR service request failed",
            cause,
          }),
  });
