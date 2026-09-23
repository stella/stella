import { userFileIdFromUrl } from "@stll/api-contract";

import { apiUrl } from "@/lib/api-url";

export const getUserFileContentUrl = (url: string): string | null => {
  const fileId = userFileIdFromUrl(url);
  if (fileId === null) {
    return null;
  }

  return apiUrl(`/user-files/${fileId}/content`);
};

export const getUserFileThumbnailUrl = (url: string): string | null => {
  const fileId = userFileIdFromUrl(url);
  if (fileId === null) {
    return null;
  }

  return apiUrl(`/user-files/${fileId}/thumbnail`);
};
