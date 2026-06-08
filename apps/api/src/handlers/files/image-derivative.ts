import { Result, TaggedError } from "better-result";

/**
 * Image MIME types we generate WebP thumbnails + blur placeholders for.
 * Restricted to the formats Bun ships as statically-linked codecs so the
 * pipeline is byte-identical on Linux (prod) and macOS/Windows (dev). HEIC,
 * AVIF, and TIFF only decode on macOS/Windows and would reject on Linux, so
 * they are deliberately excluded (we also don't accept them on upload).
 */
const IMAGE_THUMBNAIL_MIME_TYPES = {
  "image/jpeg": null,
  "image/png": null,
  "image/gif": null,
  "image/webp": null,
} as const satisfies Record<string, null>;

export const isThumbnailableMimeType = (mimeType: string): boolean =>
  Object.hasOwn(IMAGE_THUMBNAIL_MIME_TYPES, mimeType);

type ShouldGenerateImageThumbnailOptions = {
  encrypted?: boolean;
  mimeType: string;
};

export const shouldGenerateImageThumbnail = ({
  encrypted = false,
  mimeType,
}: ShouldGenerateImageThumbnailOptions): boolean =>
  !encrypted && isThumbnailableMimeType(mimeType);

export const thumbnailDerivativeStateForFile = (
  options: ShouldGenerateImageThumbnailOptions,
) =>
  shouldGenerateImageThumbnail(options)
    ? ({ status: "pending" } as const)
    : ({ status: "not-required" } as const);

/** Longest edge of the generated thumbnail, in pixels. */
const THUMBNAIL_MAX_EDGE = 512;
/** WebP quality for the generated thumbnail (1-100). */
const THUMBNAIL_WEBP_QUALITY = 80;

export const THUMBNAIL_MIME_TYPE = "image/webp";

export class ImageDerivativeError extends TaggedError("ImageDerivativeError")<{
  message: string;
  code?: string | undefined;
}>() {}

type ImageThumbnailResult = {
  /** Encoded WebP thumbnail bytes, longest edge <= THUMBNAIL_MAX_EDGE. */
  webp: Uint8Array;
  /**
   * ThumbHash-rendered `data:image/png;base64,...` blur of the source image
   * (~400-700 bytes). Drops straight into an `<img src>`; no client decoder.
   */
  placeholder: string;
};

/**
 * Decode an uploaded image and produce a bounded WebP thumbnail plus a blur
 * placeholder via the built-in `Bun.Image` pipeline. The source bytes are
 * never mutated; this only reads them.
 *
 * Forces `Bun.Image.backend = "bun"` (static-codec mode) so output matches the
 * Linux build and unsupported formats reject the same way in dev and prod.
 */
export const generateImageThumbnail = async (
  source: Uint8Array,
): Promise<Result<ImageThumbnailResult, ImageDerivativeError>> => {
  Bun.Image.backend = "bun";

  return await Result.tryPromise({
    try: async () => {
      const image = new Bun.Image(source);
      const webp = await image
        .resize(THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: THUMBNAIL_WEBP_QUALITY })
        .bytes();
      const placeholder = await image.placeholder();
      return { webp, placeholder } satisfies ImageThumbnailResult;
    },
    catch: (error) =>
      new ImageDerivativeError({
        message: "Failed to generate image thumbnail",
        code:
          error instanceof Error && "code" in error
            ? String(error.code)
            : undefined,
      }),
  });
};
