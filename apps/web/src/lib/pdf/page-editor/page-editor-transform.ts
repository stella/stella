import {
  PDF,
  PdfArray,
  PDFImage,
  PdfName,
  PdfNumber,
  PdfStream,
} from "@libpdf/core";
import { panic } from "better-result";

import type { CleanedScanImage } from "@stll/scan-engine/types";

import { ClientOperationError } from "@/lib/errors/client";

import { type PageCleanScan, placeCleanScan } from "./clean-scan-placement";
import type {
  NormalizedCrop,
  PagePlanEntry,
  PageTransformRequest,
  PageTransformSource,
} from "./page-editor-protocol";

const applyCrop = (
  page: ReturnType<PDF["getPages"]>[number],
  crop: NormalizedCrop,
  rotation: PagePlanEntry["rotation"],
) => {
  const sourceCrop = (() => {
    switch (rotation) {
      case 0:
        return crop;
      case 90:
        return {
          x: 1 - crop.y - crop.height,
          y: crop.x,
          width: crop.height,
          height: crop.width,
        };
      case 180:
        return {
          x: 1 - crop.x - crop.width,
          y: 1 - crop.y - crop.height,
          width: crop.width,
          height: crop.height,
        };
      case 270:
        return {
          x: crop.y,
          y: 1 - crop.x - crop.width,
          width: crop.height,
          height: crop.width,
        };
      default: {
        rotation satisfies never;
        return panic(`Unhandled rotation: ${String(rotation)}`);
      }
    }
  })();
  const sourceBox = page.getCropBox();
  // LibPDF currently exposes the upper-right coordinates through Rectangle's
  // `width`/`height` fields. Subtract the lower-left origin so non-zero
  // CropBox origins crop to the intended fraction too. Base the new crop on
  // the source CropBox, matching the visible page the user adjusted.
  const sourceWidth = sourceBox.width - sourceBox.x;
  const sourceHeight = sourceBox.height - sourceBox.y;
  const x = sourceBox.x + sourceWidth * sourceCrop.x;
  const y = sourceBox.y + sourceHeight * sourceCrop.y;
  const width = sourceWidth * sourceCrop.width;
  const height = sourceHeight * sourceCrop.height;
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

/**
 * Binary scans hold only 0 and 255, so they pack to one bit per pixel; PDF
 * rows start on a byte boundary and a set bit is white in DeviceGray.
 */
const packBinaryRows = ({ height, pixels, width }: CleanedScanImage) => {
  const rowBytes = Math.ceil(width / 8);
  const packed = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    for (let column = 0; column < rowBytes; column += 1) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        const x = column * 8 + bit;
        const white = x < width && (pixels[y * width + x] ?? 0) >= 128;
        byte = byte * 2 + (white ? 1 : 0);
      }
      packed[y * rowBytes + column] = byte;
    }
  }
  return packed;
};

const embedCleanScanImage = (output: PDF, image: CleanedScanImage) => {
  const binary = image.format === "binary";
  const ref = output.register(
    PdfStream.fromDict(
      {
        Type: PdfName.of("XObject"),
        Subtype: PdfName.of("Image"),
        Width: PdfNumber.of(image.width),
        Height: PdfNumber.of(image.height),
        ColorSpace: PdfName.of("DeviceGray"),
        BitsPerComponent: PdfNumber.of(binary ? 1 : 8),
      },
      binary ? packBinaryRows(image) : image.pixels,
    ),
  );
  return new PDFImage(ref, image.width, image.height);
};

type AddCleanScanPageOptions = {
  /** Images already embedded in `output`; duplicated pages share one. */
  embedded: Map<CleanedScanImage, PDFImage>;
  output: PDF;
  rotation: PagePlanEntry["rotation"];
  scan: PageCleanScan;
};

const addCleanScanPage = ({
  embedded,
  output,
  rotation,
  scan,
}: AddCleanScanPageOptions) => {
  const placement = placeCleanScan(scan, rotation);
  const page = output.addPage({
    width: placement.box.widthPoints,
    height: placement.box.heightPoints,
    rotate: placement.box.rotation,
  });
  const image =
    embedded.get(scan.image) ?? embedCleanScanImage(output, scan.image);
  embedded.set(scan.image, image);
  page.drawImage(image, placement.image);
  return page;
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

type CopySourcePageOptions = {
  output: PDF;
  plan: PagePlanEntry;
  source: PDF;
};

const copySourcePage = async ({
  output,
  plan,
  source,
}: CopySourcePageOptions) => {
  const [page] = await output.copyPagesFrom(source, [plan.sourcePageIndex], {
    includeAnnotations: true,
  });
  if (!page) {
    throw transformError("Failed to copy source page");
  }
  page.setRotation(plan.rotation);
  return page;
};

type CopyOutputPagesOptions = {
  embedded: Map<CleanedScanImage, PDFImage>;
  loaded: ReadonlyMap<string, PDF>;
  output: PDF;
  outputPageIds: readonly string[];
  pageById: ReadonlyMap<string, PagePlanEntry>;
};

const copyOutputPages = async (
  { embedded, loaded, output, outputPageIds, pageById }: CopyOutputPagesOptions,
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
  const page = plan.scan
    ? addCleanScanPage({
        embedded,
        output,
        rotation: plan.rotation,
        scan: plan.scan,
      })
    : await copySourcePage({ output, plan, source });
  if (plan.crop) {
    applyCrop(page, plan.crop, plan.rotation);
  }
  await copyOutputPages(
    { embedded, loaded, output, outputPageIds, pageById },
    index + 1,
  );
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
  await copyOutputPages({
    embedded: new Map(),
    loaded,
    output,
    outputPageIds: pageIds,
    pageById,
  });
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
