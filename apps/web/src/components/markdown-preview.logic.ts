const SAFE_DATA_IMAGE_SRC_RE =
  /^data:image\/(?:png|jpe?g|gif|webp|bmp|tiff);base64,/iu;

export const isSafeMarkdownPreviewImageSrc = (src: unknown): src is string =>
  typeof src === "string" && SAFE_DATA_IMAGE_SRC_RE.test(src);
