import { PDF, PdfArray, PdfName, PdfNumber } from "@libpdf/core";

import { ClientOperationError } from "@/lib/errors/client";

import type {
  NormalizedCrop,
  PagePlanEntry,
  PageTransformRequest,
  PageTransformSource,
} from "./page-editor-protocol";

const applyCrop = (
  page: ReturnType<PDF["getPages"]>[number],
  crop: NormalizedCrop,
) => {
  const sourceBox = page.getCropBox();
  // LibPDF currently exposes the upper-right coordinates through Rectangle's
  // `width`/`height` fields. Subtract the lower-left origin so non-zero
  // CropBox origins crop to the intended fraction too. Base the new crop on
  // the source CropBox, matching the visible page the user adjusted.
  const sourceWidth = sourceBox.width - sourceBox.x;
  const sourceHeight = sourceBox.height - sourceBox.y;
  const x = sourceBox.x + sourceWidth * crop.x;
  const y = sourceBox.y + sourceHeight * crop.y;
  const width = sourceWidth * crop.width;
  const height = sourceHeight * crop.height;
  page.dict.set(
    PdfName.of("CropBox"),
    PdfArray.of(
      PdfNumber.of(x),
      PdfNumber.of(y),
      PdfNumber.of(x + width),
      PdfNumber.of(y + height),
    ),
  );
};

const sourceMap = (sources: readonly PageTransformSource[]) =>
  new Map(sources.map((source) => [source.id, source]));

const transformError = (message: string) =>
  new ClientOperationError({ action: "transform-pdf-pages", message });

const loadSources = async (
  sources: readonly PageTransformSource[],
  loaded: Map<string, PDF>,
  index = 0,
): Promise<void> => {
  const source = sources.at(index);
  if (!source) {
    return;
  }
  loaded.set(source.id, await PDF.load(new Uint8Array(source.bytes)));
  await loadSources(sources, loaded, index + 1);
};

const copyOutputPages = async (
  output: PDF,
  outputPageIds: readonly string[],
  pageById: ReadonlyMap<string, PagePlanEntry>,
  loaded: ReadonlyMap<string, PDF>,
  index = 0,
): Promise<void> => {
  const pageId = outputPageIds.at(index);
  if (pageId === undefined) {
    return;
  }
  const plan = pageById.get(pageId);
  if (!plan) {
    throw transformError("Output references an unknown page");
  }
  const source = loaded.get(plan.sourceId);
  if (!source || plan.sourcePageIndex >= source.getPageCount()) {
    throw transformError("Page index is outside the source document");
  }
  const [page] = await output.copyPagesFrom(source, [plan.sourcePageIndex], {
    includeAnnotations: true,
  });
  if (!page) {
    throw transformError("Failed to copy source page");
  }
  page.setRotation(plan.rotation);
  if (plan.crop) {
    applyCrop(page, plan.crop);
  }
  await copyOutputPages(output, outputPageIds, pageById, loaded, index + 1);
};

const saveOutputs = async (
  outputPageIds: readonly (readonly string[])[],
  pageById: ReadonlyMap<string, PagePlanEntry>,
  loaded: ReadonlyMap<string, PDF>,
  result: Uint8Array[],
  index = 0,
): Promise<void> => {
  const pageIds = outputPageIds.at(index);
  if (!pageIds) {
    return;
  }
  const output = PDF.create();
  await copyOutputPages(output, pageIds, pageById, loaded);
  result.push(await output.save({ compressStreams: true }));
  await saveOutputs(outputPageIds, pageById, loaded, result, index + 1);
};

export const transformPagePlan = async ({
  sources,
  pages,
  outputs,
}: Pick<PageTransformRequest, "sources" | "pages" | "outputs">): Promise<
  Uint8Array[]
> => {
  const byId = sourceMap(sources);
  const loaded = new Map<string, PDF>();
  await loadSources(sources, loaded);
  const pageById = new Map<string, PagePlanEntry>();
  for (const page of pages) {
    if (pageById.has(page.id)) {
      throw transformError("Duplicate page identifier");
    }
    if (!byId.has(page.sourceId)) {
      throw transformError("Page references an unknown source");
    }
    pageById.set(page.id, page);
  }

  const result: Uint8Array[] = [];
  await saveOutputs(outputs, pageById, loaded, result);
  return result;
};
