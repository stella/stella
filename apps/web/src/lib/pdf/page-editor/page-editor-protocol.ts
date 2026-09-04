type PageRotation = 0 | 90 | 180 | 270;

export type NormalizedCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PagePlanEntry = {
  id: string;
  sourceId: string;
  sourcePageIndex: number;
  rotation: PageRotation;
  crop?: NormalizedCrop;
};

export type PageTransformSource = { id: string; bytes: ArrayBuffer };

export type PageTransformRequest = {
  requestId: number;
  sources: readonly PageTransformSource[];
  pages: readonly PagePlanEntry[];
  outputs: readonly (readonly string[])[];
};

export type PageTransformResponse =
  | { requestId: number; status: "success"; outputs: ArrayBuffer[] }
  | { requestId: number; status: "error"; message: string };

export const MAX_PAGE_EDITOR_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_PAGE_EDITOR_SOURCES = 100;
export const MAX_PAGE_EDITOR_PAGES = 20_000;
const MAX_PAGE_EDITOR_OUTPUT_PAGE_REFS = 100_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isRotation = (value: unknown): value is PageRotation =>
  value === 0 || value === 90 || value === 180 || value === 270;

const isCrop = (value: unknown): value is NormalizedCrop =>
  isRecord(value) &&
  isFiniteNumber(value["x"]) &&
  isFiniteNumber(value["y"]) &&
  isFiniteNumber(value["width"]) &&
  isFiniteNumber(value["height"]) &&
  value["x"] >= 0 &&
  value["y"] >= 0 &&
  value["width"] > 0 &&
  value["height"] > 0 &&
  value["x"] + value["width"] <= 1 &&
  value["y"] + value["height"] <= 1;

const isPage = (value: unknown): value is PagePlanEntry =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["sourceId"] === "string" &&
  isFiniteNumber(value["sourcePageIndex"]) &&
  Number.isInteger(value["sourcePageIndex"]) &&
  value["sourcePageIndex"] >= 0 &&
  isRotation(value["rotation"]) &&
  (value["crop"] === undefined || isCrop(value["crop"]));

const isSourceArray = (
  value: unknown,
): value is readonly PageTransformSource[] =>
  Array.isArray(value) &&
  value.every(
    (source: unknown) =>
      isRecord(source) &&
      typeof source["id"] === "string" &&
      source["bytes"] instanceof ArrayBuffer,
  );

const isPageArray = (value: unknown): value is readonly PagePlanEntry[] =>
  Array.isArray(value) && value.every((page: unknown) => isPage(page));

const isOutputArray = (value: unknown): value is readonly string[][] =>
  Array.isArray(value) &&
  value.every(
    (output: unknown) =>
      Array.isArray(output) &&
      output.length > 0 &&
      output.every((pageId: unknown) => typeof pageId === "string"),
  );

export const isPageTransformRequest = (
  value: unknown,
): value is PageTransformRequest => {
  if (!isRecord(value) || !Number.isInteger(value["requestId"])) {
    return false;
  }
  const sources = value["sources"];
  const pages = value["pages"];
  const outputs = value["outputs"];
  if (
    !isSourceArray(sources) ||
    !isPageArray(pages) ||
    !isOutputArray(outputs) ||
    sources.length === 0 ||
    sources.length > MAX_PAGE_EDITOR_SOURCES ||
    pages.length === 0 ||
    pages.length > MAX_PAGE_EDITOR_PAGES ||
    outputs.length === 0
  ) {
    return false;
  }
  const totalSourceBytes = sources.reduce(
    (total, source) => total + source.bytes.byteLength,
    0,
  );
  if (totalSourceBytes > MAX_PAGE_EDITOR_SOURCE_BYTES) {
    return false;
  }
  const totalOutputPageRefs = outputs.reduce(
    (total, output) => total + output.length,
    0,
  );
  if (totalOutputPageRefs > MAX_PAGE_EDITOR_OUTPUT_PAGE_REFS) {
    return false;
  }
  return new Set(sources.map((source) => source.id)).size === sources.length;
};

export const isPageTransformResponseForRequest = (
  response: unknown,
  requestId: number,
): response is PageTransformResponse => {
  if (
    !isRecord(response) ||
    response["requestId"] !== requestId ||
    typeof response["status"] !== "string"
  ) {
    return false;
  }
  if (response["status"] === "error") {
    return typeof response["message"] === "string";
  }
  return (
    response["status"] === "success" &&
    Array.isArray(response["outputs"]) &&
    response["outputs"].every((output) => output instanceof ArrayBuffer)
  );
};
