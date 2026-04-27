const MAX_INSERTED_IMAGE_BYTES = 10 * 1024 * 1024;

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/bmp",
  "image/webp",
  "image/tiff",
]);

export function isAllowedImageMimeType(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.has(mimeType);
}

export async function isSafeImageFile(file: File): Promise<boolean> {
  if (file.size <= 0 || file.size > MAX_INSERTED_IMAGE_BYTES) {
    return false;
  }

  if (!isAllowedImageMimeType(file.type)) {
    return false;
  }

  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  return matchesImageSignature(header, file.type);
}

function matchesImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  switch (mimeType) {
    case "image/png":
      return (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
      );
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8;
    case "image/gif":
      return (
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38
      );
    case "image/bmp":
      return bytes[0] === 0x42 && bytes[1] === 0x4d;
    case "image/webp":
      return (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    case "image/tiff":
      return (
        (bytes[0] === 0x49 &&
          bytes[1] === 0x49 &&
          (bytes[2] === 0x2a || bytes[2] === 0x2b) &&
          bytes[3] === 0x00) ||
        (bytes[0] === 0x4d &&
          bytes[1] === 0x4d &&
          bytes[2] === 0x00 &&
          (bytes[3] === 0x2a || bytes[3] === 0x2b))
      );
    default:
      return false;
  }
}
