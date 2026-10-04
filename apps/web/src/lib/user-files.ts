import { userFileIdFromUrl } from "@stll/api-contract/user-file-url";

import { apiUrl } from "@/lib/api-url";

/** Where an uploaded chat file's bytes are served, by its id. */
export const userFileContentUrl = (fileId: string): string =>
  apiUrl(`/user-files/${fileId}/content`);

export const getUserFileContentUrl = (url: string): string | null => {
  const fileId = userFileIdFromUrl(url);
  if (fileId === null) {
    return null;
  }

  return userFileContentUrl(fileId);
};

export const getUserFileThumbnailUrl = (url: string): string | null => {
  const fileId = userFileIdFromUrl(url);
  if (fileId === null) {
    return null;
  }

  return apiUrl(`/user-files/${fileId}/thumbnail`);
};
