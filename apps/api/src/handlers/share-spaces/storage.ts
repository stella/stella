import { getFileExtension } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";

type ShareItemStorageKeyOptions = {
  organizationId: SafeId<"organization">;
  shareSpaceId: SafeId<"shareSpace">;
  shareItemId: SafeId<"shareItem">;
  mimeType: string;
};

const shareItemPrefix = ({
  organizationId,
  shareSpaceId,
  shareItemId,
}: Omit<ShareItemStorageKeyOptions, "mimeType">): string =>
  `organizations/${organizationId}/share-spaces/${shareSpaceId}/items/${shareItemId}`;

export const createShareOriginalStorageKey = (
  options: ShareItemStorageKeyOptions,
): string =>
  `${shareItemPrefix(options)}/original.${getFileExtension(options.mimeType)}`;

export const createShareDisplayStorageKey = (
  options: ShareItemStorageKeyOptions,
): string =>
  `${shareItemPrefix(options)}/display.${getFileExtension(options.mimeType)}`;

export const createShareThumbnailStorageKey = (
  options: Omit<ShareItemStorageKeyOptions, "mimeType">,
): string => `${shareItemPrefix(options)}/thumbnail.webp`;
