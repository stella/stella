import { Result, TaggedError } from "better-result";

import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import type {
  DocumentOcrLine,
  DocumentOcrPage,
  DocumentOcrPayload,
} from "@/api/lib/document-processing-contract";
import { serializeDocumentOcrPayload } from "@/api/lib/document-processing-contract";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { LIMITS } from "@/api/lib/limits";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const OCR_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const OCR_MAX_PAGES = 500;
const OCR_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const OCR_MAX_RESPONSE_CHUNKS = 16 * 1024;
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
}> {}

export type DocumentOcrResult = {
  pageCount: number;
  payload: DocumentOcrPayload;
  text: string;
  truncated: boolean;
};

export const createOcrRequestInit = ({
  idempotencyKey,
  signal,
  sourceUrl,
  token,
}: {
  idempotencyKey: string;
  signal: AbortSignal;
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
    signal,
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
  const bytes = new Uint8Array(maxBytes);
  let chunkCount = 0;
  let totalBytes = 0;
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- a response stream must be pulled sequentially; chunk and byte caps bound the loop
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) {
        throw new DocumentOcrProviderError({
          code: "invalid_response",
          message: "OCR service returned an invalid response body",
        });
      }
      chunkCount += 1;
      if (
        chunkCount > OCR_MAX_RESPONSE_CHUNKS ||
        value.byteLength > maxBytes - totalBytes
      ) {
        throw new DocumentOcrProviderError({
          code: "response_too_large",
          message: "OCR service response exceeded the allowed size",
        });
      }
      bytes.set(value, totalBytes);
      totalBytes += value.byteLength;
    }
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(bytes.subarray(0, totalBytes)),
    );
    return parsed;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
};

const serviceUrl = (): string => {
  const configured = envDocumentProcessingWorker.OCR_SERVICE_URL;
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
  envDocumentProcessingWorker.OCR_SERVICE_URL !== undefined;

type PaddlePage = {
  boxes: readonly (readonly [number, number, number, number])[];
  scores: readonly number[];
  texts: readonly string[];
};

const parseBox = (
  value: unknown,
  width: number,
  height: number,
): readonly [number, number, number, number] | null => {
  if (
    !isUnknownArray(value) ||
    value.length !== 4 ||
    !value.every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  ) {
    return null;
  }

  const [xMin, yMin, xMax, yMax] = value;
  if (
    typeof xMin !== "number" ||
    typeof yMin !== "number" ||
    typeof xMax !== "number" ||
    typeof yMax !== "number" ||
    xMin < 0 ||
    yMin < 0 ||
    xMax <= xMin ||
    yMax <= yMin ||
    xMax > width ||
    yMax > height
  ) {
    return null;
  }

  return [xMin, yMin, xMax, yMax];
};

const parsePage = (
  value: unknown,
  width: number,
  height: number,
): PaddlePage | null => {
  if (!isRecord(value)) {
    return null;
  }

  const prunedResult = value["prunedResult"];
  if (!isRecord(prunedResult)) {
    return null;
  }

  const texts = prunedResult["rec_texts"];
  const scores = prunedResult["rec_scores"];
  const boxes = prunedResult["rec_boxes"];
  if (
    !Array.isArray(texts) ||
    !texts.every((text) => typeof text === "string") ||
    !Array.isArray(scores) ||
    !scores.every(
      (score) =>
        typeof score === "number" &&
        Number.isFinite(score) &&
        score >= 0 &&
        score <= 1,
    ) ||
    !Array.isArray(boxes) ||
    texts.length !== scores.length ||
    texts.length !== boxes.length
  ) {
    return null;
  }

  const parsedBoxes = boxes.map((box) => parseBox(box, width, height));
  if (parsedBoxes.some((box) => box === null)) {
    return null;
  }

  return {
    boxes: parsedBoxes.filter(
      (box): box is readonly [number, number, number, number] => box !== null,
    ),
    scores,
    texts,
  };
};

const parsePageDimensions = (
  value: unknown,
  expectedPageCount: number,
): readonly { height: number; width: number }[] | null => {
  if (
    !isRecord(value) ||
    value["type"] !== "pdf" ||
    value["numPages"] !== expectedPageCount ||
    !Array.isArray(value["pages"]) ||
    value["pages"].length !== expectedPageCount
  ) {
    return null;
  }

  const dimensions: { height: number; width: number }[] = [];
  for (const page of value["pages"]) {
    if (!isRecord(page)) {
      return null;
    }
    const width = page["width"];
    const height = page["height"];
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return null;
    }
    dimensions.push({ width, height });
  }
  return dimensions;
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

  const dimensions = parsePageDimensions(
    result["dataInfo"],
    result["ocrResults"].length,
  );
  if (!dimensions) {
    return null;
  }

  const textParts: string[] = [];
  const pages: DocumentOcrPage[] = [];
  let accumulatedChars = 0;
  let pageCount = 0;
  let truncated = false;
  for (const pageValue of result["ocrResults"]) {
    const dimension = dimensions.at(pageCount);
    if (!dimension) {
      return null;
    }
    const page = parsePage(pageValue, dimension.width, dimension.height);
    if (!page) {
      return null;
    }

    const pagePrefix = pageCount === 0 ? "" : PAGE_SEPARATOR;
    const boundedPagePrefix = pagePrefix.slice(
      0,
      Math.max(0, LIMITS.extractedContentMaxChars - accumulatedChars),
    );
    textParts.push(boundedPagePrefix);
    accumulatedChars += boundedPagePrefix.length;
    truncated ||= boundedPagePrefix.length < pagePrefix.length;

    const lines: DocumentOcrLine[] = [];
    for (let lineIndex = 0; lineIndex < page.texts.length; lineIndex += 1) {
      const text = page.texts[lineIndex]?.trim();
      const box = page.boxes[lineIndex];
      const confidence = page.scores[lineIndex];
      if (!text || !box || confidence === undefined) {
        continue;
      }
      const separator = lines.length > 0 ? "\n" : "";
      lines.push({ box, confidence, text });
      const remainingChars = LIMITS.extractedContentMaxChars - accumulatedChars;
      if (remainingChars <= 0) {
        truncated = true;
        continue;
      }
      const segment = `${separator}${text}`;
      const boundedSegment = segment.slice(0, remainingChars);
      const boundedText = boundedSegment.slice(separator.length);
      if (boundedText.length === 0) {
        truncated = true;
        continue;
      }
      textParts.push(boundedSegment);
      accumulatedChars += boundedSegment.length;
      truncated ||= boundedText.length < text.length;
    }

    pageCount += 1;
    pages.push({ ...dimension, lines });
  }

  return {
    pageCount,
    payload: { pages, version: 1 },
    text: textParts.join(""),
    truncated,
  };
};

export const recognizePdfText = async ({
  idempotencyKey,
  signal,
  sourceUrl,
}: {
  idempotencyKey: string;
  signal: AbortSignal;
  sourceUrl: string;
}): Promise<Result<DocumentOcrResult, DocumentOcrProviderError>> =>
  await Result.tryPromise({
    try: async () => {
      const response = await fetchWithTimeout(
        serviceUrl(),
        createOcrRequestInit({
          idempotencyKey,
          signal,
          sourceUrl,
          token: envDocumentProcessingWorker.OCR_SERVICE_TOKEN,
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
      const payloadBytes = new TextEncoder().encode(
        serializeDocumentOcrPayload(parsed.payload),
      ).byteLength;
      if (payloadBytes > LIMITS.documentOcrPayloadMaxBytes) {
        throw new DocumentOcrProviderError({
          code: "response_too_large",
          message: "OCR page geometry exceeded the allowed size",
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
