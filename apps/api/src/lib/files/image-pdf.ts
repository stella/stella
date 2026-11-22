import type { PdfRef } from "@libpdf/core";
import {
  ops,
  PDF,
  PdfDict,
  PDFImage,
  PdfName,
  PdfNumber,
  PdfStream,
} from "@libpdf/core";
import { panic } from "better-result";
import { deflateSync } from "node:zlib";

import type {
  ImageHeader,
  ImageOrientation,
} from "@/api/lib/files/image-header";
import { saveCreatedPdf } from "@/api/lib/files/pdf-signatures";

/** Image formats embedded into a PDF directly, without a converter. */
const EMBEDDABLE_IMAGE_MIME_TYPES = {
  "image/jpeg": null,
  "image/png": null,
} as const satisfies Record<string, null>;

export type EmbeddableImageMimeType = keyof typeof EMBEDDABLE_IMAGE_MIME_TYPES;

export const isEmbeddableImageMimeType = (
  mimeType: string,
): mimeType is EmbeddableImageMimeType =>
  Object.hasOwn(EMBEDDABLE_IMAGE_MIME_TYPES, mimeType);

/** PNG colour types the embedder decodes: grey, RGB, palette, grey+alpha, RGBA. */
const EMBEDDABLE_PNG_COLOR_TYPES: ReadonlySet<number> = new Set([
  0, 2, 3, 4, 6,
]);
/** Baseline, extended sequential and progressive Huffman JPEG frames. */
const EMBEDDABLE_JPEG_FRAMES: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2]);
/** Grey and YCbCr/RGB; four-component (CMYK, often Adobe-inverted) is not. */
const EMBEDDABLE_JPEG_COMPONENTS: ReadonlySet<number> = new Set([1, 3]);

/**
 * Whether the in-process embedder handles this encoding. It decodes only
 * non-interlaced 8-bit PNG (including 8-bit palette), and stores JPEG data
 * as-is under a colour space it derives from the component count, so only
 * 8-bit grey or colour Huffman JPEGs render correctly. Everything else goes
 * to the converter.
 */
export const canEmbedInProcess = (header: ImageHeader): boolean => {
  const { encoding } = header;
  if (encoding === undefined) {
    return false;
  }
  if (encoding.format === "png") {
    return (
      !encoding.interlaced &&
      encoding.bitDepth === 8 &&
      EMBEDDABLE_PNG_COLOR_TYPES.has(encoding.colorType)
    );
  }
  return (
    EMBEDDABLE_JPEG_FRAMES.has(encoding.frameMarker) &&
    encoding.precision === 8 &&
    EMBEDDABLE_JPEG_COMPONENTS.has(encoding.components)
  );
};

/**
 * One image pixel in PDF points. Pages are sized as a browser would print the
 * image at CSS resolution (96 px per inch), so a preview keeps the physical
 * size users saw before.
 */
const POINTS_PER_PIXEL = 72 / 96;

type Matrix = readonly [number, number, number, number, number, number];

/**
 * Maps the image's unit square onto a page so the stored pixels appear as
 * EXIF `orientation` says they should be displayed. `width`/`height` are the
 * stored image's size in points; orientations 5-8 swap the page's sides.
 */
const orientationMatrix = (
  orientation: ImageOrientation,
  width: number,
  height: number,
): Matrix => {
  switch (orientation) {
    case 1: {
      return [width, 0, 0, height, 0, 0];
    }
    case 2: {
      return [-width, 0, 0, height, width, 0];
    }
    case 3: {
      return [-width, 0, 0, -height, width, height];
    }
    case 4: {
      return [width, 0, 0, -height, 0, height];
    }
    case 5: {
      return [0, -width, -height, 0, height, width];
    }
    case 6: {
      return [0, -width, height, 0, 0, width];
    }
    case 7: {
      return [0, width, height, 0, 0, 0];
    }
    case 8: {
      return [0, width, -height, 0, height, 0];
    }
    default: {
      orientation satisfies never;
      return panic(`Unknown image orientation: ${String(orientation)}`);
    }
  }
};

/**
 * One page's image: encoded JPEG or PNG bytes the embedder takes as they
 * are, or decoded 8-bit RGBA pixels (a TIFF page) written as a Flate image.
 */
export type ImagePage =
  | {
      kind: "encoded";
      mimeType: EmbeddableImageMimeType;
      bytes: Uint8Array;
      orientation: ImageOrientation;
    }
  | {
      kind: "rgba";
      width: number;
      height: number;
      /** `width * height * 4` bytes, rows top to bottom. */
      rgba: Uint8Array;
      orientation: ImageOrientation;
    };

const RGBA_CHANNELS = 4;

/** Which channels of decoded pixels carry information. */
const pixelShape = (rgba: Uint8Array) => {
  let opaque = true;
  let grey = true;
  for (let offset = 0; offset < rgba.length; offset += RGBA_CHANNELS) {
    const red = rgba[offset];
    if (grey && (red !== rgba[offset + 1] || red !== rgba[offset + 2])) {
      grey = false;
    }
    if (opaque && rgba[offset + 3] !== 255) {
      opaque = false;
    }
    if (!grey && !opaque) {
      break;
    }
  }
  return { grey, opaque };
};

/** The listed channels of each RGBA pixel, packed. */
const pickChannels = (rgba: Uint8Array, channels: readonly number[]) => {
  const pixels = rgba.length / RGBA_CHANNELS;
  const out = new Uint8Array(pixels * channels.length);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    for (const [index, channel] of channels.entries()) {
      out[pixel * channels.length + index] =
        rgba[pixel * RGBA_CHANNELS + channel] ?? 0;
    }
  }
  return out;
};

const flateImage = (
  pdf: PDF,
  {
    colorSpace,
    height,
    samples,
    smask,
    width,
  }: {
    colorSpace: "DeviceGray" | "DeviceRGB";
    height: number;
    samples: Uint8Array;
    smask?: PdfRef;
    width: number;
  },
): PdfRef =>
  pdf.context.registry.register(
    new PdfStream(
      PdfDict.of({
        Type: PdfName.of("XObject"),
        Subtype: PdfName.of("Image"),
        Width: PdfNumber.of(width),
        Height: PdfNumber.of(height),
        ColorSpace: PdfName.of(colorSpace),
        BitsPerComponent: PdfNumber.of(8),
        Filter: PdfName.of("FlateDecode"),
        ...(smask === undefined ? {} : { SMask: smask }),
      }),
      deflateSync(samples),
    ),
  );

/**
 * Decoded pixels as an image XObject: grey when every pixel is, with a soft
 * mask only when some pixel is not opaque, so a scanned page costs one
 * channel and no mask.
 */
const embedRgba = (
  pdf: PDF,
  page: Extract<ImagePage, { kind: "rgba" }>,
): PDFImage => {
  const { height, rgba, width } = page;
  if (rgba.length !== width * height * RGBA_CHANNELS) {
    return panic("Decoded pixels do not match the declared size");
  }
  const { grey, opaque } = pixelShape(rgba);
  const smask = opaque
    ? undefined
    : flateImage(pdf, {
        colorSpace: "DeviceGray",
        height,
        samples: pickChannels(rgba, [3]),
        width,
      });
  const ref = flateImage(pdf, {
    colorSpace: grey ? "DeviceGray" : "DeviceRGB",
    height,
    samples: pickChannels(rgba, grey ? [0] : [0, 1, 2]),
    width,
    ...(smask === undefined ? {} : { smask }),
  });
  return new PDFImage(ref, width, height);
};

const embedPage = (pdf: PDF, page: ImagePage): PDFImage => {
  if (page.kind === "rgba") {
    return embedRgba(pdf, page);
  }
  return page.mimeType === "image/jpeg"
    ? pdf.embedJpeg(page.bytes)
    : pdf.embedPng(page.bytes);
};

/**
 * A PDF with one page per image, each page sized to its image as displayed.
 * JPEG data is stored as-is (DCTDecode), so a JPEG is never decoded; a PNG
 * is decoded once into its Flate stream, and decoded pixels are compressed
 * once. No browser, no base64, no rasterisation.
 */
export const imagePagesToPdf = async (
  pages: Iterable<ImagePage>,
): Promise<Uint8Array> => {
  const pdf = PDF.create();
  // Pages are taken one at a time: a lazily decoded source holds only the
  // page being embedded.
  for (const source of pages) {
    const image = embedPage(pdf, source);
    const width = image.width * POINTS_PER_PIXEL;
    const height = image.height * POINTS_PER_PIXEL;
    const swapsSides = source.orientation >= 5;
    const page = pdf.addPage({
      width: swapsSides ? height : width,
      height: swapsSides ? width : height,
    });
    const name = page.registerImage(image);
    const [a, b, c, d, e, f] = orientationMatrix(
      source.orientation,
      width,
      height,
    );
    page.drawOperators([
      ops.pushGraphicsState(),
      ops.concatMatrix(a, b, c, d, e, f),
      ops.paintXObject(name),
      ops.popGraphicsState(),
    ]);
  }
  if (pdf.getPageCount() === 0) {
    return panic("An image PDF needs at least one page");
  }
  return await saveCreatedPdf(pdf);
};

/** A one-page PDF showing an embeddable JPEG or PNG at its own size. */
export const imageToPdf = async ({
  bytes,
  header,
  mimeType,
}: {
  bytes: Uint8Array;
  header: ImageHeader;
  mimeType: EmbeddableImageMimeType;
}): Promise<Uint8Array> =>
  await imagePagesToPdf([
    { kind: "encoded", mimeType, bytes, orientation: header.orientation },
  ]);
