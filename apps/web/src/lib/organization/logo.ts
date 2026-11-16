import { Result } from "better-result";

import { ORGANIZATION_LOGO_RULES } from "@stll/auth-model";

export const ORGANIZATION_LOGO_ACCEPT = "image/png,image/jpeg,image/webp";
const ORGANIZATION_LOGO_MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Fits a picked image into the square data URL stored as the organization
 * logo. Resolves to `null` for a file that is not a readable allowed image.
 */
export const toOrganizationLogo = async (
  file: File,
): Promise<string | null> => {
  if (
    !ORGANIZATION_LOGO_ACCEPT.split(",").includes(file.type) ||
    file.size > ORGANIZATION_LOGO_MAX_FILE_BYTES
  ) {
    return null;
  }
  const decoded = await Result.tryPromise(
    async () => await createImageBitmap(file),
  );
  if (Result.isError(decoded)) {
    return null;
  }
  const bitmap = decoded.value;
  const { edge } = ORGANIZATION_LOGO_RULES;
  const scale = edge / Math.max(bitmap.width, bitmap.height);
  const width = bitmap.width * scale;
  const height = bitmap.height * scale;
  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  const context = canvas.getContext("2d");
  if (!context) {
    // Without a 2D context the canvas stays blank; never save that as a logo.
    bitmap.close();
    return null;
  }
  context.drawImage(
    bitmap,
    (edge - width) / 2,
    (edge - height) / 2,
    width,
    height,
  );
  bitmap.close();
  // Safari has no WebP encoder and returns PNG, which the rules also allow.
  return canvas.toDataURL("image/webp");
};
